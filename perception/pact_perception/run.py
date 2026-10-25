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
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
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
from .probe import MIN_EXAMPLES, refit
from .skills import (
    SCORED_KINDS,
    EncoderMismatch,
    Skill,
    applies_to,
    calibrate,
    discriminate,
    loosen_for,
    score,
)
from .store import Store
from .teacher import FRAMES_PER_CALL, Teacher

#: Background cosines kept per skill, for calibration. Twenty minutes at
#: 0.5 Hz, which is enough for a stable quantile without unbounded growth.
_CALIBRATION_WINDOW = 600

#: Enough samples for a stable high quantile. A skill is not scored before
#: this, because an uncalibrated score sits at ~0.5 for every frame.
_CALIBRATE_AFTER = 60

#: A provisional fit, much earlier, so a skill starts working in seconds
#: rather than minutes. Twenty samples is a poor estimate of a 98th
#: percentile and it is refined at _CALIBRATE_AFTER, but "slightly wrong and
#: running" beats "perfect and silent" by a wide margin when someone is
#: standing in front of the camera waiting to see whether it noticed them.
_PROVISIONAL_AFTER = 20

#: How often a room ships its score snapshot to the console. Four a second
#: is already past what anyone reads off a moving line.
_SNAPSHOT_EVERY_S = 0.25


def rebanded_keys(
    before: Mapping[str, Skill], after: Mapping[str, Skill]
) -> set[str]:
    """
    Keys whose enter/exit band moved between two registry snapshots.

    Bias and temperature are solved *for* a particular band, so a skill whose
    thresholds were edited is carrying a fit aimed at thresholds that are no
    longer there. Returning the key tells the caller to drop the fit and let
    perception measure the background again. A skill that is new, or gone, is
    not rebanded: there is no previous band to have moved away from.
    """
    return {
        key
        for key, now in after.items()
        if (was := before.get(key)) is not None
        and (
            was.params.enter_conf != now.params.enter_conf
            or was.params.exit_conf != now.params.exit_conf
        )
    }


@dataclass
class Room:
    """
    Everything that is per-camera rather than per-skill.

    One worker watches the whole wall - it connects with room "*" and the
    Engine fans every camera's frames to it - so none of this can be global.
    Two cameras sharing one set of state machines would interleave their
    scores into the same dwell timers and credit a session that neither
    camera actually saw. The skills and their weights ARE shared, which is
    the point of the design; what is not shared is where each camera
    currently is in its own state machine.
    """

    gate: MotionGate
    #: What this room last sent: "camera" or "screen". A device is one or the
    #: other for the life of its publish, so this is effectively fixed, but it
    #: is read off the frames rather than configured because the publisher is
    #: the only party that actually knows.
    surface: str = "camera"
    #: Last rate we asked this room's publisher for, so it is sent on change
    #: rather than on every frame.
    asked_hz: float = 0.0
    #: This frame's score per skill, rebuilt each frame and sent as one
    #: snapshot. Per-skill messages would be N times the traffic for a
    #: picture that is only ever read all at once.
    snapshot: dict[str, Any] = field(default_factory=dict)
    last_sent: float = 0.0
    #: Last (top class, decisive?) per discriminator, so an unchanged verdict
    #: can stay quiet instead of repeating itself every frame.
    verdicts: dict[str, tuple[str, bool]] = field(default_factory=dict)

    #: How many times each skill has been calibrated. Two, then never.
    refits: dict[str, int] = field(default_factory=dict)
    states: dict[str, State] = field(default_factory=dict)
    history: dict[str, list[float]] = field(default_factory=dict)
    calibrated: set[str] = field(default_factory=set)
    warming: set[str] = field(default_factory=set)
    recent: deque[tuple[float, Any]] = field(
        default_factory=lambda: deque(maxlen=FRAMES_PER_CALL * 3)
    )


class Runner:
    def __init__(self, cfg: Config, log: Logger, embedder: Embedder) -> None:
        self.cfg = cfg
        self.log = log
        self.embedder = embedder
        self.ledger = Ledger(cfg.hub, cfg.room, log, cfg.token)
        self.store = Store(cfg.store_path, retain_days=cfg.retain_days)
        #: room name -> its own gate, state machines and recent frames.
        self.rooms: dict[str, Room] = {}

        # The teacher is optional. Without a key everything still runs; it
        # just never escalates, and the mid-band cases go unresolved rather
        # than failing. A missing credential should degrade, not stop.
        self.teacher = Teacher(cfg.nebius_key, log, cfg.teacher_model) if cfg.nebius_key else None

        self.skills: dict[str, Skill] = {}
        #: Keys whose freshly fitted calibration still has to be sent up.
        #: Queued because _remember runs inside the scoring path and must not
        #: await on a socket.
        self._pending_calibration: list[str] = []
        #: Skills that gained a label and may now be worth refitting. Queued
        #: because labels arrive on the socket task and a refit is not quick.
        self._pending_labels: list[str] = []
        self._pending_weights: list[Skill] = []
        #: Set the first time a registry lands. A frame scored before the
        #: skills are known is a frame silently thrown away, and on a short
        #: recording that can be the whole run.
        self._ready = asyncio.Event()
        #: Set when the registry changes, so labels get embedded off the
        #: scoring path instead of waiting for a frame that may never come.
        self._registry_changed = asyncio.Event()

        self.ledger.on_registry(self._on_registry)
        self.ledger.on_label(self._on_label)

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
                min_cycle_s=float(row.get("minCycleS", 0.0)),
            )
            classes = row.get("classes") or []
            encoded = row.get("w")
            dim = int(row.get("dim") or self.embedder.dim)
            fresh[key] = Skill(
                key=key,
                kind=kind,
                label=str(row.get("label", "")),
                surface=str(row.get("surface") or "any"),
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

        rebanded = rebanded_keys(self.skills, fresh)
        self.skills = fresh
        for room in self.rooms.values():
            for key in list(room.states):
                if key not in fresh:
                    del room.states[key]
            for key in rebanded:
                room.calibrated.discard(key)
                room.refits.pop(key, None)
        if rebanded:
            self.log.info(
                "probe.refit",
                detail="band moved, recalibrating",
                skills=len(rebanded),
            )

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
        self._registry_changed.set()

    def _on_label(self, skill_key: str, at: float, label: int, source: str) -> None:
        """
        Record an answer against the frame it was about.

        Attached by proximity, because an answer arrives seconds after the
        thing it describes and nobody hands it a frame timestamp. A label
        with no frame within the tolerance is dropped rather than pinned to
        whatever happened to be nearest, which would teach the skill a
        picture of something else.
        """
        skill = self.skills.get(skill_key)
        if skill is None:
            return
        frame_ts = self.store.nearest_frame_ts(at, tolerance=30.0)
        if frame_ts is None:
            self.log.warn(
                "question.answered",
                skill=skill_key,
                detail="no frame near that moment; label dropped",
            )
            return
        self.store.label(skill_key, frame_ts, label, source)
        self.log.info(
            "question.answered", skill=skill_key, detail=f"labelled {label} by {source}"
        )
        self._pending_labels.append(skill_key)

    async def _flush_calibration(self) -> None:
        while self._pending_calibration:
            skill = self.skills.get(self._pending_calibration.pop())
            if skill is None or skill.w is None:
                continue
            await self.ledger.weights(
                skill.key,
                skill.w,
                self.embedder.encoder_id,
                skill.bias,
                skill.temperature,
            )

    async def _embed_labels(self) -> None:
        """
        Embed labels as soon as the registry names them.

        A vector is the encoded label and nothing else, so it needs no frame.
        Embedding inside the frame loop meant a wall with no camera on it
        never embedded at all, and the first frames after a camera appeared
        were spent on nine encoder calls rather than on scoring.
        """
        while True:
            await self._registry_changed.wait()
            self._registry_changed.clear()
            await self._fill_weights()

    async def _flush_labels(self) -> None:
        while self._pending_labels:
            skill = self.skills.get(self._pending_labels.pop())
            if skill is not None:
                await self._maybe_refit(skill)

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

    def room(self, name: str) -> Room:
        """The state for one camera, created the first time it sends a frame."""
        room = self.rooms.get(name)
        if room is None:
            room = Room(gate=MotionGate(self.cfg.motion_threshold))
            self.rooms[name] = room
            self.log.info("service.start", detail="watching", room=name)
        return room

    def _eligible(self, room: Room, surface: str = "any") -> list[Skill]:
        """
        Skills whose gate chain is open, and which are about this surface.

        A skill with no parent is always eligible; one with a parent is
        eligible only while that parent is active. The chain is walked rather
        than cached because it is at most a few links deep and a stale cache
        here would let a child fire in the wrong room.

        The surface test is the same idea one level up. A screen skill has no
        business scoring a bathroom camera, and the reason to enforce it is
        not the wrong answer - which would be a harmlessly low score - but
        that scoring also calibrates. See `skills.applies_to`.
        """
        out: list[Skill] = []
        for skill in self.skills.values():
            if skill.kind not in SCORED_KINDS or not skill.ready:
                continue
            if not applies_to(skill, surface):
                continue
            parent = skill.depends_on
            open_chain = True
            hops = 0
            while parent and hops < 8:
                st = room.states.get(parent)
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
            need = 12.0 if skill.kind == "counter" else 2.0 if skill.kind != "gate" else 0.5
            hz = max(hz, need)
        return min(hz, self.cfg.max_hz)

    async def _on_frame(
        self,
        image: Any,
        seq: int,
        now: float,
        source: str,
        room_name: str,
        surface: str = "camera",
    ) -> float:
        """Score one frame. Returns the sample rate the next one should use."""
        room = self.room(room_name)
        room.surface = surface
        self.log.debug("frame.sampled", seq=seq, source=source, room=room_name, surface=surface)

        motion = room.gate.check(image)
        # A motion gate cannot see a person standing still, and that is
        # exactly when it matters most: once a session is open, frames are
        # what decide when it ends. Gating them would let the score sag
        # unobserved and then report a near-miss for a thing that was in
        # fact happening the whole time. So the gate only guards the idle
        # case, which is the case it was there to make cheap.
        busy = any(st.phase != "idle" for st in room.states.values())
        # A screen is never gated here. The gate's premise - that stillness
        # means nothing is happening - is true of a room and false of a
        # screen, where reading a page motionlessly for twenty minutes is the
        # behaviour a goal most wants to credit. The publisher has already
        # throttled a still screen to a slow heartbeat, so the saving is
        # taken there, where it is a slowdown rather than a blindfold.
        if not motion.passed and not busy and surface != "screen":
            # The cheapest possible outcome: no embedding, no scores, nothing
            # sent. An empty room should cost nothing.
            self.log.debug(
                "frame.gated", reason="motion below threshold", moved=round(motion.moved, 4)
            )
            return self.cfg.idle_hz

        embedding = self.embedder.encode_image(image)
        self.log.debug("embed.done", ms=round(embedding.ms, 1), dim=embedding.dim)

        # Both of these exist for the labelling loop rather than for
        # debugging. The image is what a teacher call sends; the embedding is
        # what a label is eventually fitted against. Discarding either would
        # mean an answer taught the system nothing.
        room.recent.append((now, image))
        self.store.remember_frame(now, embedding.vector, self.embedder.encoder_id)

        for skill in self._eligible(room, surface):
            await self._score_one(skill, embedding.vector, now, room, room_name)

        # One snapshot per frame, capped: a console redraws at human speed,
        # and 8 Hz of socket traffic per camera buys nothing a person can see.
        if room.snapshot and now - room.last_sent >= _SNAPSHOT_EVERY_S:
            room.last_sent = now
            await self.ledger.scores(
                room_name, self._rate(self._eligible(room, surface)), dict(room.snapshot)
            )

        hz = self._rate(self._eligible(room, surface))
        if abs(hz - room.asked_hz) > 1e-6:
            # The publisher owns its clock, so this is a request, not a
            # command. Sent only on change: a counter going eligible is the
            # moment the rate has to jump, and every frame in between would
            # be the same number repeated.
            room.asked_hz = hz
            await self.ledger.rate(room_name, hz)
            self.log.info("service.start", detail="rate", room=room_name, hz=hz)
        return hz

    async def _score_one(
        self, skill: Skill, e: np.ndarray, now: float, room: Room, room_name: str
    ) -> None:
        try:
            if skill.kind == "discriminator":
                dist = discriminate(skill, e, self.embedder.encoder_id)
                value = dist.detection
                # A verdict that has not changed is not news. This fired at
                # INFO on every frame for every discriminator - 1,877 lines
                # in one session, drowning the events worth reading, and
                # paying a JSON encode and a write inside the sampling loop
                # that the frame rate was being measured against. The same
                # argument that keeps skill.score at TRACE applies here.
                verdict = (dist.top, dist.margin >= skill.margin)
                changed = room.verdicts.get(skill.key) != verdict
                room.verdicts[skill.key] = verdict
                emit = self.log.info if changed else self.log.debug
                emit(
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

        self._remember(skill, e, room)
        self.log.trace("skill.score", skill=skill.key, score=round(value, 4))
        phase = room.states.get(skill.key)
        room.snapshot[skill.key] = {
            "score": round(value, 4),
            "phase": phase.phase if phase else "idle",
        }
        state_now = room.states.get(skill.key)
        self.store.observe(
            skill.key,
            now,
            value,
            float(np.dot(np.atleast_2d(skill.w)[0], e)) if skill.w is not None else 0.0,
            state_now.phase if state_now else "idle",
        )

        # An uncalibrated skill must not drive its state machine. With bias at
        # zero and temperature at one, sigmoid of a cosine returns about 0.5
        # for literally every frame, so any enter_conf below 0.5 fires on the
        # first frame and any above it never fires at all. Either way the
        # event is an artefact of the identity transform rather than anything
        # seen. Observed for real: a session opened at 0.506 before the first
        # calibration landed, then could not close because the post-fit scores
        # straddled exit_conf. Collect the background first, then start.
        # Every kind waits for its calibration, discriminators included. They
        # used to be exempt, which meant they ran their state machine on a
        # flat softmax and reported a margin of effectively zero forever.
        if skill.key not in room.calibrated:
            room.warming.add(skill.key)
            return

        state = room.states.get(skill.key, initial(now))
        nxt, event = step(state, value, now, skill.params)
        room.states[skill.key] = nxt
        if event is None:
            return
        if event.kind == "escalate":
            await self._escalate(skill, event, now, room, room_name)
            return
        await self._emit(skill, event, room_name=room_name)

    async def _escalate(
        self, skill: Skill, event: Event, now: float, room: Room, room_name: str
    ) -> None:
        """
        Spend a teacher call on a case the thresholds could not settle.

        The verdict does two separate jobs and it is worth keeping them
        apart. It resolves this occurrence, so the transition goes up marked
        verdict_by=vlm rather than being lost. And it becomes a label, which
        is the only reason the same ambiguity costs less next time.

        An UNSURE answer is a real answer, not a failure: it means the frames
        genuinely do not show it, and the question belongs to a person. A
        failed call is different and is reported as an error.
        """
        if self.teacher is None:
            self.log.warn(
                "service.error",
                skill=skill.key,
                detail="would escalate, but no NEBIUS_API_KEY",
            )
            await self._emit(skill, event, room_name=room_name)
            return

        frames = [img for _, img in list(room.recent)[-FRAMES_PER_CALL:]]
        verdict = await asyncio.to_thread(
            self.teacher.adjudicate,
            skill.label,
            frames,
            skill.classes,
            room.surface,
            self._context_for(skill),
        )
        if verdict is None:
            await self._emit(skill, event, room_name=room_name)
            return

        label = verdict.label
        if label is not None:
            # Attach the label to the frame it describes, not to the moment
            # the answer came back - the two are seconds apart.
            frame_ts = self.store.nearest_frame_ts(now, tolerance=30.0)
            if frame_ts is not None:
                self.store.label(skill.key, frame_ts, label, "vlm")
                await self._maybe_refit(skill)

        if label == 1:
            # The teacher says yes, so credit it as a session the camera
            # alone could not close. settled_by will read vlm, which is the
            # whole point of keeping that column.
            await self._emit(
                skill,
                replace(event, kind="entered", reason=f"teacher: {verdict.reason}"[:120]),
                verdict_by="vlm",
                room_name=room_name,
            )
            return

        await self._emit(
            skill,
            replace(event, kind="rejected", reason=f"teacher: {verdict.reason}"[:120]),
            verdict_by="vlm" if label == 0 else None,
            room_name=room_name,
        )

    def _context_for(self, skill: Skill) -> str:
        """
        The labels of the gates above this skill, outermost first.

        A child only ever escalates while its whole chain is open, so these
        are facts the cheap layer has already settled. Handing them to the
        teacher narrows "is this person writing Python" to the part that is
        genuinely undecided, given that a code editor is known to be on
        screen. The walk is bounded the same way `_eligible` bounds its own,
        because a registry with a cycle in it should degrade rather than hang.
        """
        chain: list[str] = []
        parent = skill.depends_on
        hops = 0
        while parent and hops < 8:
            above = self.skills.get(parent)
            if above is None:
                break
            if above.label:
                chain.append(above.label)
            parent = above.depends_on
            hops += 1
        return "; ".join(reversed(chain))

    async def _maybe_refit(self, skill: Skill) -> None:
        """
        Refit this skill's probe if there are enough labels to try.

        Reported whether or not it helped, and discarded when it does not.
        A refit that cannot beat zero-shot on frames it never saw is not an
        improvement, and shipping it anyway would make the holdout number
        decoration rather than evidence.
        """
        if skill.w is None:
            return
        examples = self.store.examples(skill.key, self.embedder.encoder_id)
        if len(examples) < MIN_EXAMPLES:
            return

        x = np.stack([ex.embedding for ex in examples])
        y = np.asarray([ex.label for ex in examples])
        result = await asyncio.to_thread(
            refit,
            x,
            y,
            np.atleast_2d(skill.w)[0],
            skill.bias,
            skill.temperature,
        )

        self.log.info(
            "probe.refit",
            skill=skill.key,
            n_examples=result.n_examples,
            holdout_before=round(result.holdout_before, 4),
            holdout_after=round(result.holdout_after, 4),
            accepted=result.accepted,
            why=result.why,
        )
        if not result.accepted:
            return

        self.skills[skill.key] = replace(
            skill, w=result.w, bias=result.bias, temperature=result.temperature
        )
        # The fit chose its own sharpness, so the calibration fitted from
        # background is superseded here rather than kept alongside.
        for r in self.rooms.values():
            r.calibrated.add(skill.key)
        await self.ledger.weights(
            skill.key,
            result.w,
            self.embedder.encoder_id,
            result.bias,
            result.temperature,
        )
        await self.ledger.refit(
            skill.key, result.n_examples, result.holdout_before, result.holdout_after
        )

    def _remember(self, skill: Skill, e: np.ndarray, room: Room) -> None:
        """
        Keep this skill's raw cosines, and fit the calibration once there are
        enough of them.

        Without this the score is sigmoid of a raw cosine, which lands every
        frame between 0.47 and 0.60 and makes an enter threshold of 0.75
        literally unreachable. The numbers have to come from this room.
        """
        if skill.w is None:
            return

        if skill.kind == "discriminator":
            # A discriminator needs calibrating too, and skipping it here is
            # why one could never decide anything. Its logits are raw cosines,
            # and sibling classes - which are siblings precisely because they
            # look alike - sit within about 0.001 of each other. A softmax
            # over that is flat, so every margin came out near zero and the
            # verdict was permanently "I cannot tell".
            #
            # What needs scaling is the SPREAD BETWEEN classes, not the
            # distance from a background, so this fits on the gap between the
            # best and second-best class rather than on a quantile.
            w = np.atleast_2d(skill.w)
            gaps = np.sort(w @ e)[::-1]
            gap = float(gaps[0] - gaps[1]) if gaps.size > 1 else 0.0
            hist = room.history.setdefault(skill.key, [])
            hist.append(abs(gap))
            if len(hist) > _CALIBRATION_WINDOW:
                del hist[0 : len(hist) - _CALIBRATION_WINDOW]

            done = room.refits.get(skill.key, 0)
            if done >= 2 or len(hist) < (_PROVISIONAL_AFTER if done == 0 else _CALIBRATE_AFTER):
                return
            room.refits[skill.key] = done + 1
            # Set the temperature so a typical gap becomes a decisive logit
            # difference. The margin threshold on the skill row then means
            # what it says rather than being unreachable.
            typical = float(np.quantile(np.asarray(hist), 0.9)) or 1e-4
            temperature = max(typical / 2.2, 1e-5)
            self.skills[skill.key] = replace(skill, bias=0.0, temperature=temperature)
            room.calibrated.add(skill.key)
            self._pending_calibration.append(skill.key)
            self.log.info(
                "probe.refit",
                skill=skill.key,
                provisional=done == 0,
                n_examples=len(hist),
                holdout_before=0.0,
                holdout_after=0.0,
                temperature=round(temperature, 6),
                typical_gap=round(typical, 5),
            )
            return

        cos = float(np.dot(skill.w, e))
        hist = room.history.setdefault(skill.key, [])
        hist.append(cos)
        if len(hist) > _CALIBRATION_WINDOW:
            del hist[0 : len(hist) - _CALIBRATION_WINDOW]

        # Log progress. Without this, "collecting background" and "broken"
        # look identical from outside for minutes at a time.
        n = len(hist)
        if n in (5, 10, _PROVISIONAL_AFTER, 40, _CALIBRATE_AFTER):
            self.log.info(
                "service.start",
                detail="calibrating",
                skill=skill.key,
                have=n,
                needs=_PROVISIONAL_AFTER if n < _PROVISIONAL_AFTER else _CALIBRATE_AFTER,
            )

        # Exactly two fits per skill: a provisional one so it starts working
        # in seconds, and a final one once the background is properly
        # sampled. An earlier version re-fitted on every frame past the
        # threshold, rewriting the calibration and pushing weights up the
        # socket at the full frame rate.
        done = room.refits.get(skill.key, 0)
        if done == 0 and n < _PROVISIONAL_AFTER:
            return
        if done == 1 and n < _CALIBRATE_AFTER:
            return
        if done >= 2:
            return
        provisional = done == 0
        room.refits[skill.key] = done + 1
        bias, temperature = calibrate(
            np.asarray(hist),
            enter_conf=skill.params.enter_conf,
            exit_conf=skill.params.exit_conf,
        )
        self.skills[skill.key] = replace(skill, bias=bias, temperature=temperature)
        room.calibrated.add(skill.key)
        room.warming.discard(skill.key)
        self.log.info(
            "probe.refit",
            skill=skill.key,
            provisional=provisional,
            n_examples=n,
            holdout_before=0.0,
            holdout_after=0.0,
            bias=round(bias, 5),
            temperature=round(temperature, 6),
        )
        # Send it up, or every restart throws away the calibration and spends
        # another minute collecting background before it can score anything.
        self._pending_calibration.append(skill.key)

    async def _emit(
        self,
        skill: Skill,
        event: Event,
        verdict_by: str | None = None,
        room_name: str | None = None,
    ) -> None:
        """
        Send one transition up, and rotate the trace on a session boundary.

        `room_name` is the camera this happened in, which is not the same as
        the worker's own room: a worker watching the whole wall registers as
        "*", and recording every transition against "*" would lose which
        camera actually saw it.

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
                needed_conf=event.needed_conf,
                reason=event.reason,
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
                "room": room_name or self.cfg.room,
                "traceId": self.log.trace_id,
                "score": event.score,
                "reason": event.reason,
                "dwellMs": event.dwell_ms,
                "durationMs": event.duration_ms,
                "heldMs": event.held_ms,
                "neededMs": event.needed_ms,
                "neededConf": event.needed_conf,
                "peak": event.peak,
                "count": event.count,
                # Set only when a teacher call resolved this. That column is
                # the whole trust model: camera, vlm, or human.
                "verdictBy": verdict_by,
            }
        )

    # ------------------------------------------------------------- the loops

    async def run_sfu(self) -> None:
        """
        Subscribe to every camera on the wall and sample each of them.

        Three concurrent jobs: hold the Engine socket, follow the Hub's live
        device list, and sample whatever is currently subscribed. They are
        separate because each fails independently - losing the Hub socket
        should not drop the video, and losing one camera should not stop the
        others.
        """
        from .sfu import SfuSource

        source = SfuSource(self.cfg.hub, self.log, hz=self.cfg.idle_hz)
        engine = asyncio.create_task(self._hold_socket())
        embed = asyncio.create_task(self._embed_labels())

        async def follow() -> None:
            while True:
                try:
                    async for devices in source.devices():
                        await source.reconcile(devices)
                        self.log.info(
                            "service.start",
                            detail="wall",
                            devices=[d.name for d in devices],
                        )
                except asyncio.CancelledError:
                    raise
                except Exception as err:
                    self.log.warn("service.error", detail=f"hub socket lost: {err}")
                    await asyncio.sleep(3.0)

        watch = asyncio.create_task(follow())
        try:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._ready.wait(), timeout=15.0)
            async for room_name, surface, frame in source.frames():
                await self._fill_weights()
                await self._flush_calibration()
                await self._flush_labels()
                hz = await self._on_frame(
                    frame.image, frame.seq, frame.ts, source.name, room_name, surface
                )
                # One rate for the whole source: it polls every subscription
                # on one clock, so the fastest room sets the pace.
                source.set_rate(hz)
        finally:
            for task in (engine, watch, embed):
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            await source.aclose()

    async def run_relay(self) -> None:
        """Frames arrive from the Engine; the browser owns the clock."""
        embed = asyncio.create_task(self._embed_labels())
        try:
            async for frame in self.ledger.connect(self.embedder.encoder_id, self.embedder.dim):
                await self._fill_weights()
                await self._flush_calibration()
                await self._flush_labels()
                with Image.open(io.BytesIO(frame.jpeg)) as im:
                    image = im.convert("RGB")
                await self._on_frame(
                    image,
                    frame.seq,
                    frame.ts or time.time(),
                    "relay",
                    frame.room,
                    frame.surface,
                )
        finally:
            embed.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await embed

    async def run_local(self, source: Any) -> None:
        """We own the clock: a folder or a camera, paced by the skills."""
        socket = asyncio.create_task(self._hold_socket())
        embed = asyncio.create_task(self._embed_labels())
        try:
            # Wait for the registry rather than racing it. If the Engine is
            # unreachable this proceeds anyway after a moment, so a local
            # tuning run still works with no control plane at all.
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._ready.wait(), timeout=10.0)
            if not self._ready.is_set():
                self.log.warn("service.error", detail="no registry; scoring nothing")

            async for frame in source.frames():
                await self._flush_calibration()
                await self._flush_labels()
                hz = await self._on_frame(
                    frame.image, frame.seq, frame.ts, source.name, self.cfg.room, self.cfg.surface
                )
                source.set_rate(hz)
        finally:
            for task in (socket, embed):
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

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

    if cfg.source == "sfu":
        work = asyncio.create_task(runner.run_sfu())
    elif cfg.source == "relay":
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
