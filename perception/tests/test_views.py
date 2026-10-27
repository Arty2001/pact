"""
Two skills, one frame, two different pictures of it.

`layout_only` is tested on pixels next door. These cover the wiring around
it: that an encode is paid once per distinct view rather than once per skill,
that each skill is scored against its own view's vector, that the store can
hold two vectors at one instant without one replacing the other, and that
changing a skill's view throws away a calibration measured through the old
one.

The failure every one of these guards against is silent. A layout skill
handed a sharp frame's vector scores plausibly - it is a real cosine against
a real embedding - and the only symptom is a threshold that cannot hold,
weeks later, for no discoverable reason.
"""

from __future__ import annotations

import asyncio

import numpy as np
import pytest
from PIL import Image

from pact_perception.embed import as_view, layout_only
from pact_perception.machine import Params
from pact_perception.run import reviewed_keys
from pact_perception.skills import VIEWS, Skill
from pact_perception.store import Store

from .test_escalation import DIM, ENCODER, runner_with


class ViewSpy:
    """
    An encoder that answers from the pixels, and records what it was handed.

    Answering from the pixels is the point: a stub returning a constant would
    pass a test that scored every skill against the wrong vector, because
    every vector would be the same one.
    """

    encoder_id = ENCODER
    dim = DIM
    #: Side of the grid the frame is reduced to before projecting. Coarse
    #: enough to be quick, fine enough that a panel of changing content still
    #: reads as changing.
    GRID = 8

    def __init__(self) -> None:
        self.seen: list[tuple[int, ...]] = []
        # One fixed basis, as `StubEmbedder` uses. A projection rather than a
        # hash of the pixels on purpose: a hash makes two nearly-identical
        # frames as far apart as two unrelated ones, which would let a test
        # claiming "this view moves less" pass for the wrong reason.
        rng = np.random.default_rng(20261027)
        self._basis = rng.normal(size=(self.GRID * self.GRID * 3, DIM)).astype(np.float32)

    def encode_image(self, image: Image.Image) -> object:
        small = image.convert("RGB").resize((self.GRID, self.GRID), Image.Resampling.BOX)
        pixels = np.asarray(small, dtype=np.float32) / 255.0
        self.seen.append(tuple(np.asarray(small).ravel().tolist()))
        vec = pixels.ravel() @ self._basis

        class Out:
            vector = vec / max(float(np.linalg.norm(vec)), 1e-12)
            ms = 0.1
            dim = DIM

        return Out()

    def encode_text(self, texts: list[str]) -> np.ndarray:
        return np.tile(np.eye(DIM)[0], (len(texts), 1))

    @property
    def calls(self) -> int:
        return len(self.seen)


def skill(key: str, view: str, *, surface: str = "screen", kind: str = "action") -> Skill:
    return Skill(
        key=key,
        kind=kind,
        label=f"{key} label",
        surface=surface,
        view=view,
        w=np.eye(DIM)[0],
        bias=0.1,
        temperature=0.05,
        encoder_id=ENCODER,
        params=Params(),
    )


def shorts_like(seed: int) -> Image.Image:
    """A bright upright panel of changing content on a dark ground."""
    rng = np.random.default_rng(seed)
    frame = np.zeros((96, 96, 3), dtype=np.uint8)
    frame[10:86, 32:64] = rng.integers(0, 255, (76, 32, 3), dtype=np.uint8)
    return Image.fromarray(frame)


# ------------------------------------------------------------- the transform


def test_full_is_the_frame_itself() -> None:
    # Not merely equal pixels: the same object. The loop keeps the raw frame
    # for the teacher, and copying it per frame would be a cost at the frame
    # rate for nothing.
    frame = shorts_like(1)
    assert as_view(frame, "full") is frame


def test_layout_is_the_averaged_frame() -> None:
    frame = shorts_like(2)
    assert np.array_equal(np.asarray(as_view(frame, "layout")), np.asarray(layout_only(frame)))


def test_an_unknown_view_degrades_to_the_frame() -> None:
    """
    The registry is data from another process and is allowed to be wrong. A
    view nobody implemented should take the ordinary path, not the loop down.
    """
    frame = shorts_like(3)
    assert as_view(frame, "sideways") is frame


def test_the_union_is_what_the_dispatch_implements() -> None:
    assert sorted(VIEWS) == ["full", "layout"]


# -------------------------------------------------------------- the grouping


def drive(runner, frames, surface: str = "screen", room: str = "desk") -> None:
    async def go() -> None:
        for seq, frame in enumerate(frames):
            await runner._on_frame(frame, seq, 100.0 + seq, "test", room, surface)

    asyncio.run(go())


def test_one_encode_when_every_skill_wants_the_same_view(tmp_path) -> None:
    """
    The normal case, and the one that must not get more expensive. Three
    skills asking about the frame as it arrived is one forward pass.
    """
    r = runner_with(tmp_path, None)
    r.embedder = spy = ViewSpy()
    r.skills = {
        "a": skill("a", "full"),
        "b": skill("b", "full"),
        "c": skill("c", "full", kind="gate"),
    }

    drive(r, [shorts_like(4)])

    assert spy.calls == 1


def test_one_encode_when_every_skill_wants_layout(tmp_path) -> None:
    r = runner_with(tmp_path, None)
    r.embedder = spy = ViewSpy()
    r.skills = {"a": skill("a", "layout"), "b": skill("b", "layout")}

    frame = shorts_like(5)
    drive(r, [frame])

    assert spy.calls == 1
    averaged = layout_only(frame).convert("RGB").resize(
        (ViewSpy.GRID, ViewSpy.GRID), Image.Resampling.BOX
    )
    assert spy.seen[0] == tuple(np.asarray(averaged).ravel().tolist()), (
        "the encoder was handed the sharp frame"
    )


def test_two_views_cost_two_encodes_and_no_more(tmp_path) -> None:
    """
    Four skills over two views is two encodes, not four. The saving is the
    whole reason the grouping is by view rather than by skill.
    """
    r = runner_with(tmp_path, None)
    r.embedder = spy = ViewSpy()
    r.skills = {
        "shorts": skill("shorts", "layout", kind="gate"),
        "shorts_too": skill("shorts_too", "layout"),
        "reading": skill("reading", "full"),
        "reading_too": skill("reading_too", "full"),
    }

    drive(r, [shorts_like(6)])

    assert spy.calls == 2


def test_an_empty_registry_still_encodes_the_frame(tmp_path) -> None:
    """
    A frame nobody scored today is still the counter-example a correction may
    need tomorrow, so the vector is taken regardless.
    """
    r = runner_with(tmp_path, None)
    r.embedder = spy = ViewSpy()
    r.skills = {}

    drive(r, [shorts_like(7)])

    assert spy.calls == 1
    assert r.store.frames_between(0.0, 200.0, view="full") == [100.0]


def test_each_skill_is_scored_against_its_own_view(tmp_path) -> None:
    """
    The point of the whole change. Two skills with identical weights, labels
    and thresholds, differing only in view, must record different cosines -
    because they were handed different pictures.
    """
    r = runner_with(tmp_path, None)
    r.embedder = ViewSpy()
    r.skills = {"sharp": skill("sharp", "full"), "blurred": skill("blurred", "layout")}

    drive(r, [shorts_like(8)])

    r.store.commit()
    sharp = r.store.cosines("sharp")
    blurred = r.store.cosines("blurred")
    assert sharp.size == 1 and blurred.size == 1
    assert sharp[0] != blurred[0], "both skills were scored against the same vector"


def test_a_layout_skill_is_steadier_across_changing_content(tmp_path) -> None:
    """
    Why anyone would want this, reaching the cosine rather than stopping at
    the pixels: the same panel with a different clip inside it moves a layout
    skill's cosine less than a full-view skill's.

    The magnitude here is the stub's, not the encoder's - about 2x through a
    random projection, against the thirtyfold collapse measured on real
    frames in `test_layout_only`. What this adds to that measurement is that
    the benefit survives the wiring: it is the layout skill, scored through
    the loop and read back out of the store, whose number holds still.
    """
    r = runner_with(tmp_path, None)
    r.embedder = ViewSpy()
    r.skills = {"sharp": skill("sharp", "full"), "blurred": skill("blurred", "layout")}

    # Two frames of the same layout with entirely different content in them.
    drive(r, [shorts_like(11), shorts_like(12)])
    r.store.commit()

    assert np.ptp(r.store.cosines("blurred")) < np.ptp(r.store.cosines("sharp"))


def test_a_camera_skill_never_pays_for_a_screen_skills_view(tmp_path) -> None:
    """
    Views are grouped over the ELIGIBLE skills, which is already filtered by
    surface. A layout skill on the screen must not make a bathroom camera
    encode twice.
    """
    r = runner_with(tmp_path, None)
    r.embedder = spy = ViewSpy()
    r.skills = {
        "shorts": skill("shorts", "layout", surface="screen"),
        "at_sink": skill("at_sink", "full", surface="camera"),
    }

    drive(r, [shorts_like(9)], surface="camera", room="bathroom")

    assert spy.calls == 1


# ----------------------------------------------------------------- the store


def test_both_views_of_one_instant_survive(tmp_path) -> None:
    """
    The join hazard, stated directly. `frames` was keyed on the timestamp
    alone, so the second write at an instant replaced the first - leaving one
    vector standing for both views with nothing to say which it was.
    """
    store = Store(tmp_path / "s.db")
    sharp, blurred = np.eye(DIM)[0], np.eye(DIM)[1]
    store.remember_frame(100.0, sharp, ENCODER, "full")
    store.remember_frame(100.0, blurred, ENCODER, "layout")
    store.commit()

    store.observe("sharp", 100.0, 0.9, 0.9, "active", "full")
    store.observe("blurred", 100.0, 0.9, 0.9, "active", "layout")
    store.commit()

    assert np.array_equal(store.scored_frames("sharp", 0, 200)[0], sharp)
    assert np.array_equal(store.scored_frames("blurred", 0, 200)[0], blurred)


def test_a_rewritten_view_replaces_only_itself(tmp_path) -> None:
    store = Store(tmp_path / "s.db")
    store.remember_frame(100.0, np.eye(DIM)[0], ENCODER, "full")
    store.remember_frame(100.0, np.eye(DIM)[1], ENCODER, "layout")
    store.remember_frame(100.0, np.eye(DIM)[2], ENCODER, "full")
    store.commit()

    assert store.frames_between(0, 200, view="full") == [100.0]
    assert store.frames_between(0, 200, view="layout") == [100.0]


def test_examples_come_back_in_the_view_the_skill_was_scored_in(tmp_path) -> None:
    """
    A label records a moment, not a vector. With that moment encoded twice,
    the join has to pick the picture this skill was actually scored against or
    the refit fits a space the skill does not live in.
    """
    store = Store(tmp_path / "s.db")
    sharp, blurred = np.eye(DIM)[0], np.eye(DIM)[1]
    store.remember_frame(100.0, sharp, ENCODER, "full")
    store.remember_frame(100.0, blurred, ENCODER, "layout")
    store.label("shorts", 100.0, 1, "human")
    store.commit()

    got = store.examples("shorts", ENCODER, "layout")
    assert len(got) == 1, "a label joined to both views, or to neither"
    assert np.array_equal(got[0].embedding, blurred)


def test_a_label_is_not_pinned_to_a_moment_its_view_never_saw(tmp_path) -> None:
    """
    Views are chosen per frame from whatever was eligible, so a moment may
    exist in one view and not the other. Attaching a label to the nearest
    moment overall would pin it to a vector this skill's view has no row for,
    and the label would be lost rather than wrong.
    """
    store = Store(tmp_path / "s.db")
    store.remember_frame(100.0, np.eye(DIM)[0], ENCODER, "full")
    store.remember_frame(140.0, np.eye(DIM)[1], ENCODER, "layout")
    store.commit()

    assert store.nearest_frame_ts(101.0, tolerance=30.0, view="full") == 100.0
    assert store.nearest_frame_ts(101.0, tolerance=30.0, view="layout") is None


def test_pruning_drops_every_view_of_a_doomed_moment(tmp_path) -> None:
    store = Store(tmp_path / "s.db", retain_days=0.0)
    store.remember_frame(100.0, np.eye(DIM)[0], ENCODER, "full")
    store.remember_frame(100.0, np.eye(DIM)[1], ENCODER, "layout")
    store.commit()

    store.prune(now=100.0 + 86400.0)

    assert store.frames_between(0, 200, view="full") == []
    assert store.frames_between(0, 200, view="layout") == []


def test_a_store_written_before_views_still_opens(tmp_path) -> None:
    """
    The migration. `CREATE TABLE IF NOT EXISTS` does nothing to a table that
    is already there, and `frames` cannot take an ALTER at all - its primary
    key widened - so an old store has to be rebuilt rather than patched.
    Everything already in it was encoded from the frame as it arrived, which
    is what "full" means, so the backfill is not a guess.
    """
    import sqlite3

    path = tmp_path / "old.db"
    old = sqlite3.connect(path)
    old.executescript(
        """
        CREATE TABLE observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT, skill_key TEXT NOT NULL, ts REAL NOT NULL,
          score REAL NOT NULL, cos REAL NOT NULL, phase TEXT NOT NULL);
        CREATE TABLE frames (
          ts REAL PRIMARY KEY, encoder_id TEXT NOT NULL, dim INTEGER NOT NULL,
          embedding BLOB NOT NULL);
        CREATE TABLE training_examples (
          id INTEGER PRIMARY KEY AUTOINCREMENT, skill_key TEXT NOT NULL, class_key TEXT,
          label INTEGER NOT NULL, source TEXT NOT NULL, frame_ts REAL NOT NULL,
          created_at REAL NOT NULL);
        """
    )
    kept = np.eye(DIM)[3].astype(np.float32)
    old.execute(
        "INSERT INTO frames (ts, encoder_id, dim, embedding) VALUES (?,?,?,?)",
        (100.0, ENCODER, DIM, kept.tobytes()),
    )
    old.execute(
        "INSERT INTO observations (skill_key, ts, score, cos, phase) VALUES (?,?,?,?,?)",
        ("shorts", 100.0, 0.9, 0.4, "active"),
    )
    old.commit()
    old.close()

    store = Store(path)

    assert store.frames_between(0, 200, view="full") == [100.0]
    assert np.array_equal(store.scored_frames("shorts", 0, 200)[0], kept)
    # And it is now the widened key, so both views of an instant fit.
    store.remember_frame(100.0, np.eye(DIM)[4], ENCODER, "layout")
    store.commit()
    assert store.frames_between(0, 200, view="layout") == [100.0]


def test_the_migration_runs_once_and_is_safe_to_repeat(tmp_path) -> None:
    path = tmp_path / "twice.db"
    first = Store(path)
    first.remember_frame(100.0, np.eye(DIM)[0], ENCODER, "layout")
    first.commit()
    first.close()

    again = Store(path)

    assert again.frames_between(0, 200, view="layout") == [100.0]


# ------------------------------------------------------------ invalidation


def _at(key: str, view: str) -> Skill:
    return Skill(key=key, kind="action", label="x", view=view)


def test_a_changed_view_invalidates_the_fit() -> None:
    assert reviewed_keys({"s": _at("s", "full")}, {"s": _at("s", "layout")}) == {"s"}


def test_an_untouched_view_keeps_it() -> None:
    assert reviewed_keys({"s": _at("s", "layout")}, {"s": _at("s", "layout")}) == set()


def test_a_new_skill_has_no_view_to_have_changed() -> None:
    assert reviewed_keys({}, {"s": _at("s", "layout")}) == set()


def test_only_the_changed_skill_is_named() -> None:
    before = {"a": _at("a", "full"), "b": _at("b", "full")}
    after = {"a": _at("a", "full"), "b": _at("b", "layout")}
    assert reviewed_keys(before, after) == {"b"}


@pytest.mark.parametrize("changed", [True, False])
def test_a_changed_view_throws_away_the_background_it_measured(tmp_path, changed) -> None:
    """
    Not merely the fit, as a moved band does: the samples too.

    A moved band leaves the cosines in hand still valid - they were measured
    on the right picture - so only the threshold solved from them is wrong. A
    changed view makes the samples themselves cosines against an image this
    skill has stopped asking about, and refitting from them would aim the new
    thresholds at the old view's background.
    """
    def row(view: str) -> dict[str, object]:
        return {
            "key": "shorts",
            "kind": "action",
            "label": "shorts label",
            "surface": "screen",
            "view": view,
        }

    r = runner_with(tmp_path, None)
    # Through the registry on both sides, so the only difference between the
    # two runs is the view. Built by hand the bands would differ too - the
    # registry path loosens a skill with no labels - and `rebanded_keys` would
    # drop the fit for a reason this test is not about.
    r._on_registry([row("full")])
    room = r.room("desk")
    room.history["shorts"] = [0.1, 0.2, 0.3]
    room.calibrated.add("shorts")
    room.refits["shorts"] = 2

    r._on_registry([row("layout" if changed else "full")])

    if changed:
        assert room.history.get("shorts") is None
        assert "shorts" not in room.calibrated
        assert "shorts" not in room.refits
    else:
        assert room.history["shorts"] == [0.1, 0.2, 0.3]
        assert "shorts" in room.calibrated


def test_a_registry_row_without_a_view_reads_as_full(tmp_path) -> None:
    """Every skill written before views existed, and every hand-made row."""
    r = runner_with(tmp_path, None)

    r._on_registry([{"key": "legacy", "kind": "action", "label": "x"}])

    assert r.skills["legacy"].view == "full"
