"""
The Engine client. One WebSocket, both directions.

Perception dials out rather than listening, which is the same shape
`bridge/` uses against the Hub. That choice buys more than symmetry: no
inbound port, no public address, no TLS to terminate and no CORS to argue
with, so the identical process runs on a laptop behind a router and on a
cloud VM with nothing changed but a URL.

What crosses, and what deliberately does not:

    down    the skill registry, and sampled frames
    up      state transitions, fitted weights, refit results

Scores never go up. Perception computes several a second per skill and the
control plane never sees one, which is the whole "7,200 scores an hour
becomes one event" property expressed as a wire format rather than a
convention. If a score could be posted, eventually it would be.

Reconnection is assumed rather than exceptional. A long-running process on a
home network will lose this socket, and a perception worker that needs
restarting by hand after a router reboot is a perception worker that is off.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any

import numpy as np
import websockets

from .log import Logger

#: Backoff bounds for reconnecting. Jittered, so several rooms coming back
#: after the same outage do not hammer the Engine in lockstep.
_BACKOFF_MIN_S = 1.0
_BACKOFF_MAX_S = 30.0


@dataclass(frozen=True, slots=True)
class IncomingFrame:
    room: str
    seq: int
    ts: float
    jpeg: bytes
    #: "camera" or "screen". Defaults to camera, because a publisher old
    #: enough not to send it is old enough to predate screens being watched.
    surface: str = "camera"


class Ledger:
    """
    Holds the socket and hands up whatever arrives on it.

    Sends are fire-and-forget by design. A transition that cannot be
    delivered must not stall the frame loop: dropping one event is a gap in
    the record, while blocking the loop stops the record entirely.
    """

    def __init__(self, hub: str, room: str, log: Logger, token: str | None = None) -> None:
        self.url = hub.replace("http://", "ws://").replace("https://", "wss://") + "/api/engine/ws"
        self.room = room
        self.log = log
        self.token = token
        self._ws: Any = None
        self._skills_cb: Callable[[list[dict[str, Any]]], None] | None = None
        self._label_cb: Callable[[str, float, float, int, str], None] | None = None
        self._relabel_cb: Callable[[str, str], None] | None = None

    def on_registry(self, cb: Callable[[list[dict[str, Any]]], None]) -> None:
        self._skills_cb = cb

    def on_label(self, cb: Callable[[str, float, float, int, str], None]) -> None:
        """
        A person's answer, on its way to becoming training examples.

        The answer is decided in the control plane and the embeddings it
        describes live here, so the label has to travel. Without this the
        teacher was the only thing that could ever teach a skill anything,
        and a teacher call fires on a tenth of a percent of frames.

        The callback takes a span rather than an instant, because the most
        valuable correction anyone makes is about a stretch the cameras
        missed entirely. A single moment arrives as a span of zero length.
        """
        self._label_cb = cb

    def on_relabel(self, cb: Callable[[str, str], None]) -> None:
        """
        A request to work out what a skill should have been looking for.

        Separate from `on_label` because the two do different things with
        the same complaint. A label is one more row of evidence toward a
        refit that needs about forty of them; a relabel reconsiders the
        sentence itself, which is the whole detector, and can act on one
        person saying so once.
        """
        self._relabel_cb = cb

    async def connect(self, encoder_id: str, dim: int) -> AsyncIterator[IncomingFrame]:
        """
        Stay connected, yielding frames as they arrive.

        Never returns under normal operation. The registry is delivered to
        the callback rather than yielded, so the caller's loop only has to
        think about frames.
        """
        attempt = 0
        while True:
            try:
                headers = {"Authorization": f"Bearer {self.token}"} if self.token else None
                async with websockets.connect(
                    self.url, additional_headers=headers, max_size=8 * 1024 * 1024
                ) as ws:
                    self._ws = ws
                    attempt = 0
                    await self._send(
                        {
                            "type": "hello",
                            "room": self.room,
                            "encoderId": encoder_id,
                            "dim": dim,
                        }
                    )
                    self.log.info("service.start", detail="engine socket open", url=self.url)

                    async for raw in ws:
                        msg = _parse(raw)
                        if msg is None:
                            continue
                        if msg.get("type") == "registry" and self._skills_cb is not None:
                            self._skills_cb(msg.get("skills") or [])
                        elif msg.get("type") == "label" and self._label_cb is not None:
                            at = float(msg.get("at", 0)) / 1000.0
                            # An older control plane sends only `at`, which
                            # means one moment - the same thing as a span of
                            # zero length, so it needs no separate path.
                            start = float(msg.get("from", msg.get("at", 0))) / 1000.0
                            end = float(msg.get("to", msg.get("at", 0))) / 1000.0
                            if end < start:
                                start, end = end, start
                            self._label_cb(
                                str(msg.get("skillKey", "")),
                                start or at,
                                end or at,
                                int(msg.get("label", 0)),
                                str(msg.get("source", "human")),
                            )
                        elif msg.get("type") == "relabel" and self._relabel_cb is not None:
                            self._relabel_cb(
                                str(msg.get("skillKey", "")),
                                str(msg.get("room") or self.room),
                            )
                        elif msg.get("type") == "frame":
                            yield IncomingFrame(
                                room=str(msg.get("room", self.room)),
                                seq=int(msg.get("seq", 0)),
                                ts=float(msg.get("ts", 0)) / 1000.0,
                                jpeg=base64.b64decode(msg.get("jpegBase64", "")),
                                surface=str(msg.get("surface") or "camera"),
                            )
            except asyncio.CancelledError:
                raise
            except Exception as err:
                self._ws = None
                delay = min(_BACKOFF_MIN_S * 2**attempt, _BACKOFF_MAX_S)
                jittered = delay * (0.75 + 0.5 * float(np.random.default_rng().random()))
                attempt += 1
                self.log.warn(
                    "service.error",
                    detail=f"engine socket lost: {err}",
                    retry_in_ms=int(jittered * 1000),
                )
                await asyncio.sleep(jittered)

    # ------------------------------------------------------------------ up

    async def rate(self, room: str, hz: float) -> None:
        """Ask a room's publisher for a sample rate. Sent only when it changes."""
        await self._send({"type": "rate", "room": room, "hz": hz})

    async def scores(self, room: str, hz: float, scores: dict[str, Any]) -> None:
        """
        A downsampled snapshot of what every eligible skill is scoring.

        Sent for the console to draw, and stored nowhere. Scores are produced
        several times a second per skill and the ledger keeping only
        transitions is the entire point of the split; a live view of a number
        is not a record of it, and nothing here outlives the socket.
        """
        await self._send({"type": "scores", "room": room, "hz": hz, "scores": scores})

    async def transition(self, payload: dict[str, Any]) -> None:
        await self._send({"type": "transition", "transition": payload})

    async def weights(
        self,
        skill_key: str,
        w: np.ndarray,
        encoder_id: str,
        bias: float,
        temperature: float,
    ) -> None:
        """
        Hand back a weight vector perception computed.

        The Engine creates a skill with a label and no vector, because the
        text encoder lives here and not there. This is the second half of
        that handshake, and it is why a skill reads `pending` for a moment
        after it is created rather than being broken.
        """
        flat = np.asarray(w, dtype=np.float32).ravel()
        await self._send(
            {
                "type": "weights",
                "skillKey": skill_key,
                "encoderId": encoder_id,
                "dim": int(np.atleast_2d(w).shape[-1]),
                "w": base64.b64encode(flat.tobytes()).decode(),
                "bias": float(bias),
                "temperature": float(temperature),
            }
        )

    async def refit(
        self,
        skill_key: str,
        n_examples: int,
        holdout_before: float,
        holdout_after: float,
        accepted: bool = True,
    ) -> None:
        await self._send(
            {
                "type": "refit",
                "skillKey": skill_key,
                "nExamples": n_examples,
                "holdoutBefore": holdout_before,
                "holdoutAfter": holdout_after,
                "accepted": accepted,
            }
        )

    async def proposal(
        self,
        skill_key: str,
        label: str,
        ratio_after: float,
        ratio_before: float,
        runners_up: list[str],
    ) -> None:
        """
        A better label, offered rather than applied.

        Uplinked instead of written locally because the label lives in the
        control plane, and because this is a change to what the system
        believes a skill means. The numbers travel with it so the person
        deciding can see how much better it actually measured, not just
        that something claimed to be better.
        """
        await self._send(
            {
                "type": "proposal",
                "skillKey": skill_key,
                "label": label,
                "ratioAfter": ratio_after,
                "ratioBefore": ratio_before,
                "runnersUp": runners_up,
            }
        )

    async def _send(self, msg: dict[str, Any]) -> None:
        ws = self._ws
        if ws is None:
            return
        with contextlib.suppress(Exception):
            await ws.send(json.dumps(msg))


def decode_weights(encoded: str, dim: int) -> np.ndarray:
    """Base64 float32 back to a vector, or a (K, dim) matrix for a discriminator."""
    flat = np.frombuffer(base64.b64decode(encoded), dtype=np.float32)
    return flat if flat.size == dim else flat.reshape(-1, dim)


def _parse(raw: str | bytes) -> dict[str, Any] | None:
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None
