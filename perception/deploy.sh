#!/usr/bin/env bash
#
# Put perception on a Nebius VM, once.
#
# Everything here runs ON the instance, not from a laptop. There is no
# orchestration to configure because there is nothing to orchestrate:
# perception dials out to the Engine over one WebSocket, so the machine needs
# no inbound port, no TLS and no DNS. That is the property that makes "runs on
# a laptop" and "runs on a cloud VM" the same deployment.
#
#   ./deploy.sh --hub https://pact.lanvar.ai --key $NEBIUS_API_KEY
#
# With the encoder on a Nebius Serverless Endpoint instead of in-process:
#
#   ./deploy.sh --embed-url https://<endpoint>.nebius.cloud --key $NEBIUS_API_KEY
#
# ORIGINAL: curl -fsSL .../deploy.sh | bash -s -- \
#     --hub https://pact.lanvar.ai --key "$NEBIUS_API_KEY"
#
# The instance can then be stopped and started by the control plane, which is
# what makes this cost the disk rather than a GPU hour. Two things must be
# true for that to be safe, and both are checked below:
#
#   1. /data is on a NETWORK disk. Local disk contents are not preserved
#      across a stop/start via the Compute API, and /data is where every
#      embedding and every label lives. Losing it means the skills forget
#      everything they were taught.
#   2. The container restarts on boot, because a machine that comes back
#      without its process is a machine the control plane believes is working.
set -euo pipefail

HUB="https://pact.lanvar.ai"
KEY="${NEBIUS_API_KEY:-}"
ROOM="*"
RESOLUTION=384
IMAGE="pact-perception"
# CPU by default, deliberately. The 24/7 encoder on a commodity instance
# costs about a sixteenth of the smallest GPU, and the escalation to a
# GPU-hosted VL model only happens when a moment is genuinely ambiguous.
# Pass --gpu when the frame rate actually needs it.
BASE="python:3.12-slim"
TORCH="cpu"
RUNTIME_FLAGS=()
# Where the encoder runs. `local` keeps it inside this process; `remote`
# points at a Nebius Serverless Endpoint running this same image as
# pact_perception.serve. That split is the point: the stateful half - the
# WebRTC subscription, the calibration, the state machines - stays beside
# the cameras, and the one stateless step runs where there is a GPU.
EMBED="local"
EMBED_URL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --hub)        HUB="$2"; shift 2 ;;
    --key)        KEY="$2"; shift 2 ;;
    --room)       ROOM="$2"; shift 2 ;;
    --resolution) RESOLUTION="$2"; shift 2 ;;
    --embed-url)  EMBED="remote"; EMBED_URL="$2"; shift 2 ;;
    --gpu)
      # A PyTorch CUDA image, not a bare nvidia/cuda one. The bare CUDA
      # runtime images ship no Python at all, so every pip line in the
      # Dockerfile fails on them - and this one already carries torch built
      # against its own CUDA, which is what TORCH=skip is for.
      BASE="pytorch/pytorch:2.6.0-cuda12.6-cudnn9-runtime"
      TORCH="skip"
      RUNTIME_FLAGS=(--gpus all)
      shift ;;
    --help|-h)
      sed -n '3,23p' "$0" | sed 's/^#\s\?//'
      exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$KEY" ]; then
  echo "A Nebius Token Factory key is required: --key, or NEBIUS_API_KEY." >&2
  echo "Without it the teacher cannot adjudicate and skills only ever learn" >&2
  echo "from what a person tells them by hand." >&2
  exit 2
fi

echo "==> Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

echo "==> /data must survive a stop/start"
sudo mkdir -p /data
# The check that matters. A stop/start via the Compute API does not preserve
# local disk, so a store on one is a store that is wiped every time the
# control plane saves money. Reported rather than fixed: moving somebody's
# data onto a different disk is not a thing a deploy script should do quietly.
DEV="$(findmnt -no SOURCE --target /data || true)"
case "$DEV" in
  *nvme*|*local*)
    echo "WARNING: /data looks like it is on a local disk ($DEV)."
    echo "Local disks are NOT preserved across a stop/start via the Compute"
    echo "API, and /data holds every embedding and label this system has."
    echo "Attach a network SSD and mount it at /data before relying on the"
    echo "start-on-demand behaviour."
    ;;
  *) echo "    /data on $DEV" ;;
esac

echo "==> Building the image (weights bake in, so this is the slow part)"
cd "$(dirname "$0")"
sudo docker build --build-arg "BASE=$BASE" --build-arg "TORCH=$TORCH" -t "$IMAGE" .

echo "==> Running"
sudo docker rm -f pact >/dev/null 2>&1 || true
sudo docker run -d \
  --name pact \
  --restart always \
  "${RUNTIME_FLAGS[@]+"${RUNTIME_FLAGS[@]}"}" \
  -v /data:/data \
  -e "NEBIUS_API_KEY=$KEY" \
  -e "PACT_HUB=$HUB" \
  -e "PACT_STORE=/data/perception.db" \
  "$IMAGE" \
  pact_perception.run \
  --room "$ROOM" --source sfu --embed "$EMBED" ${EMBED_URL:+--embed-url "$EMBED_URL"} \
  --resolution "$RESOLUTION" --idle-hz 8 --hub "$HUB" --level info

cat <<DONE

Running. It dials out, so there is nothing to open and nothing to point at it.

  sudo docker logs -f pact

Expect about a minute before it can score anything: the encoder is four
gigabytes and has to load before the Engine socket can even open, because
the hello message carries the encoder id.

To let the control plane start and stop this machine, set these as Worker
secrets and the instance sleeps when no camera is publishing:

  npx wrangler secret put NEBIUS_INSTANCE_ID
  npx wrangler secret put NEBIUS_COMPUTE_TOKEN

Idle cost is then the disk alone.
DONE
