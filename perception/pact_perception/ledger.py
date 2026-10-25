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

    def on_registry(self, cb: Callable[[list[dict[str, Any]]], None]) -> None:
        self._skills_cb = cb

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
                        elif msg.get("type") == "frame":
                            yield IncomingFrame(
                                room=str(msg.get("room", self.room)),
                                seq=int(msg.get("seq", 0)),
                                ts=float(msg.get("ts", 0)) / 1000.0,
                                jpeg=base64.b64decode(msg.get("jpegBase64", "")),
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
        self, skill_key: str, n_examples: int, holdout_before: float, holdout_after: float
    ) -> None:
        await self._send(
            {
                "type": "refit",
                "skillKey": skill_key,
                "nExamples": n_examples,
                "holdoutBefore": holdout_before,
                "holdoutAfter": holdout_after,
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
