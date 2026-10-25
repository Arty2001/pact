"""
The escalation wiring: escalate -> teacher -> label -> refit.

Tested with fakes rather than by coaxing a real trace into a mid-band
plateau. Getting a stub encoder to linger between two thresholds for long
enough depends on the calibration, the footage and the thresholds all
lining up, which makes for a test that passes by luck. What actually needs
checking is the handling: that a YES becomes a credited session, a NO
becomes a rejection, an UNSURE becomes neither, and that every answer except
UNSURE is written down as a label.

The teacher itself is verified separately against the live model.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace
from typing import Any

import numpy as np
import pytest
from PIL import Image

from pact_perception.config import Config
from pact_perception.log import Logger
from pact_perception.machine import Event, Params, initial
from pact_perception.skills import Skill
from pact_perception.teacher import Verdict

DIM = 16
ENCODER = "stub/none@384"


def config(tmp_path: Any, key: str | None = "fake-key") -> Config:
    return Config(
        room="gym",
        hub="http://localhost:1",
        token=None,
        source="folder",
        folder=str(tmp_path),
        camera_index=0,
        loop_folder=False,
        embed="stub",
        embed_url=None,
        model_version="stub",
        adaptor="none",
        resolution=384,
        device="cpu",
        idle_hz=1.0,
        max_hz=8.0,
        motion_threshold=0.012,
        nebius_key=key,
        teacher_model="fake",
        store_path=str(tmp_path / "store.db"),
        retain_days=1.0,
        level="error",
    )


class FakeEmbedder:
    encoder_id = ENCODER
    dim = DIM

    def encode_image(self, image: Image.Image) -> Any:  # pragma: no cover
        raise NotImplementedError

    def encode_text(self, texts: list[str]) -> np.ndarray:
        return np.tile(np.eye(DIM)[0], (len(texts), 1))


@dataclass
class FakeTeacher:
    """Records what it was asked and returns a scripted verdict."""

    verdict: Verdict | None
    calls: list[tuple[str, int]] = None  # type: ignore[assignment]
    #: (surface, context) of each call, which is what tells a screen
    #: escalation apart from a camera one.
    asked: list[tuple[str, str]] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        self.calls = []
        self.asked = []

    def adjudicate(
        self,
        label: str,
        frames: list[Image.Image],
        classes: tuple[str, ...] = (),
        surface: str = "camera",
        context: str = "",
    ) -> Verdict | None:
        self.calls.append((label, len(frames)))
        self.asked.append((surface, context))
        return self.verdict


def verdict(answer: str) -> Verdict:
    return Verdict(
        answer=answer,
        confidence=0.9 if answer != "UNSURE" else 0.0,
        reason="scripted",
        ms=1.0,
        usd=0.0006,
        prompt_tokens=1000,
        completion_tokens=100,
        reasoning_tokens=0,
    )


def runner_with(tmp_path: Any, teacher: FakeTeacher | None, key: str | None = "k") -> Any:
    from pact_perception.run import Runner

    cfg = config(tmp_path, key)
    r = Runner(cfg, Logger("gym", level="error"), FakeEmbedder())
    r.teacher = teacher
    r.sent = []

    # The socket is never opened in these tests, so capture what would have
    # gone up the wire instead of trying to stand up an Engine.
    async def capture(payload: dict[str, Any]) -> None:
        r.sent.append(payload)

    r.ledger.transition = capture  # type: ignore[assignment]

    async def noop(*args: Any, **kwargs: Any) -> None:
        return None

    r.ledger.weights = noop  # type: ignore[assignment]
    r.ledger.refit = noop  # type: ignore[assignment]
    return r


def a_skill() -> Skill:
    return Skill(
        key="applied_to_face",
        kind="action",
        label="a person applying product to their face",
        w=np.eye(DIM)[0],
        bias=0.1,
        temperature=0.05,
        encoder_id=ENCODER,
        params=Params(escalate_after_s=1.0),
    )


def an_escalation(now: float = 100.0) -> Event:
    return Event(
        kind="escalate",
        at=now,
        score=0.6,
        reason="held between thresholds",
        peak=0.62,
        held_ms=1500,
        needed_ms=2000,
    )


ROOM = "bathroom"


def stash_frame(runner: Any, now: float) -> None:
    """A frame in the ring and its embedding in the store, as the loop would."""
    image = Image.new("RGB", (32, 32), "white")
    runner.room(ROOM).recent.append((now, image))
    runner.store.remember_frame(now, np.eye(DIM)[0], ENCODER)
    runner.store.commit()


# ------------------------------------------------------------------- tests


def test_a_yes_credits_the_session_and_marks_it_vlm(tmp_path):
    teacher = FakeTeacher(verdict("YES"))
    r = runner_with(tmp_path, teacher)
    skill = a_skill()
    stash_frame(r, 100.0)

    asyncio.run(r._escalate(skill, an_escalation(), 100.0, r.room(ROOM), ROOM))

    assert teacher.calls, "the teacher was not called"
    assert len(r.sent) == 1
    sent = r.sent[0]
    assert sent["kind"] == "entered", "a YES has to credit the session, not drop it"
    assert sent["verdictBy"] == "vlm", "and settled_by is the whole trust model"
    assert "teacher:" in sent["reason"]


def test_a_no_rejects_it_and_still_marks_it_vlm(tmp_path):
    r = runner_with(tmp_path, FakeTeacher(verdict("NO")))
    stash_frame(r, 100.0)

    asyncio.run(r._escalate(a_skill(), an_escalation(), 100.0, r.room(ROOM), ROOM))

    assert r.sent[0]["kind"] == "rejected"
    assert r.sent[0]["verdictBy"] == "vlm", "a confident no is still the teacher's call"


def test_unsure_is_an_answer_not_a_verdict(tmp_path):
    """
    The frames genuinely do not show it, so the question belongs to a person.
    Recording it as a vlm verdict would claim a confidence nobody has.
    """
    r = runner_with(tmp_path, FakeTeacher(verdict("UNSURE")))
    stash_frame(r, 100.0)

    asyncio.run(r._escalate(a_skill(), an_escalation(), 100.0, r.room(ROOM), ROOM))

    assert r.sent[0]["kind"] == "rejected"
    assert r.sent[0]["verdictBy"] is None


def test_a_yes_and_a_no_are_written_down_as_labels(tmp_path):
    """The half of a verdict that matters long-term."""
    for answer, expected in (("YES", 1), ("NO", 0)):
        r = runner_with(tmp_path / answer, FakeTeacher(verdict(answer)))
        stash_frame(r, 100.0)
        asyncio.run(r._escalate(a_skill(), an_escalation(), 100.0, r.room(ROOM), ROOM))

        rows = r.store.examples("applied_to_face", ENCODER)
        assert len(rows) == 1, f"{answer} should have produced exactly one label"
        assert rows[0].label == expected
        assert rows[0].source == "vlm"


def test_unsure_is_not_written_down(tmp_path):
    r = runner_with(tmp_path, FakeTeacher(verdict("UNSURE")))
    stash_frame(r, 100.0)
    asyncio.run(r._escalate(a_skill(), an_escalation(), 100.0, r.room(ROOM), ROOM))
    assert r.store.examples("applied_to_face", ENCODER) == []


def test_a_failed_call_still_emits_the_transition(tmp_path):
    """
    A network failure must not swallow the event. The occurrence goes
    unresolved rather than silently disappearing from the ledger.
    """
    r = runner_with(tmp_path, FakeTeacher(None))
    stash_frame(r, 100.0)

    asyncio.run(r._escalate(a_skill(), an_escalation(), 100.0, r.room(ROOM), ROOM))

    assert len(r.sent) == 1
    assert r.sent[0]["kind"] == "escalate"
    assert r.store.examples("applied_to_face", ENCODER) == []


def test_no_api_key_degrades_rather_than_crashing(tmp_path):
    """A missing credential should cost you escalation, not the whole run."""
    r = runner_with(tmp_path, None, key=None)
    stash_frame(r, 100.0)

    asyncio.run(r._escalate(a_skill(), an_escalation(), 100.0, r.room(ROOM), ROOM))

    assert len(r.sent) == 1
    assert r.sent[0]["kind"] == "escalate"


def test_the_teacher_gets_the_most_recent_frames(tmp_path):
    teacher = FakeTeacher(verdict("YES"))
    r = runner_with(tmp_path, teacher)
    for i in range(10):
        stash_frame(r, 100.0 + i)

    asyncio.run(r._escalate(a_skill(), an_escalation(109.0), 109.0, r.room(ROOM), ROOM))

    _, n_frames = teacher.calls[0]
    assert 1 <= n_frames <= 4, "four frames, not the whole ring"


def test_a_label_attaches_to_a_frame_not_to_the_answer_time(tmp_path):
    """
    A verdict arrives seconds after the frame it is about, so the label has
    to be joined by proximity. Without that it would attach to nothing and
    the join in `examples` would silently drop it.
    """
    r = runner_with(tmp_path, FakeTeacher(verdict("YES")))
    stash_frame(r, 100.0)

    # The answer lands 8 seconds later, as a real call would.
    asyncio.run(r._escalate(a_skill(), an_escalation(108.0), 108.0, r.room(ROOM), ROOM))

    rows = r.store.examples("applied_to_face", ENCODER)
    assert len(rows) == 1, "the label must still find its frame"


def test_a_stale_answer_is_not_attached_to_an_unrelated_frame(tmp_path):
    """The tolerance has to cut off somewhere, or labels land on the wrong frame."""
    r = runner_with(tmp_path, FakeTeacher(verdict("YES")))
    stash_frame(r, 100.0)

    # Ten minutes later is not the same event.
    asyncio.run(r._escalate(a_skill(), an_escalation(700.0), 700.0, r.room(ROOM), ROOM))

    assert r.store.examples("applied_to_face", ENCODER) == []


@pytest.mark.parametrize("answer", ["YES", "NO", "UNSURE"])
def test_every_verdict_emits_exactly_one_transition(tmp_path, answer):
    """One event per escalation. Two would double-count; none would lose it."""
    r = runner_with(tmp_path / answer, FakeTeacher(verdict(answer)))
    stash_frame(r, 100.0)
    asyncio.run(r._escalate(a_skill(), an_escalation(), 100.0, r.room(ROOM), ROOM))
    assert len(r.sent) == 1


def test_two_cameras_do_not_share_state_machines(tmp_path):
    """
    One worker watches the whole wall, so this has to hold.

    Two cameras scoring the same skill must each keep their own dwell timer.
    Sharing them would let frames from a kitchen advance a candidacy that a
    bathroom started, and credit a session neither camera actually saw.
    """
    r = runner_with(tmp_path, FakeTeacher(verdict("YES")))
    kitchen, bathroom = r.room("kitchen"), r.room("bathroom")

    assert kitchen is not bathroom
    assert kitchen.states is not bathroom.states
    assert kitchen.gate is not bathroom.gate, "a shared gate would diff across cameras"

    kitchen.states["applied_to_face"] = initial(0.0)
    assert "applied_to_face" not in bathroom.states


def test_a_transition_records_the_camera_not_the_worker(tmp_path):
    """
    A worker watching the wall registers as "*". Recording every transition
    against "*" would lose which camera actually saw it, which is the one
    thing the ledger cannot reconstruct afterwards.
    """
    r = runner_with(tmp_path, FakeTeacher(verdict("YES")))
    r.cfg = replace(r.cfg, room="*")
    stash_frame(r, 100.0)

    asyncio.run(r._escalate(a_skill(), an_escalation(), 100.0, r.room(ROOM), ROOM))

    assert r.sent[0]["room"] == ROOM
