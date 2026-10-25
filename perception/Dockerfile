# Perception, as one image that runs in both places it needs to.
#
# It takes no inbound connections. Perception dials out to the Engine over a
# single WebSocket, so there is no port to publish, no TLS to terminate and no
# ingress to configure - which is what makes "runs on a laptop" and "runs on a
# cloud VM" the same deployment rather than two.
#
# The weights are baked in at build time rather than fetched at boot. A
# container that downloads four gigabytes on every start is a container that
# fails on a flaky network, and on Nebius Serverless AI the container disk is
# deleted with the endpoint, so a runtime download would happen every time.
#
# CPU by default. Measured 217 ms per frame at 256 px and 561 ms at 384 px on
# four laptop threads, so one camera at the rate a gate needs is comfortable
# and a cheap CPU instance costs about a sixteenth of the smallest GPU. Build
# with BASE set to a CUDA image when the frame rate actually needs it.

ARG BASE=python:3.12-slim
FROM ${BASE}

# libGL and libglib are OpenCV's runtime deps. Not needed for the relay or
# folder sources, but a build that works for a local camera and then fails on
# a webcam is a worse trade than 40 MB.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TORCH_HOME=/opt/models/torch \
    HF_HOME=/opt/models/hf

WORKDIR /app

# Dependencies before source, so editing a .py does not re-resolve the wheels.
COPY pyproject.toml ./
RUN pip install --no-cache-dir "." \
    && pip install --no-cache-dir \
       torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir \
       "transformers>=4.49,<5" timm einops sentencepiece protobuf

COPY pact_perception ./pact_perception

# Pull the checkpoint and the SigLIP2 text tower now, while there is a build
# log to watch, rather than on the first frame in production. trust_repo is
# not optional here: without it torch.hub blocks on a stdin prompt that a
# container will never answer, and the failure reads like a hang.
ARG PRELOAD=1
RUN if [ "$PRELOAD" = "1" ]; then python -c "\
import torch; \
m = torch.hub.load('NVlabs/RADIO', 'radio_model', version='c-radio_v3-b', \
                   adaptor_names=['siglip2'], progress=False, \
                   skip_validation=True, trust_repo=True); \
print('preloaded', list(m.adaptors.keys()))"; fi

# A room per container. One process can only hold one source, and splitting by
# room is also what keeps a camera's frames and its labels together.
ENV PACT_ROOM=default \
    PACT_HUB=https://pact.lanvar.ai \
    PACT_SOURCE=relay \
    PACT_EMBED=local \
    PACT_RESOLUTION=384 \
    PACT_STORE=/data/perception.db

VOLUME ["/data"]

ENTRYPOINT ["python", "-m", "pact_perception.run"]
