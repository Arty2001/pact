"""
Screens and cameras arrive down the same socket, and must not be confused.

Once a frame is a JPEG nothing about it says whether it came from a room
camera or someone's shared screen, so the distinction is carried explicitly
from the publisher that chose it. These tests cover the three places that
depend on it being carried correctly: which skills are allowed to score a
frame, whether a motionless frame is worth embedding at all, and what the
teacher is told when the cheap layer gives up.

The failure these guard against is specifically a quiet one. A screen skill
scored against a camera does not return a wrong answer, it returns a low one,
which looks exactly like the thing not happening. The damage is to
calibration, which is fitted from whatever frames a skill has seen, and that
surfaces much later as thresholds that no longer mean what they were fitted
to mean.
"""

from __future__ import annotations

import asyncio
from typing import Any

import numpy as np
import pytest
from PIL import Image

from pact_perception.skills import Skill, applies_to
from pact_perception.teacher import _FRAME_PX

from .test_escalation import (
    DIM,
    ENCODER,
    FakeTeacher,
    an_escalation,
    runner_with,
    stash_frame,
    verdict,
)


class CountingEmbedder:
    """A stub that answers, and counts how often it was asked."""

    encoder_id = ENCODER
    dim = DIM

    def __init__(self) -> None:
        self.calls = 0

    def encode_image(self, image: Image.Image) -> Any:
        self.calls += 1

        class Out:
            vector = np.eye(DIM)[0]
            ms = 0.1
            dim = DIM

        return Out()

    def encode_text(self, texts: list[str]) -> np.ndarray:
        return np.tile(np.eye(DIM)[0], (len(texts), 1))


def skill(key: str, surface: str, *, kind: str = "action", depends_on: str | None = None) -> Skill:
    return Skill(
        key=key,
        kind=kind,
        label=f"{key} label",
        surface=surface,
        w=np.eye(DIM)[0],
        bias=0.1,
        temperature=0.05,
        encoder_id=ENCODER,
        depends_on=depends_on,
    )


# ------------------------------------------------------------ the predicate


@pytest.mark.parametrize(
    ("skill_surface", "frame_surface", "expected"),
    [
        ("screen", "screen", True),
        ("camera", "camera", True),
        ("screen", "camera", False),
        ("camera", "screen", False),
        # `any` on either side is "no opinion", which is what every skill
        # written before surfaces existed has. Those must keep scoring
        # everything exactly as they did.
        ("any", "screen", True),
        ("any", "camera", True),
        ("screen", "any", True),
        ("camera", "any", True),
    ],
)
def test_a_skill_only_scores_its_own_surface(skill_surface, frame_surface, expected):
    assert applies_to(skill("s", skill_surface), frame_surface) is expected


# ----------------------------------------------------------- eligibility


def test_eligibility_excludes_the_other_surface(tmp_path):
    r = runner_with(tmp_path, None)
    r.skills = {
        "on_screen": skill("on_screen", "screen"),
        "at_sink": skill("at_sink", "camera"),
        "legacy": skill("legacy", "any"),
    }
    room = r.room("desk")

    screen = {s.key for s in r._eligible(room, "screen")}
    camera = {s.key for s in r._eligible(room, "camera")}

    assert screen == {"on_screen", "legacy"}
    assert camera == {"at_sink", "legacy"}


def test_a_camera_skill_never_calibrates_against_screenshots(tmp_path):
    """
    The point of the filter, stated as the thing it prevents.

    Scoring runs `_remember`, which accumulates the background a skill's
    thresholds are fitted from. A camera skill that scores screenshots fits
    its idea of an ordinary frame partly from them, and then drifts in a way
    nothing reports.
    """
    r = runner_with(tmp_path, None)
    r.embedder = CountingEmbedder()
    r.skills = {"at_sink": skill("at_sink", "camera")}

    async def drive() -> None:
        for seq in range(5):
            await r._on_frame(
                Image.new("RGB", (64, 64), "white"),
                seq,
                100.0 + seq,
                "test",
                "desk",
                "screen",
            )

    asyncio.run(drive())

    assert r.rooms["desk"].history.get("at_sink") is None, (
        "a camera skill collected background from screen frames"
    )


# ------------------------------------------------------------- the gate


def test_a_still_screen_is_still_embedded(tmp_path):
    """
    The gate's premise is false for a screen.

    An empty room is worth nothing, so a motionless camera frame is dropped
    before it costs anything. A motionless screen is worth a great deal -
    reading a page for twenty minutes looks identical to a screensaver and is
    exactly the behaviour a goal wants to credit - so it is not dropped here.
    The saving is taken in the publisher instead, where a still screen slows
    to a heartbeat rather than going silent.
    """
    r = runner_with(tmp_path, None)
    embedder = CountingEmbedder()
    r.embedder = embedder
    r.skills = {}

    same = Image.new("RGB", (64, 64), "white")

    async def drive(surface: str, room: str) -> None:
        # The first frame always passes - there is nothing to compare it to -
        # so it is the second and third, which are identical to it, that say
        # whether the gate stopped them.
        for seq in range(3):
            await r._on_frame(same, seq, 100.0 + seq, "test", room, surface)

    asyncio.run(drive("camera", "bathroom"))
    after_camera = embedder.calls
    asyncio.run(drive("screen", "desk"))
    after_screen = embedder.calls - after_camera

    assert after_camera == 1, "a motionless room should stop costing anything after the first frame"
    assert after_screen == 3, (
        "a motionless screen is the thing being watched, not the absence of it"
    )


# ----------------------------------------------------------- the teacher


def test_the_teacher_is_told_which_surface_it_is_looking_at(tmp_path):
    teacher = FakeTeacher(verdict("YES"))
    r = runner_with(tmp_path, teacher)
    r.skills = {"editor": skill("editor", "screen", kind="gate")}
    stash_frame(r, 100.0)

    room = r.room("bathroom")
    room.surface = "screen"
    child = skill("writing_python", "screen", depends_on="editor")

    asyncio.run(r._escalate(child, an_escalation(), 100.0, room, "bathroom"))

    surface, context = teacher.asked[0]
    assert surface == "screen", "the prompt and the frame size both depend on this"
    assert context == "editor label", (
        "the gate above it is already settled, and saying so is what narrows "
        "the question to the undecided part"
    )


def test_context_is_the_whole_chain_outermost_first(tmp_path):
    r = runner_with(tmp_path, None)
    r.skills = {
        "at_desk": skill("at_desk", "screen", kind="gate"),
        "editor": skill("editor", "screen", kind="gate", depends_on="at_desk"),
    }

    chain = r._context_for(skill("writing_python", "screen", depends_on="editor"))

    assert chain == "at_desk label; editor label"


def test_a_cycle_in_the_registry_does_not_hang(tmp_path):
    """
    A registry is data from elsewhere, so it is allowed to be wrong.

    `_eligible` already bounds its walk for this reason, and the context walk
    is the same shape against the same data.
    """
    r = runner_with(tmp_path, None)
    a = skill("a", "screen", depends_on="b")
    b = skill("b", "screen", depends_on="a")
    r.skills = {"a": a, "b": b}

    assert len(r._context_for(a).split(";")) <= 8


def test_a_screen_frame_reaches_the_teacher_large_enough_to_read():
    """
    512px is right for a camera and quietly wrong for a screen.

    The question asked of a camera survives heavy downsampling; the question
    asked of a screen is almost always "what does that text say", and at
    512px a desktop's body text is a grey smear. The model then answers
    UNSURE forever, which reads as a model that cannot do the task rather
    than as a picture that never contained the answer.
    """
    assert _FRAME_PX["screen"] > _FRAME_PX["camera"]
    assert _FRAME_PX["screen"] >= 1024
