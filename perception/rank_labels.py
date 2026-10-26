"""
Score candidate labels against frames that were actually captured.

A label IS the detector, so the only honest way to choose between two of
them is to embed both and see which one separates the frames you mean from
the frames you do not. Guessing at wording and waiting to find out costs a
calibration cycle and a session each time.

    python rank_labels.py --positives 20:05 20:08 --negatives 19:17 19:20

Two numbers decide it. SEPARATION is the mean cosine on the frames you want
minus the mean on the frames you do not, and it is what makes a threshold
possible at all. SPREAD is the standard deviation across the frames you
want: a label keyed on something that changes - the clip playing inside a
video player, rather than the player - swings as the content does, and no
fixed threshold can hold it. A big separation with a big spread is a label
that works on the first clip and stops.

Their RATIO is the thing to maximise, and it is why the published prompt
templates are the wrong advice here. "This is a photo of {}." is what SigLIP
2's own documentation recommends, and measured on real frames it buys about
5% more separation for 24% more spread - a worse detector. Those templates
are tuned for cross-class ranking, where every class shares the prefix and
only the argmax matters. This system asks one question of one skill against
a fixed threshold over time, where a wobble is a false positive and a shared
prefix buys nothing.
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


#: SigLIP 2 is documented as wanting "This is a photo of {}." and is noted as
#: being more sensitive to phrasing than CLIP. Worth knowing whether that
#: holds for OUR frames, which are screenshots rather than photographs.
TEMPLATES: dict[str, str] = {
    "bare": "{}",
    "siglip2-doc": "This is a photo of {}.",
    "clip-classic": "a photo of {}",
    "screenshot": "a screenshot of {}",
    "screen-showing": "a computer screen showing {}",
    "on-screen": "{} on a computer screen",
}


def rank(embedder, pos, neg, named: dict[str, str]) -> list[tuple]:
    out = []
    for name, label in named.items():
        w = embedder.encode_text([label])[0]
        p_, n_ = pos @ w, neg @ w
        out.append((float(p_.mean() - n_.mean()), float(p_.std()), name, label, float(p_.mean())))
    out.sort(key=lambda r: r[0], reverse=True)
    return out


def report(scored: list[tuple], title: str) -> None:
    print()
    print(f"  {title}")
    print(f"  {'':<16} {'separation':>10} {'spread':>8} {'sep/spread':>11}")
    for sep, sd, name, label, _mean in scored:
        # The ratio is what decides it. Separation says a threshold can
        # exist; spread says whether a FIXED one can hold, which is the only
        # kind this system has.
        print(f"  {name:<16} {sep:>10.4f} {sd:>8.4f} {sep / sd:>11.2f}   {label[:48]}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--positives", nargs=2, metavar=("FROM", "TO"), required=True)
    ap.add_argument("--negatives", nargs=2, metavar=("FROM", "TO"), required=True)
    ap.add_argument("--store", type=Path, default=Path("traces/perception.db"))
    ap.add_argument("--resolution", type=int, default=384)
    ap.add_argument(
        "--template-of",
        help="A label to wrap in each template, instead of ranking candidates.",
    )
    args = ap.parse_args()

    day = datetime.date.today()
    pos = load(args.store, window(day, args.positives[0]), window(day, args.positives[1]))
    neg = load(args.store, window(day, args.negatives[0]), window(day, args.negatives[1]))
    if pos.size == 0 or neg.size == 0:
        print("no frames in one of those windows")
        return

    print(f"  {len(pos)} frames you want, {len(neg)} you do not\n")
    embedder = LocalEmbedder(resolution=args.resolution)

    if args.template_of:
        named = {k: v.format(args.template_of) for k, v in TEMPLATES.items()}
        report(rank(embedder, pos, neg, named), f"templates around: {args.template_of!r}")
        return

    scored = rank(embedder, pos, neg, CANDIDATES)
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
