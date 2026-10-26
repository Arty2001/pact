"""
Score candidate labels against frames that were actually captured.

A label IS the detector, so the only honest way to choose between two of
them is to embed both and see which one separates the frames you mean from
the frames you do not. Guessing at wording and waiting to find out costs a
calibration cycle and a session each time.

    python rank_labels.py --positives 20:05 20:08 --negatives 19:17 19:20

Two numbers decide it. SEPARATION is the mean cosine on the frames you want
minus the mean on the frames you do not, and it is what makes a threshold
possible at all. STABILITY is the standard deviation across the frames you
want: a label keyed on something that changes - the clip playing inside a
video player, rather than the player - swings as the content does, and no
fixed threshold can hold it. A big separation with a big spread is a label
that works on the first clip and stops.
"""

from __future__ import annotations

import argparse
import datetime
import sqlite3
from pathlib import Path

import numpy as np

from pact_perception.embed import LocalEmbedder

#: Candidates, from most content-led to most layout-led. The point of the
#: spread is to measure the difference rather than assert it.
CANDIDATES: dict[str, str] = {
    "current": (
        "a tall vertical video filling the centre with dark bars either side "
        "and a column of round buttons down the right"
    ),
    "player-named": "a short-form vertical video player",
    "content-led": "a person dancing in a vertical phone video",
    "letterbox": (
        "a mostly black widescreen display with a single narrow upright panel "
        "of bright image centred in it"
    ),
    "letterbox-plain": "a black screen with one tall bright rectangle in the middle",
    "letterbox-wide": (
        "a wide dark screen, almost entirely black, with a narrow strip of "
        "picture standing upright in the centre"
    ),
    "bars": "two large black bars filling the left and right of the screen",
    "browser-vertical": (
        "a web browser showing a tall narrow video that reaches from the top "
        "of the window to the bottom"
    ),
}


def window(day: datetime.date, hhmm: str) -> float:
    h, m = (int(x) for x in hhmm.split(":"))
    return datetime.datetime.combine(day, datetime.time(h, m)).timestamp()


def load(db: Path, a: float, b: float) -> np.ndarray:
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    rows = conn.execute(
        "SELECT embedding, dim FROM frames WHERE ts BETWEEN ? AND ? ORDER BY ts", (a, b)
    ).fetchall()
    if not rows:
        return np.zeros((0, 0), dtype=np.float32)
    return np.stack([np.frombuffer(blob, dtype=np.float32).reshape(dim) for blob, dim in rows])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--positives", nargs=2, metavar=("FROM", "TO"), required=True)
    ap.add_argument("--negatives", nargs=2, metavar=("FROM", "TO"), required=True)
    ap.add_argument("--store", type=Path, default=Path("traces/perception.db"))
    ap.add_argument("--resolution", type=int, default=384)
    args = ap.parse_args()

    day = datetime.date.today()
    pos = load(args.store, window(day, args.positives[0]), window(day, args.positives[1]))
    neg = load(args.store, window(day, args.negatives[0]), window(day, args.negatives[1]))
    if pos.size == 0 or neg.size == 0:
        print("no frames in one of those windows")
        return

    print(f"  {len(pos)} frames you want, {len(neg)} you do not\n")
    embedder = LocalEmbedder(resolution=args.resolution)

    scored = []
    for name, label in CANDIDATES.items():
        w = embedder.encode_text([label])[0]
        p = pos @ w
        n = neg @ w
        scored.append((float(p.mean() - n.mean()), float(p.std()), name, label, float(p.mean())))

    scored.sort(key=lambda r: r[0], reverse=True)
    print(f"  {'':<17} {'separation':>10} {'spread':>8} {'mean':>8}")
    for sep, sd, name, label, mean in scored:
        print(f"  {name:<17} {sep:>10.4f} {sd:>8.4f} {mean:>8.4f}")
        print(f"      {label[:88]}")

    best = scored[0]
    print(f"\n  best separation: {best[2]}")
    steady = min(scored, key=lambda r: r[1])
    print(f"  steadiest:       {steady[2]} (spread {steady[1]:.4f})")
    print(
        "\n  A label with a big separation and a big spread works on the first\n"
        "  clip and stops. Prefer the one that is both."
    )


if __name__ == "__main__":
    main()
