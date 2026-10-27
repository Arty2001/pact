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

import contextlib
import os
import time
from dataclasses import dataclass
from pathlib import Path
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


def usable_cpus() -> int:
    """
    How many cores this process may actually use, not how many exist.

    `os.cpu_count()` reports the machine. Inside a container allocated
    sixteen cores on a host that has a hundred and ninety-two, it returns a
    hundred and ninety-two, torch starts that many threads, and they spend
    their time contending for sixteen cores rather than working. Measured
    against a four-thread laptop the container came out SLOWER - 208 ms a
    frame against 195 - which is the shape this bug always has: more
    hardware, less throughput, and nothing in the logs to say why.

    The cgroup is asked first because that is what actually limits the
    process, and a CPU quota is invisible to both `cpu_count` and the
    affinity mask. Then the affinity mask, which catches cpuset pinning.
    Then the machine, for a bare-metal run where all three agree anyway.
    """
    # cgroup v2: "<quota> <period>", or "max <period>" when unlimited.
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        if quota != "max":
            return max(1, round(int(quota) / int(period)))
    except Exception:
        pass

    # cgroup v1: the same pair, in two files. A quota of -1 means unlimited.
    try:
        quota = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").read_text())
        period = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us").read_text())
        if quota > 0 and period > 0:
            return max(1, round(quota / period))
    except Exception:
        pass

    # Affinity, where the kernel has it: respects cpuset pinning, which a
    # quota check cannot see.
    try:
        return max(1, len(os.sched_getaffinity(0)))
    except AttributeError:
        pass

    return max(1, os.cpu_count() or 1)


def _pick_device(torch: Any, requested: str) -> str:
    """
    Resolve "auto" to the fastest thing actually present.

    Explicit beats clever: a device named on the command line is used as
    given, so a GPU that turns out to be slower than the CPU for some
    resolution can be ruled out without editing code.
    """
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def layout_only(image: Image.Image, grid: int = 16) -> Image.Image:
    """
    Keep what a screen looks like; throw away what is on it.

    The problem this solves is that the clip dominates the frame. Asked
    whether you are watching short-form video, the honest signal is the
    chrome - a bright upright panel on a dark ground, a column of round
    buttons down one side - and the clip inside it is noise that changes
    every few seconds. Measured on real frames, a content-led label swings
    far more than a layout-led one, and a swing is what a fixed threshold
    cannot sit under.

    Averaging down to a coarse grid and back up destroys the detail and
    leaves the structure: a dancing person and a cooking video become the
    same mush inside the same unmistakable vertical panel. BOX is the
    resampling that averages rather than samples, which is the whole point -
    NEAREST would keep one pixel in each cell and so keep the noise.

    A side effect worth having on purpose: what you were reading cannot be
    recovered from the result. At this grid a page of text is a texture, so
    the embedding records that you were reading, not what.

    The grid is 16 because it was measured rather than chosen. Across 8 to
    48, two Shorts frames with entirely different clips in them collapse
    from a mean difference of 21.7 to 0.73 at 16 - a thirtyfold fall - while
    the panel still stands 111 levels above the ground beside it and the
    button column is at its most legible of any grid tried. Finer grids keep
    more of the clip and, worse, let a page of text alias into visible bands
    against the cell pitch: row variation runs 11.6 at 16, 16.3 at 32 and
    35.5 at 48, which is text becoming readable again.
    """
    if grid < 2:
        raise ValueError(f"grid must be at least 2, got {grid}")
    w, h = image.size
    small = image.convert("RGB").resize((grid, grid), Image.Resampling.BOX)
    return small.resize((w, h), Image.Resampling.BILINEAR)


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
        device: str = "auto",
    ) -> None:
        import torch

        if resolution % 16 != 0:
            raise ValueError(
                f"resolution must be a multiple of the patch size 16, got {resolution}"
            )

        self._torch = torch
        self.adaptor_name = adaptor
        self.resolution = resolution
        self.device = _pick_device(torch, device)

        # Half precision on a GPU, via autocast rather than by casting the
        # weights. Casting the module outright fails on this model: RADIO
        # carries buffers that are not plain float tensors, and .to(float16)
        # turns a matmul into "float != struct". Autocast picks per operation
        # instead, which is both correct here and what the tensor cores want.
        self._amp = self.device.startswith("cuda")

        # bfloat16 on the CPU as well, where the CPU can do it. Zen 4 and
        # Sapphire Rapids carry AVX-512 bf16, and on those this is most of a
        # halving for a matmul-bound forward pass. It is off by default and
        # named, not inferred: it changes the numbers in the last couple of
        # decimal places, and every skill's bias and temperature were fitted
        # against float32 vectors. The shift is far smaller than any
        # calibration band, but "far smaller than" is a claim worth letting
        # someone turn off.
        self._cpu_bf16 = (
            self.device == "cpu"
            and os.environ.get("PACT_CPU_BF16", "0") == "1"
            and hasattr(torch, "bfloat16")
        )

        if self.device == "cpu":
            # torch defaults to physical cores and leaves hyperthreads idle.
            # On an 8-thread laptop that is half the machine, and this is the
            # cheapest speedup available before reaching for a GPU.
            self.threads = usable_cpus()
            torch.set_num_threads(self.threads)
        else:
            self.threads = 0

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
        self._model.eval().to(self.device)
        self._adaptor: Any = self._model.adaptors[adaptor]
        self.dim = SIGLIP2_DIM

        # The text tower stays on the CPU. It runs once per skill, ever, so
        # its speed is irrelevant, and keeping it off a 4 GB card leaves the
        # whole budget to the thing that runs every frame.
        with contextlib.suppress(Exception):
            self._adaptor.text_model.to("cpu")

    def _tensor(self, image: Image.Image):
        torch = self._torch
        im = image.convert("RGB").resize(
            (self.resolution, self.resolution), Image.Resampling.BICUBIC
        )
        arr = np.asarray(im, dtype=np.float32) / 255.0
        x = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0)
        # channels_last is the layout oneDNN wants for convolution on a CPU.
        # Handed NCHW it reorders internally on every call, which is work
        # paid for per frame rather than once here.
        if self.device == "cpu":
            x = x.contiguous(memory_format=torch.channels_last)
        return x.to(self.device)

    def encode_image(self, image: Image.Image) -> Embedding:
        torch = self._torch
        started = time.perf_counter()
        # inference_mode rather than no_grad: it also skips version counting
        # and view tracking, which no_grad still pays for. Strictly the same
        # numbers, strictly less bookkeeping.
        if self._cpu_bf16:
            with torch.inference_mode(), torch.autocast("cpu", dtype=torch.bfloat16):
                out = self._model(self._tensor(image))
        else:
            with (
                torch.inference_mode(),
                torch.autocast("cuda", enabled=self._amp, dtype=torch.float16),
            ):
                out = self._model(self._tensor(image))
        summary = out[self.adaptor_name].summary
        # .cpu() below forces a sync, so the number this returns is real work
        # rather than kernel-launch time. Worth stating: CUDA is asynchronous,
        # and a timer that stops before the device has finished reports a
        # speedup that does not exist.
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
                tokens = tokens.to("cpu")
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


class StubEmbedder:
    """
    A fake encoder for exercising the wiring, with no model and no download.

    It understands nothing. There is no semantic content in what it returns,
    so a skill labelled "a person at a sink" will not detect a person at a
    sink, and no threshold learned against it transfers to the real encoder.
    It exists for one reason: the pipeline between a frame and a settled
    instance has a lot of moving parts, and being able to watch all of them
    work in seconds rather than after a four gigabyte download is worth more
    than it looks.

    What it does guarantee is enough to be useful:

    Determinism. The same text always yields the same vector, so a skill's
    weights are stable across restarts.

    Responsiveness. The image vector is built from a coarse grid of the frame
    itself, so standing in front of the camera genuinely moves the score and
    the state machine genuinely fires. That makes it a live end-to-end test
    rather than a replay of canned numbers.

    Both are produced by projecting through one fixed random basis, so image
    and text land in the same space and their dot product is a real cosine -
    just a meaningless one.
    """

    #: Any dimension works; matching the real encoder keeps the Engine's
    #: stored vectors the same width whichever one wrote them.
    def __init__(self, dim: int = SIGLIP2_DIM, resolution: int = 384, grid: int = 8) -> None:
        self.dim = dim
        self.resolution = resolution
        self.encoder_id = f"stub/none@{resolution}"
        self._grid = grid
        # One fixed basis, seeded by a constant, so vectors survive restarts.
        rng = np.random.default_rng(20261024)
        self._image_basis = rng.normal(size=(grid * grid * 3, dim)).astype(np.float32)
        self._text_basis = rng.normal(size=(64, dim)).astype(np.float32)

    def encode_image(self, image: Image.Image) -> Embedding:
        started = time.perf_counter()
        small = image.convert("RGB").resize((self._grid, self._grid), Image.Resampling.BILINEAR)
        feat = (np.asarray(small, dtype=np.float32) / 255.0).ravel()
        vec = _l2(feat @ self._image_basis)
        return Embedding(vector=vec, ms=(time.perf_counter() - started) * 1000.0)

    def encode_text(self, texts: list[str]) -> np.ndarray:
        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        for i, text in enumerate(texts):
            # A character histogram is a deterministic, content-dependent
            # fingerprint. Two similar sentences land near each other, which
            # is the one property that makes a stub worth running at all.
            hist = np.zeros(64, dtype=np.float32)
            for ch in text.lower():
                hist[ord(ch) % 64] += 1.0
            out[i] = hist @ self._text_basis
        return _l2(out)
