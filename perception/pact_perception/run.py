"""
The loop. Frames in, state transitions out.

Everything else in this package is a piece that can be tested on its own;
this is the only file that knows the order they go in:

    source -> motion gate -> embed -> score every eligible skill
           -> state machine per skill -> transition up to the Engine

Three things here are less obvious than the pipeline.

The sample rate is the maximum over whatever is currently eligible, not a
constant. A gate asking "is anyone in this room" is fine twice a minute; a
bench press rep lasts two to four seconds and is simply invisible below
about 4 Hz. Running everything at the counter's rate would waste most of the
compute, and running everything at the gate's rate would make rep counting
impossible, so the rate follows the gate tree as it opens and closes.

Skills arrive without weight vectors. The Engine creates a skill from a
label because the planner lives there, but the text encoder lives here, so
the first thing this loop does with a new skill is embed its label and hand
the vector back. That is why a skill reads `pending` for a moment rather
than being broken.

The gate tree is enforced on eligibility rather than on cost. Skipping a
child skill saves one dot product, which is nothing. What it buys is that
`bottle_in_hand` cannot fire in the kitchen, and that escalation is scoped
to skills that could actually have been active.

    python -m pact_perception.run --room gym --embed stub --source camera
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import signal
import sys
import time
from dataclasses import replace
from typing import Any

import numpy as np
from PIL import Image

from . import sources
from .config import Config, load
from .embed import Embedder, LocalEmbedder, RemoteEmbedder, StubEmbedder
from .gate import MotionGate
from .ledger import Ledger, decode_weights
from .log import Logger
from .machine import Event, Params, State, initial, step
from .skills import (
    SCORED_KINDS,
    EncoderMismatch,
    Skill,
    calibrate,
    discriminate,
    loosen_for,
    score,
)

#: Background cosines kept per skill, for calibration. Twenty minutes at
#: 0.5 Hz, which is enough for a stable quantile without unbounded growth.
_CALIBRATION_WINDOW = 600

#: Recalibrate once this many samples have accumulated, then every so often
#: as the room's lighting drifts. Without this the thresholds are whatever
#: the identity transform gives, which is nothing usable.
_CALIBRATE_AFTER = 60


class Runner:
    def __init__(self, cfg: Config, log: Logger, embedder: Embedder) -> None:
        self.cfg = cfg
        self.log = log
        self.embedder = embedder
        self.ledger = Ledger(cfg.hub, cfg.room, log, cfg.token)
        self.gate = MotionGate(cfg.motion_threshold)

        self.skills: dict[str, Skill] = {}
        self.states: dict[str, State] = {}
        #: Rolling background cosines per skill, for fitting bias/temperature.
        self.history: dict[str, list[float]] = {}
        self.calibrated: set[str] = set()
        self._pending_weights: list[Skill] = []
        #: Set the first time a registry lands. A frame scored before the
        #: skills are known is a frame silently thrown away, and on a short
        #: recording that can be the whole run.
        self._ready = asyncio.Event()

        self.ledger.on_registry(self._on_registry)

    # ---------------------------------------------------------- the registry

    def _on_registry(self, rows: list[dict[str, Any]]) -> None:
        """
        Replace the local view of the skills.

        Rows whose encoder does not match ours are kept but will refuse to
        score. That is deliberate: dropping them silently would look like a
        skill that does not exist, and the distinction between "not here" and
        "fitted somewhere else" is exactly what someone debugging needs.
        """
        fresh: dict[str, Skill] = {}
        for row in rows:
            key = str(row.get("key", ""))
            if not key:
                continue
            kind = str(row.get("kind", "object"))
            params = Params(
                enter_conf=float(row.get("enterConf", 0.75)),
                exit_conf=float(row.get("exitConf", 0.45)),
                dwell_s=float(row.get("dwellS", 2.0)),
                exit_s=float(row.get("exitS", 2.0)),
                cooldown_s=float(row.get("cooldownS", 10.0)),
                escalate_after_s=float(row.get("escalateAfterS", 60.0)),
            )
            classes = row.get("classes") or []
            encoded = row.get("w")
            dim = int(row.get("dim") or self.embedder.dim)
            fresh[key] = Skill(
                key=key,
                kind=kind,
                label=str(row.get("label", "")),
                w=decode_weights(encoded, dim) if encoded else None,
                bias=float(row.get("bias", 0.0)),
                temperature=float(row.get("temperature", 1.0)),
                encoder_id=str(row.get("encoderId") or ""),
                params=loosen_for(params, int(row.get("nLabels", 0))),
                depends_on=(str(row["dependsOn"]) if row.get("dependsOn") else None),
                classes=tuple(str(c) for c in classes),
                margin=float(row.get("margin") or 0.15),
                n_labels=int(row.get("nLabels", 0)),
            )

        self.skills = fresh
        for key in list(self.states):
            if key not in fresh:
                del self.states[key]

        # Anything with no vector, or one fitted elsewhere, needs its label
        # embedded. Queued rather than done here because this callback runs
        # on the socket's task and embedding can take a second.
        self._pending_weights = [
            s
            for s in fresh.values()
            if s.kind in SCORED_KINDS
            and (s.w is None or (s.encoder_id and s.encoder_id != self.embedder.encoder_id))
        ]
        self.log.info(
            "service.start",
            detail="registry",
            skills=len(fresh),
            needing_weights=len(self._pending_weights),
        )
        self._ready.set()

    async def _fill_weights(self) -> None:
        """Embed the labels of skills that have no usable vector yet."""
        while self._pending_weights:
            skill = self._pending_weights.pop()
            texts = list(skill.classes[:-1]) if skill.kind == "discriminator" else [skill.label]
            if skill.kind == "discriminator" and "none" not in skill.classes:
                texts = list(skill.classes)
            if not texts or not any(texts):
                continue
            try:
                w = self.embedder.encode_text(texts)
            except Exception as err:  # the encoder is the one thing that may be absent
                self.log.error("service.error", detail=f"encode_text failed: {err}")
                return
            vec = w if skill.kind == "discriminator" else w[0]
            self.skills[skill.key] = replace(skill, w=vec, encoder_id=self.embedder.encoder_id)
            # bias and temperature are still the identity here; they are
            # fitted from this room's own background below, which is the only
            # way the thresholds mean anything.
            await self.ledger.weights(
                skill.key, vec, self.embedder.encoder_id, skill.bias, skill.temperature
            )
            self.log.info("embed.done", ms=0, dim=int(np.atleast_2d(vec).shape[-1]))

    # -------------------------------------------------------------- scoring

    def _eligible(self) -> list[Skill]:
        """
        Skills whose gate chain is open.

        A skill with no parent is always eligible; one with a parent is
        eligible only while that parent is active. The chain is walked rather
        than cached because it is at most a few links deep and a stale cache
        here would let a child fire in the wrong room.
        """
        out: list[Skill] = []
        for skill in self.skills.values():
            if skill.kind not in SCORED_KINDS or not skill.ready:
                continue
            parent = skill.depends_on
            open_chain = True
            hops = 0
            while parent and hops < 8:
                st = self.states.get(parent)
                if st is None or st.phase != "active":
                    open_chain = False
                    break
                parent = self.skills[parent].depends_on if parent in self.skills else None
                hops += 1
            if open_chain:
                out.append(skill)
        return out

    def _rate(self, eligible: list[Skill]) -> float:
        """The fastest rate any currently eligible skill needs."""
        hz = self.cfg.idle_hz
        for skill in eligible:
            need = 8.0 if skill.kind == "counter" else 2.0 if skill.kind != "gate" else 0.5
            hz = max(hz, need)
        return min(hz, self.cfg.max_hz)

    async def _on_frame(self, image: Any, seq: int, now: float, source: str) -> float:
        """Score one frame. Returns the sample rate the next one should use."""
        self.log.debug("frame.sampled", seq=seq, source=source)

        motion = self.gate.check(image)
        if not motion.passed:
            # The cheapest possible outcome: no embedding, no scores, nothing
            # sent. An empty room should cost nothing.
            self.log.debug(
                "frame.gated", reason="motion below threshold", moved=round(motion.moved, 4)
            )
            return self.cfg.idle_hz

        embedding = self.embedder.encode_image(image)
        self.log.debug("embed.done", ms=round(embedding.ms, 1), dim=embedding.dim)

        eligible = self._eligible()
        for skill in eligible:
            await self._score_one(skill, embedding.vector, now)
        return self._rate(self._eligible())

    async def _score_one(self, skill: Skill, e: np.ndarray, now: float) -> None:
        try:
            if skill.kind == "discriminator":
                dist = discriminate(skill, e, self.embedder.encoder_id)
                value = dist.p1
                self.log.info(
                    "discriminator.margin",
                    skill=skill.key,
                    top=dist.top,
                    p1=round(dist.p1, 4),
                    runner_up=dist.runner_up,
                    p2=round(dist.p2, 4),
                    margin=round(dist.margin, 4),
                    ok=dist.margin >= skill.margin,
                )
            else:
                value = score(skill, e, self.embedder.encoder_id)
        except EncoderMismatch as err:
            self.log.warn("service.error", skill=skill.key, detail=str(err))
            return

        self._remember(skill, e)
        self.log.trace("skill.score", skill=skill.key, score=round(value, 4))

        state = self.states.get(skill.key, initial(now))
        nxt, event = step(state, value, now, skill.params)
        self.states[skill.key] = nxt
        if event is not None:
            await self._emit(skill, event)

    def _remember(self, skill: Skill, e: np.ndarray) -> None:
        """
        Keep this skill's raw cosines, and fit the calibration once there are
        enough of them.

        Without this the score is sigmoid of a raw cosine, which lands every
        frame between 0.47 and 0.60 and makes an enter threshold of 0.75
        literally unreachable. The numbers have to come from this room.
        """
        if skill.w is None or skill.kind == "discriminator":
            return
        cos = float(np.dot(skill.w, e))
        hist = self.history.setdefault(skill.key, [])
        hist.append(cos)
        if len(hist) > _CALIBRATION_WINDOW:
            del hist[0 : len(hist) - _CALIBRATION_WINDOW]

        if len(hist) < _CALIBRATE_AFTER or skill.key in self.calibrated:
            return
        bias, temperature = calibrate(
            np.asarray(hist),
            enter_conf=skill.params.enter_conf,
            exit_conf=skill.params.exit_conf,
        )
        self.skills[skill.key] = replace(skill, bias=bias, temperature=temperature)
        self.calibrated.add(skill.key)
        self.log.info(
            "probe.refit",
            skill=skill.key,
            n_examples=len(hist),
            holdout_before=0.0,
            holdout_after=0.0,
            bias=round(bias, 5),
            temperature=round(temperature, 6),
        )

    async def _emit(self, skill: Skill, event: Event) -> None:
        """
        Send one transition up, and rotate the trace on a session boundary.

        A gate opening starts a span and a gate closing ends one, which is
        what makes grepping a single trace id reconstruct a whole story
        rather than an arbitrary slice of the day.
        """
        if skill.kind == "gate" and event.kind in ("entered", "exited"):
            self.log.rotate()

        if event.kind == "rejected":
            self.log.info(
                "skill.rejected",
                skill=skill.key,
                peak=round(event.peak, 4),
                held_ms=event.held_ms,
                needed_ms=event.needed_ms,
            )
        else:
            self.log.info(
                "skill.transition",
                skill=skill.key,
                **{"from": "candidate" if event.kind == "entered" else "active"},
                to=event.kind,
                reason=event.reason,
                score=round(event.score, 4),
                dwell_ms=event.dwell_ms or event.duration_ms,
            )

        await self.ledger.transition(
            {
                "skillKey": skill.key,
                "kind": event.kind,
                "at": int(event.at * 1000),
                "room": self.cfg.room,
                "traceId": self.log.trace_id,
                "score": event.score,
                "reason": event.reason,
                "dwellMs": event.dwell_ms,
                "durationMs": event.duration_ms,
                "heldMs": event.held_ms,
                "neededMs": event.needed_ms,
                "peak": event.peak,
                "count": event.count,
            }
        )

    # ------------------------------------------------------------- the loops

    async def run_relay(self) -> None:
        """Frames arrive from the Engine; the browser owns the clock."""
        async for frame in self.ledger.connect(self.embedder.encoder_id, self.embedder.dim):
            await self._fill_weights()
            with Image.open(io.BytesIO(frame.jpeg)) as im:
                image = im.convert("RGB")
            await self._on_frame(image, frame.seq, frame.ts or time.time(), "relay")

    async def run_local(self, source: Any) -> None:
        """We own the clock: a folder or a camera, paced by the skills."""
        socket = asyncio.create_task(self._hold_socket())
        try:
            # Wait for the registry rather than racing it. If the Engine is
            # unreachable this proceeds anyway after a moment, so a local
            # tuning run still works with no control plane at all.
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._ready.wait(), timeout=10.0)
            if not self._ready.is_set():
                self.log.warn("service.error", detail="no registry; scoring nothing")

            async for frame in source.frames():
                await self._fill_weights()
                hz = await self._on_frame(frame.image, frame.seq, frame.ts, source.name)
                source.set_rate(hz)
        finally:
            socket.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await socket

    async def _hold_socket(self) -> None:
        """Keep the Engine socket open while a local source drives the loop."""
        async for _ in self.ledger.connect(self.embedder.encoder_id, self.embedder.dim):
            pass


def build_embedder(cfg: Config, log: Logger) -> Embedder:
    if cfg.embed == "remote":
        assert cfg.embed_url is not None
        return RemoteEmbedder(cfg.embed_url, cfg.encoder_id)
    if cfg.embed == "stub":
        log.warn(
            "service.start",
            detail="STUB ENCODER: scores are meaningless. Wiring only, no detection.",
        )
        return StubEmbedder(resolution=cfg.resolution)
    return LocalEmbedder(version=cfg.model_version, adaptor=cfg.adaptor, resolution=cfg.resolution)


async def main(argv: list[str] | None = None) -> int:
    cfg = load(argv)
    log = Logger(cfg.room, level=cfg.level, trace_skills=cfg.trace_skills)
    log.info(
        "service.start",
        detail="perception",
        source=cfg.source,
        embed=cfg.embed,
        hub=cfg.hub,
        resolution=cfg.resolution,
    )

    try:
        embedder = build_embedder(cfg, log)
    except Exception as err:  # a missing torch or checkpoint lands here
        log.error("service.error", detail=f"could not build the encoder: {err}")
        return 1

    runner = Runner(cfg, log, embedder)

    stop = asyncio.Event()
    with contextlib.suppress(NotImplementedError, AttributeError):
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)

    if cfg.source == "relay":
        work = asyncio.create_task(runner.run_relay())
    else:
        source = sources.build(
            cfg.source,
            folder=cfg.folder,
            camera_index=cfg.camera_index,
            hz=cfg.idle_hz,
            loop=cfg.loop_folder,
        )
        work = asyncio.create_task(runner.run_local(source))

    done, _ = await asyncio.wait(
        {work, asyncio.create_task(stop.wait())}, return_when=asyncio.FIRST_COMPLETED
    )
    work.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await work

    for task in done:
        if task is work and task.exception() is not None:
            log.error("service.error", detail=str(task.exception()))
            return 1

    log.info("service.stop", detail="perception")
    return 0


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        sys.exit(asyncio.run(main()))
