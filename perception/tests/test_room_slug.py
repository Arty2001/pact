"""
The room slug, which exists in two languages and must mean one thing.

The Hub stamps it; this process keeps the same rule as a fallback for a hub
too old to send one. If the two ever disagree, a camera's scores land on
another camera's chart and nothing says so. The case table is shared with
the TypeScript side so both are held to it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pact_perception.device import Device

CASES = json.loads((Path(__file__).parents[2] / "src" / "room-cases.json").read_text())


@pytest.mark.parametrize(("name", "device_id", "want"), CASES)
def test_slug_matches_the_hub(name: str, device_id: str, want: str) -> None:
    d = Device(id=device_id, name=name, kind="camera", session_id="", track_names=())
    assert d.room == want


def test_the_hub_wins_when_it_sends_one() -> None:
    """One definition, and it is the Hub's. The local rule is a fallback."""
    d = Device(
        id="x", name="Living Room", kind="camera", session_id="", track_names=(),
        given_room="somewhere-else",
    )
    assert d.room == "somewhere-else"
