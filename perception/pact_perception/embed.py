"""
The encoder. One frame in, one vector out.

This is the only part of the pipeline that touches a neural network, and it
runs once per frame no matter how many skills or goals exist. Everything
downstream is arithmetic on its output.

Four things about C-RADIOv3-B that are not what the documentation suggests,
each confirmed against the released checkpoint rather than the model card:

The adaptor is named `siglip2`, not `siglip2-g`. The teachers baked into this
checkpoint are clip, siglip2, dino_v2 and sam; `siglip2-g` belongs to the H
and v4 variants and asking for it here raises.

The vectors are 1152-dimensional, not 768. 768 is the backbone's per-token
width; the summary is 2304 and the siglip2 adaptor projects to 1152, which is
also what the text tower emits, which is why the two are comparable at all.

The HuggingFace route cannot do text. That repo ships empty `adaptor_configs`
and no adaptor tensors, so `AutoModel` gives image features and no way to
embed a sentence. The adaptor weights exist only inside the .pth.tar reached
through torch.hub, which is why this loads that way despite being heavier.

The adaptor does not carry SigLIP's `logit_scale` and `logit_bias`. It keeps
the text tower and discards the calibration, so a raw cosine pushed through a
sigmoid lands everything between 0.47 and 0.60 and no threshold above that is
reachable. Turning a cosine into a score is `skills.py`'s job, not this one's,
and this module deliberately returns the raw vector.

Text is embedded once per skill, ever, at creation. The image path runs
forever. They are split here so a deployment can carry only what it needs.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np
from PIL import Image

#: What the siglip2 adaptor projects to, and what the SigLIP2 text tower
#: emits. Asserted at load rather than trusted, because a silent mismatch
#: here produces confident nonsense rather than an error.
SIGLIP2_DIM = 1152


@dataclass(frozen=True, slots=True)
class Embedding:
    vector: np.ndarray
    ms: float

    @property
    def dim(self) -> int:
        return int(self.vector.shape[-1])


class Embedder(Protocol):
    encoder_id: str
    dim: int

    def encode_image(self, image: Image.Image) -> Embedding: ...

    def encode_text(self, texts: list[str]) -> np.ndarray: ...


def _l2(x: np.ndarray) -> np.ndarray:
    """Row-wise unit norm, so every dot product downstream is a cosine."""
    n = np.linalg.norm(x, axis=-1, keepdims=True)
    return x / np.maximum(n, 1e-12)


class LocalEmbedder:
    """
    C-RADIO in this process.

    In-process rather than behind an HTTP hop because that is one fewer thing
    to keep alive: the measured cost of a frame is hundreds of milliseconds,
    and a network round trip to a service we also have to deploy buys nothing
    back. The remote implementation stays for when the GPU is elsewhere.
    """

    def __init__(
        self,
        version: str = "c-radio_v3-b",
        adaptor: str = "siglip2",
        resolution: int = 384,
        device: str = "cpu",
    ) -> None:
        import torch

        if resolution % 16 != 0:
            raise ValueError(
                f"resolution must be a multiple of the patch size 16, got {resolution}"
            )

        self._torch = torch
        self.adaptor_name = adaptor
        self.resolution = resolution
        self.device = device
        self.encoder_id = f"{version}/{adaptor}@{resolution}"

        # trust_repo=True is not optional in anything non-interactive: without
        # it torch.hub blocks on a stdin prompt that a container will never
        # answer, and the failure reads like a hang rather than a question.
        self._model = torch.hub.load(
            "NVlabs/RADIO",
            "radio_model",
            version=version,
            adaptor_names=[adaptor],
            progress=False,
            skip_validation=True,
            trust_repo=True,
        )
        self._model.eval().to(device)
        self._adaptor: Any = self._model.adaptors[adaptor]
        self.dim = SIGLIP2_DIM

    def _tensor(self, image: Image.Image):
        torch = self._torch
        im = image.convert("RGB").resize(
            (self.resolution, self.resolution), Image.Resampling.BICUBIC
        )
        arr = np.asarray(im, dtype=np.float32) / 255.0
        x = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0)
        return x.to(self.device)

    def encode_image(self, image: Image.Image) -> Embedding:
        torch = self._torch
        started = time.perf_counter()
        with torch.no_grad():
            out = self._model(self._tensor(image))
        summary = out[self.adaptor_name].summary
        vec = _l2(summary.float().cpu().numpy())[0]
        if vec.shape[-1] != self.dim:
            raise RuntimeError(f"expected {self.dim}-d summary, got {vec.shape[-1]}")
        return Embedding(vector=vec, ms=(time.perf_counter() - started) * 1000.0)

    def encode_text(self, texts: list[str]) -> np.ndarray:
        """
        Runs once per skill, at creation, then the result is a cached vector.

        This is the step that makes a goal work the instant it is written: the
        weight vector is not learned from your footage, it is the direction the
        encoder already associated with that sentence during pretraining.
        """
        torch = self._torch
        with torch.no_grad():
            tokens = self._adaptor.tokenizer(texts)
            if hasattr(tokens, "to"):
                tokens = tokens.to(self.device)
            w = self._adaptor.encode_text(tokens, normalize=True)
        return _l2(w.float().cpu().numpy())


class RemoteEmbedder:
    """
    The same contract against an HTTP endpoint.

    Kept because the encoder may eventually live on a GPU elsewhere while
    perception stays next to the cameras. The wire format is deliberately
    boring: a JPEG in, a list of floats out.
    """

    def __init__(
        self, url: str, encoder_id: str, dim: int = SIGLIP2_DIM, timeout: float = 30.0
    ) -> None:
        import httpx

        self._client = httpx.Client(base_url=url.rstrip("/"), timeout=timeout)
        self.encoder_id = encoder_id
        self.dim = dim

    def encode_image(self, image: Image.Image) -> Embedding:
        import io

        buf = io.BytesIO()
        image.convert("RGB").save(buf, format="JPEG", quality=88)
        started = time.perf_counter()
        r = self._client.post(
            "/embed/image",
            content=buf.getvalue(),
            headers={"Content-Type": "image/jpeg"},
        )
        r.raise_for_status()
        vec = _l2(np.asarray(r.json()["vector"], dtype=np.float32))
        return Embedding(vector=vec, ms=(time.perf_counter() - started) * 1000.0)

    def encode_text(self, texts: list[str]) -> np.ndarray:
        r = self._client.post("/embed/text", json={"texts": texts})
        r.raise_for_status()
        return _l2(np.asarray(r.json()["vectors"], dtype=np.float32))

    def close(self) -> None:
        self._client.close()
