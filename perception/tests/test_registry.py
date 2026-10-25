"""
A fitted calibration belongs to the band it was fitted against.

These cover the one decision that keeps that true across an edit: when a
skill's thresholds move, the fit aimed at the old thresholds has to go.
"""

from __future__ import annotations

from pact_perception.machine import Params
from pact_perception.run import rebanded_keys
from pact_perception.skills import Skill


def _skill(key: str, *, enter: float = 0.75, exit_: float = 0.45, label: str = "x") -> Skill:
    return Skill(
        key=key,
        kind="counter",
        label=label,
        params=Params(enter_conf=enter, exit_conf=exit_),
    )


def test_untouched_skill_keeps_its_fit() -> None:
    before = {"squat": _skill("squat")}
    after = {"squat": _skill("squat")}
    assert rebanded_keys(before, after) == set()


def test_moved_enter_drops_the_fit() -> None:
    before = {"squat": _skill("squat", enter=0.75)}
    after = {"squat": _skill("squat", enter=0.60)}
    assert rebanded_keys(before, after) == {"squat"}


def test_moved_exit_drops_the_fit() -> None:
    before = {"squat": _skill("squat", exit_=0.45)}
    after = {"squat": _skill("squat", exit_=0.30)}
    assert rebanded_keys(before, after) == {"squat"}


def test_a_new_skill_is_not_rebanded() -> None:
    """Nothing to invalidate: it has never been fitted at all."""
    assert rebanded_keys({}, {"squat": _skill("squat")}) == set()


def test_a_relabelled_skill_at_the_same_band_keeps_its_fit() -> None:
    """
    The label drives the vector, not the band. Re-embedding is decided
    elsewhere, by comparing vectors; this function only speaks to thresholds.
    """
    before = {"squat": _skill("squat", label="squatting")}
    after = {"squat": _skill("squat", label="a deep squat")}
    assert rebanded_keys(before, after) == set()


def test_only_the_moved_skill_is_named() -> None:
    before = {"a": _skill("a", enter=0.75), "b": _skill("b", enter=0.75)}
    after = {"a": _skill("a", enter=0.75), "b": _skill("b", enter=0.80)}
    assert rebanded_keys(before, after) == {"b"}
