"""
Where frames come from.

Live and replay go through one interface, and that is the whole point of this
module. Thresholds cannot be tuned by performing an action in front of a camera
over and over: you record once, then replay the same frames until the numbers
are right. If replay were a separate code path it would drift from the live one
and the tuning would not transfer.

Three implementations:

    FolderSource   a directory of stills, replayed at a chosen rate. The one
                   used for tuning and for demos that must not depend on a
                   camera being pointed at anything.
    CameraSource   a local webcam, for development at your desk.
    RelaySource    frames pushed from a browser via the Worker. This is how
                   a phone anywhere reaches a perception service in the cloud,
                   and it is the only source that needs no media stack here.

`Frame.seq` is monotonic per source rather than global: it answers "did I drop
one?", which is a question about a single camera.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from PIL import Image

#: Suffixes a folder replay will pick up, lowercased.
_STILLS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


@dataclass(frozen=True, slots=True)
class Frame:
    seq: int
    ts: float
    image: Image.Image
    source: str


class FrameSource(Protocol):
    """
    An async iterator of frames with a requestable rate.

    `set_rate` is a request, not a command. A folder or a camera obeys it
    directly; a relay cannot, because the browser on the other end owns its
    own clock, so it forwards the request upstream and the rate changes when
    the browser acts on it.
    """

    name: str

    def set_rate(self, hz: float) -> None: ...

    def frames(self) -> AsyncIterator[Frame]: ...

    async def aclose(self) -> None: ...


class _Paced:
    """Shared rate limiter. Sleeps the remainder of each period, never longer."""

    def __init__(self, hz: float) -> None:
        self._period = 1.0 / max(hz, 1e-6)
        self._next = 0.0

    def set_rate(self, hz: float) -> None:
        self._period = 1.0 / max(hz, 1e-6)

    async def wait(self) -> None:
        now = time.monotonic()
        if self._next == 0.0:
            self._next = now
        delay = self._next - now
        if delay > 0:
            await asyncio.sleep(delay)
        # Advance from the deadline, not from now, so a slow frame is caught
        # up on rather than permanently shifting the whole schedule later.
        self._next = max(self._next + self._period, time.monotonic() - self._period)


class FolderSource:
    """
    Replays a directory of stills in filename order.

    Filename order rather than mtime: copying a recording changes mtimes but
    not names, and a replay that reorders itself when you move it is useless
    for tuning.
    """

    def __init__(self, folder: str | Path, hz: float = 2.0, loop: bool = False) -> None:
        self.name = "folder"
        self._paths = sorted(
            (p for p in Path(folder).iterdir() if p.suffix.lower() in _STILLS),
            key=lambda p: p.name,
        )
        if not self._paths:
            raise FileNotFoundError(f"no stills in {folder}")
        self._paced = _Paced(hz)
        self._loop = loop

    def set_rate(self, hz: float) -> None:
        self._paced.set_rate(hz)

    async def frames(self) -> AsyncIterator[Frame]:
        seq = 0
        while True:
            for path in self._paths:
                await self._paced.wait()
                with Image.open(path) as im:
                    img = im.convert("RGB")
                seq += 1
                yield Frame(seq=seq, ts=time.time(), image=img, source=self.name)
            if not self._loop:
                return

    async def aclose(self) -> None:
        return None


class CameraSource:
    """
    A local webcam, via OpenCV.

    OpenCV is imported lazily so that the state machine and its tests install
    and run without it. Most of this package has no business needing a camera
    stack present to be tested.
    """

    def __init__(self, index: int = 0, hz: float = 2.0) -> None:
        import cv2

        self.name = "camera"
        self._cv2 = cv2
        self._cap = cv2.VideoCapture(index)
        if not self._cap.isOpened():
            raise RuntimeError(f"could not open camera {index}")
        self._paced = _Paced(hz)

    def set_rate(self, hz: float) -> None:
        self._paced.set_rate(hz)

    async def frames(self) -> AsyncIterator[Frame]:
        seq = 0
        while True:
            await self._paced.wait()
            # grab() then retrieve() discards the buffered frame the driver is
            # holding. Without it a 0.5 Hz read returns whatever was captured
            # seconds ago, and every score lags reality by the buffer depth.
            self._cap.grab()
            ok, bgr = self._cap.retrieve()
            if not ok:
                return
            rgb = self._cv2.cvtColor(bgr, self._cv2.COLOR_BGR2RGB)
            seq += 1
            yield Frame(seq=seq, ts=time.time(), image=Image.fromarray(rgb), source=self.name)

    async def aclose(self) -> None:
        self._cap.release()


class RelaySource:
    """
    Frames pushed in from elsewhere, decoded from JPEG bytes.

    The transport is not this class's problem: `run.py` owns the WebSocket and
    calls `offer` as frames land. That split is what lets the same source be
    fed by a socket in production and by a test in a unit test.
    """

    def __init__(self, maxsize: int = 4) -> None:
        self.name = "relay"
        # A small bounded queue, dropping the oldest when full. Falling behind
        # on a live feed should cost you the stalest frame, not add latency
        # that never recovers.
        self._q: asyncio.Queue[Frame] = asyncio.Queue(maxsize=maxsize)
        self._seq = 0
        self._closed = False
        self.requested_hz = 0.0

    def set_rate(self, hz: float) -> None:
        # Recorded for run.py to forward upstream; the sender owns the clock.
        self.requested_hz = hz

    def offer(self, jpeg: bytes, ts: float | None = None) -> None:
        with Image.open(io.BytesIO(jpeg)) as im:
            img = im.convert("RGB")
        self._seq += 1
        frame = Frame(seq=self._seq, ts=ts or time.time(), image=img, source=self.name)
        if self._q.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self._q.get_nowait()
        self._q.put_nowait(frame)

    async def frames(self) -> AsyncIterator[Frame]:
        while not self._closed:
            yield await self._q.get()

    async def aclose(self) -> None:
        self._closed = True


def build(
    kind: str,
    *,
    folder: str | None = None,
    camera_index: int = 0,
    hz: float = 2.0,
) -> FrameSource:
    """One place that maps a config string to a source."""
    if kind == "folder":
        if folder is None:
            raise ValueError("folder source needs a folder")
        return FolderSource(folder, hz=hz)
    if kind == "camera":
        return CameraSource(camera_index, hz=hz)
    if kind == "relay":
        return RelaySource()
    raise ValueError(f"unknown source kind {kind!r}")
