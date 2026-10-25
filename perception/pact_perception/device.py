"""
One live publisher, as the Hub describes it.

Its own module because it is a plain description of a device and nothing
more. Leaving it in sfu.py meant naming a camera required importing a
whole WebRTC stack, so the one rule here could not be tested without one.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Device:
    """One live publisher, as the Hub describes it."""

    id: str
    name: str
    kind: str
    session_id: str
    track_names: tuple[str, ...]
    #: What the Hub called this room. Empty from a hub too old to send one.
    given_room: str = ""

    @property
    def room(self) -> str:
        """
        The slug a goal's skills are scoped to.

        Derived from the name rather than the id so that re-joining with the
        same device name lands in the same room and keeps its calibration,
        which is what someone reconnecting a phone actually expects.

        The Hub stamps this now and its value wins, so the browser and this
        process cannot disagree about which camera a score belongs to. The
        rule below is kept as the fallback and has to stay identical to the
        Hub's.
        """
        if self.given_room:
            return self.given_room
        # ASCII-only, because the Hub's rule is /[^a-z0-9]+/ and Python's
        # str.isalnum() is not: it answers True for 'e', so "Cafe" with an
        # acute slugged one way here and another there. A shared case
        # table caught it; without one it would have been a camera whose
        # scores quietly landed on a different camera's chart.
        slug = "".join(
            c if ("a" <= c <= "z" or "0" <= c <= "9") else "-"
            for c in self.name.lower()
        )
        return "-".join(p for p in slug.split("-") if p) or self.id[:8]
