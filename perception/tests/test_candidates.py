"""
Cleaning the teacher's candidate labels into house style.

A label is compared character for character against the one it would
replace, and it is the input to a text encoder whose output is the detector
itself. "a squat." and "a squat" are different vectors, so a stray full stop
is not cosmetic - and a model told five times not to write one writes one
anyway often enough that asking nicely cannot be the whole defence.
"""

from __future__ import annotations

from pact_perception.teacher import _candidates


def test_numbering_and_bullets_are_stripped() -> None:
    text = "1. a short vertical video\n2) a dark code editor\n- a bathroom sink"
    assert _candidates(text, 5) == [
        "a short vertical video",
        "a dark code editor",
        "a bathroom sink",
    ]


def test_house_style_is_enforced_not_just_requested() -> None:
    text = '1. "A photo of a person squatting."\n2. This is a kitchen counter.'
    # The leading template and the trailing stop both go, because the model
    # supplies them whatever the prompt says.
    assert _candidates(text, 5) == ["a person squatting", "a kitchen counter"]


def test_duplicates_collapse_case_insensitively() -> None:
    text = "1. a dark code editor\n2. A Dark Code Editor\n3. a web browser"
    assert _candidates(text, 5) == ["a dark code editor", "a web browser"]


def test_n_is_a_ceiling() -> None:
    text = "\n".join(f"{i}. candidate number {i}" for i in range(1, 9))
    assert len(_candidates(text, 3)) == 3


def test_fragments_and_essays_are_dropped() -> None:
    # Too short to name anything, and too long to be a label rather than a
    # description - both produce vectors that match everything a little.
    text = "1. a cat\n2. " + "a very long rambling description " * 8 + "\n3. a bathroom sink"
    assert _candidates(text, 5) == ["a bathroom sink"]


def test_empty_output_is_not_a_candidate() -> None:
    assert _candidates("", 5) == []
    assert _candidates("\n\n  \n", 5) == []
