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
        #: When a frame last arrived. A subscription that has stopped
        #: delivering looks exactly like a still room from everywhere else.
        self._last_at = time.time()
        #: Why the drain stopped, if it did. Empty while it is running.
        self.ended = ""

    @property
    def silent_for(self) -> float:
        return time.time() - self._last_at
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
            except Exception as err:
                # Returning silently here is how a feed dies unnoticed: the
                # task ends, `latest` freezes at the last picture, and the
                # subscription stays in the table looking perfectly healthy.
                if not self._closed:
                    self.ended = str(err) or err.__class__.__name__
                    self.log.warn(
                        "service.error",
                        detail=f"track ended for {self.device.name}: {self.ended}",
                        room=self.device.room,
                    )
                return
            self._seq += 1
            self._last_at = time.time()
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


#: How long a subscription may deliver nothing before it is treated as dead.
#: A publisher sends frames continuously, so this is not a quiet room - it is
#: a feed that has stopped. Long enough to survive a renegotiation, short
#: enough that nobody is standing in front of a camera wondering.
STALL_AFTER_S = 12.0

#: How long the Hub may say nothing before it gets asked directly. Quiet is
#: normal - a wall changes rarely - so this only has to be short enough that
#: an orphaned socket is noticed before anyone is standing in front of a
#: camera wondering why nothing counts.
_RECONCILE_S = 20.0


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

    async def _ask_hub(self) -> list[Device] | None:
        """The live set, asked for rather than waited for."""
        try:
            async with httpx.AsyncClient(timeout=8.0) as http:
                res = await http.get(f"{self.hub}/api/hub/devices")
                res.raise_for_status()
                return [_device(d) for d in res.json().get("devices", [])]
        except Exception:
            # The Hub being unreachable is the socket's problem to report.
            return None

    async def devices(self) -> AsyncIterator[list[Device]]:
        """
        The live set, pushed by the Hub and checked against it.

        A push socket cannot tell you it has stopped being listened to. This
        one went quiet after a deploy cycled the Hub - still open, still
        pinging, no longer in anyone's broadcast set - and the wall stayed
        empty for five minutes while a camera was publishing, because
        "nothing has changed" and "I am no longer being told" arrive as
        exactly the same silence.

        So the socket is for latency and the Hub's own answer is for truth.
        Every RECONCILE_S of quiet, ask. If the answer differs from what the
        socket believes, the socket has been talking to nobody: hand back
        the truth and return, which drops the connection and makes the
        caller open an honest one.
        """
        import json

        import websockets

        url = self.hub.replace("http://", "ws://").replace("https://", "wss://") + "/api/hub/ws"
        live: dict[str, Device] = {}
        async with websockets.connect(url, max_size=4 * 1024 * 1024) as ws:
            while not self._closed:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=_RECONCILE_S)
                except TimeoutError:
                    truth = await self._ask_hub()
                    if truth is None or {d.id for d in truth} == set(live):
                        continue
                    self.log.warn(
                        "service.error",
                        detail="hub socket went quiet while the wall changed; reconnecting",
                        devices=[d.name for d in truth],
                    )
                    yield truth
                    return

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
        """
        Subscribe to anything new, drop anything gone - or stalled.

        A stalled subscription is the one that costs you an afternoon. It is
        still in the table, so this loop skips it as already handled; its
        drain task has ended, so no frame will ever arrive again; and every
        layer above reads that as a quiet room. Dropping it here is all that
        is needed, because the next pass then treats the device as new.
        """
        want = {d.id: d for d in devices}
        for gone in [k for k in self._subs if k not in want]:
            await self._subs.pop(gone).close()
            self.log.info("service.stop", detail="unsubscribed", room=gone)

        for dev_id in [k for k, s in self._subs.items() if self._stalled(s)]:
            sub = self._subs.pop(dev_id)
            self.log.warn(
                "service.error",
                detail=(
                    f"no frames from {sub.device.name} for "
                    f"{sub.silent_for:.0f}s; resubscribing"
                ),
                room=sub.device.room,
            )
            await sub.close()

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

    def known(self) -> list[Device]:
        """
        The devices this source currently holds a subscription for.

        Used by the repair sweep, which has to reconcile against something
        when the Hub has said nothing - a feed dying is not a change the Hub
        can see, because the publisher is still connected to it.
        """
        return [s.device for s in self._subs.values()]

    @staticmethod
    def _stalled(sub: SfuSubscription) -> bool:
        """
        Dead, as opposed to merely quiet.

        A publisher sends frames whether or not anything is moving - the
        motion gate is further up and decides what to spend on them - so a
        subscription delivering nothing at all is a broken one, not a still
        room. A track that reported its own end is dead immediately; one that
        has simply gone quiet is given STALL_AFTER_S first.
        """
        return bool(sub.ended) or sub.silent_for > STALL_AFTER_S

    async def frames(self) -> AsyncIterator[tuple[str, str, Frame]]:
        """
        The newest frame from each subscribed device, at the requested rate.

        Yields (room, surface, frame). Sampling by polling `latest` rather
        than by reading the track slowly is deliberate: the track must be
        drained at full speed regardless, and this way the rate is a property
        of what we look at rather than of what the decoder is allowed to do.

        The surface comes off the device the Hub registered, which is the
        same fact the publisher sends with a relayed frame - the two paths
        agree because both ultimately read it from the browser that chose a
        camera or a screen.
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
                surface = "screen" if sub.device.kind == "screen" else "camera"
                yield sub.device.room, surface, frame

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
