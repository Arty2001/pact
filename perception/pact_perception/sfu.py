"""
Pull frames straight off the SFU, the way a viewer on the wall does.

This replaces having the publisher upload a second copy of its own video.
That approach worked, but it was the wrong shape and it kept proving it: a
publisher tab that goes to the background gets its timers throttled by the
browser and simply stops sending while its camera still shows as live, the
upload round trip serialised into the capture loop and capped the rate at
about 7.5 fps, and the whole thing needed a rate negotiation to tell the
browser how fast to go. None of that exists here. The video is already
flowing to the SFU; this subscribes to it.

Two things make it tractable in Python at all.

The SFU does not transcode - it forwards exactly what the publisher encoded.
So the codec is the publisher's choice, and aiortc decodes H.264 and VP8 and
nothing else. The publisher therefore pins its codec preference rather than
letting the browser pick VP9 or AV1, which is a one-line change there and
the difference between this working and silently receiving nothing.

And subscribing is the awkward direction of the SFU API. Publishing is one
round trip: you offer, it answers. Subscribing is two: you name the tracks
you want, the SFU sends *its* offer, and you answer separately through
/renegotiate. Getting that backwards is the usual way this fails.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx
from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription

from .device import Device
from .log import Logger
from .sources import Frame

#: The same STUN server the browser client uses.
_ICE = RTCConfiguration(iceServers=[RTCIceServer(urls="stun:stun.cloudflare.com:3478")])

#: How long to wait for a track to start producing before giving up on it.
_FIRST_FRAME_TIMEOUT_S = 20.0




class SfuSubscription:
    """
    One PeerConnection pulling one device's video.

    Frames are dropped rather than queued when the consumer falls behind.
    A backlog would hand the state machine pictures of a squat that finished
    seconds ago and time its dwell against the wrong clock, which is worse
    than missing the frame outright.
    """

    def __init__(self, hub: str, device: Device, log: Logger) -> None:
        self.hub = hub.rstrip("/")
        self.device = device
        self.log = log
        self.pc: RTCPeerConnection | None = None
        self._latest: Frame | None = None
        self._seq = 0
        self._closed = False
        #: Held, because asyncio keeps only a weak reference to a bare task
        #: and this one may be collected mid-stream if nothing owns it.
        self._drain_task: asyncio.Task[None] | None = None

    async def connect(self) -> None:
        async with httpx.AsyncClient(base_url=self.hub, timeout=30.0) as http:
            session = await http.post("/api/sfu/sessions")
            session.raise_for_status()
            session_id = session.json()["sessionId"]

            pc = RTCPeerConnection(configuration=_ICE)
            self.pc = pc
            started: asyncio.Future[None] = asyncio.get_running_loop().create_future()

            @pc.on("track")
            def on_track(track: Any) -> None:
                if track.kind != "video":
                    return
                if not started.done():
                    started.set_result(None)
                self._drain_task = asyncio.ensure_future(self._drain(track))

            pull = await http.post(
                f"/api/sfu/sessions/{session_id}/tracks",
                json={
                    "tracks": [
                        {
                            "location": "remote",
                            "trackName": name,
                            "sessionId": self.device.session_id,
                        }
                        for name in self.device.track_names
                    ]
                },
            )
            pull.raise_for_status()
            body = pull.json()
            if body.get("errorCode"):
                raise RuntimeError(f"subscribe failed: {body.get('errorDescription')}")

            # The SFU offered, so we answer. This is the direction that makes
            # subscribing two round trips instead of one.
            if body.get("requiresImmediateRenegotiation"):
                await pc.setRemoteDescription(
                    RTCSessionDescription(
                        sdp=body["sessionDescription"]["sdp"],
                        type=body["sessionDescription"]["type"],
                    )
                )
                answer = await pc.createAnswer()
                await pc.setLocalDescription(answer)
                reneg = await http.put(
                    f"/api/sfu/sessions/{session_id}/renegotiate",
                    json={
                        "sessionDescription": {
                            "sdp": pc.localDescription.sdp,
                            "type": pc.localDescription.type,
                        }
                    },
                )
                reneg.raise_for_status()
                if reneg.json().get("errorCode"):
                    raise RuntimeError(reneg.json().get("errorDescription"))

            await asyncio.wait_for(started, timeout=_FIRST_FRAME_TIMEOUT_S)
            self.log.info(
                "service.start",
                detail="subscribed",
                room=self.device.room,
                device=self.device.name,
            )

    async def _drain(self, track: Any) -> None:
        """
        Consume the track as fast as it arrives, keeping only the newest frame.

        Reading has to continue at full rate even when the encoder is slower,
        because an unread RTP track backs up and the decoder falls behind the
        wall clock. Sampling happens by taking `latest`, not by reading less.
        """
        while not self._closed:
            try:
                av_frame = await track.recv()
            except Exception:
                return
            self._seq += 1
            try:
                image = av_frame.to_image()
            except Exception:
                continue
            self._latest = Frame(
                seq=self._seq,
                ts=time.time(),
                image=image,
                source="sfu",
            )

    @property
    def latest(self) -> Frame | None:
        return self._latest

    async def close(self) -> None:
        self._closed = True
        if self._drain_task is not None:
            self._drain_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._drain_task
        if self.pc is not None:
            with contextlib.suppress(Exception):
                await self.pc.close()


class SfuSource:
    """
    Every live device on the wall, sampled at a requested rate.

    Discovery is the Hub's own WebSocket, the same one the wall uses, so a
    camera added at /join is subscribed to without anything being
    reconfigured and one that leaves is dropped when its socket closes.
    """

    def __init__(self, hub: str, log: Logger, hz: float = 2.0) -> None:
        self.name = "sfu"
        self.hub = hub.rstrip("/")
        self.log = log
        self._hz = max(hz, 0.1)
        self._subs: dict[str, SfuSubscription] = {}
        self._closed = False

    def set_rate(self, hz: float) -> None:
        self._hz = max(0.1, min(hz, 30.0))

    async def devices(self) -> AsyncIterator[list[Device]]:
        """The live set, pushed by the Hub whenever it changes."""
        import json

        import websockets

        url = self.hub.replace("http://", "ws://").replace("https://", "wss://") + "/api/hub/ws"
        live: dict[str, Device] = {}
        async with websockets.connect(url, max_size=4 * 1024 * 1024) as ws:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                if msg.get("type") == "state":
                    live = {d["id"]: _device(d) for d in msg.get("devices", [])}
                elif msg.get("type") == "up":
                    d = _device(msg["device"])
                    live[d.id] = d
                elif msg.get("type") == "down":
                    live.pop(msg.get("id"), None)
                else:
                    continue
                yield list(live.values())

    async def reconcile(self, devices: list[Device]) -> None:
        """Subscribe to anything new, drop anything gone."""
        want = {d.id: d for d in devices}
        for gone in [k for k in self._subs if k not in want]:
            await self._subs.pop(gone).close()
            self.log.info("service.stop", detail="unsubscribed", room=gone)

        for dev_id, dev in want.items():
            if dev_id in self._subs or not dev.track_names:
                continue
            sub = SfuSubscription(self.hub, dev, self.log)
            try:
                await sub.connect()
            except Exception as err:
                self.log.warn(
                    "service.error",
                    detail=f"could not subscribe to {dev.name}: {err}",
                    room=dev.room,
                )
                await sub.close()
                continue
            self._subs[dev_id] = sub

    async def frames(self) -> AsyncIterator[tuple[str, Frame]]:
        """
        The newest frame from each subscribed device, at the requested rate.

        Yields (room, frame). Sampling by polling `latest` rather than by
        reading the track slowly is deliberate: the track must be drained at
        full speed regardless, and this way the rate is a property of what
        we look at rather than of what the decoder is allowed to do.
        """
        seen: dict[str, int] = {}
        # A deadline, not a delay. Sleeping for the full interval and only
        # then handing over a frame makes the period the interval PLUS
        # however long scoring took, so a requested 8 Hz with 90ms of work
        # per frame actually ran at 4.6 - and at 4.6 Hz the bottom of a fast
        # squat is one frame, which no dwell can be short enough to catch.
        due = time.monotonic()
        while not self._closed:
            due += 1.0 / self._hz
            slack = due - time.monotonic()
            if slack > 0:
                await asyncio.sleep(slack)
            else:
                # Behind the clock. Carrying the debt forward would spend the
                # next several periods sprinting to catch up a second that is
                # already gone, so the deadline moves to now instead.
                due = time.monotonic()
            for sub in list(self._subs.values()):
                frame = sub.latest
                if frame is None or seen.get(sub.device.id) == frame.seq:
                    continue
                seen[sub.device.id] = frame.seq
                yield sub.device.room, frame

    async def aclose(self) -> None:
        self._closed = True
        for sub in list(self._subs.values()):
            await sub.close()
        self._subs.clear()


def _device(d: dict[str, Any]) -> Device:
    return Device(
        id=str(d.get("id", "")),
        name=str(d.get("name", "camera")),
        kind=str(d.get("kind", "camera")),
        session_id=str(d.get("sfuSessionId", "")),
        track_names=tuple(str(t) for t in d.get("trackNames", [])),
        given_room=str(d.get("room") or ""),
    )
