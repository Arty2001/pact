"""
Re-score recorded sessions, to check a counting change without redoing it.

The store keeps the raw cosine for every frame it scored. A cosine predates
calibration, so the same frames can be run through a different fit and the
counts compared directly — which is the only way to tell a counting fix from
a coincidence, short of doing twenty squats again and trusting the memory of
how many that was.

    python replay_counts.py --skill squat_counter

It reads traces/perception.db, which is written by a local run and is never
committed; with no store, there is nothing to replay and it says so.
"""

from __future__ import annotations

import argparse
import datetime
import math
import sqlite3
from dataclasses import replace
from pathlib import Path

import numpy as np

from pact_perception.machine import Params, initial, step
from pact_perception.skills import calibrate, loosen_for

#: Matches run.py. A provisional fit lands early so a skill works in seconds,
#: then is refined once there are enough samples for a stable quantile.
PROVISIONAL_AFTER = 20
CALIBRATE_AFTER = 60

#: What loosen_for produced for an unlabelled skill before it moved the band
#: as a unit: enter pulled down to 0.60, exit left above it at 0.65. An
#: inverted band gave calibrate a negative span, so temperature came out
#: negative and the old clamp rounded it to a floor of 1e-6 — a step
#: function, which is how a pose detector came to count poses as reps.
INVERTED_BAND = (0.60, 0.65)


def _sigmoid(z: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(min(z, 60.0), -60.0)))


def _inverted_fit(cosines: np.ndarray) -> tuple[float, float]:
    """The old calibration, reproduced so the before number is real."""
    enter, exit_ = INVERTED_BAND
    sigma = float(np.std(cosines)) or 1e-4
    bias = float(np.quantile(cosines, 0.98)) - 1.5 * sigma
    span = math.log(enter / (1 - enter)) - math.log(exit_ / (1 - exit_))
    return bias, max((1.5 * sigma * 2) / span, 1e-6)


def sessions(
    rows: list[tuple[float, float]], gap_s: float = 60.0
) -> list[list[tuple[float, float]]]:
    """Split on long silences, because each is its own calibration history."""
    out: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] = []
    for ts, cos in rows:
        if current and ts - current[-1][0] > gap_s:
            out.append(current)
            current = []
        current.append((ts, cos))
    if current:
        out.append(current)
    return out


def replay(
    rows: list[tuple[float, float]], params: Params, *, inverted: bool = False
) -> tuple[int, float]:
    """Count entries into ACTIVE, and the share of scores pinned at 0 or 1."""
    state = initial()
    history: list[float] = []
    fits = 0
    counts = 0
    pinned = 0
    scored = 0
    fit = (0.0, 1.0)

    for ts, cos in rows:
        history.append(cos)
        needed = PROVISIONAL_AFTER if fits == 0 else CALIBRATE_AFTER
        if fits < 2 and len(history) >= needed:
            fits += 1
            a = np.asarray(history)
            fit = (
                _inverted_fit(a)
                if inverted
                else calibrate(
                    a, enter_conf=params.enter_conf, exit_conf=params.exit_conf
                )
            )
        if fits == 0:
            continue

        bias, temperature = fit
        score = _sigmoid((cos - bias) / temperature)
        scored += 1
        if score < 0.01 or score > 0.99:
            pinned += 1
        state, event = step(state, score, ts, params)
        if event is not None and event.kind == "entered":
            counts += 1

    return counts, pinned / scored if scored else 0.0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--skill", default="squat_counter")
    ap.add_argument("--store", type=Path, default=Path("traces/perception.db"))
    ap.add_argument("--enter", type=float, default=0.75)
    ap.add_argument("--exit", dest="exit_conf", type=float, default=0.45)
    ap.add_argument("--dwell", type=float, default=0.4)
    ap.add_argument("--exit-s", type=float, default=0.3)
    ap.add_argument("--min-cycle", type=float, default=1.2)
    ap.add_argument("--n-labels", type=int, default=0)
    args = ap.parse_args()

    if not args.store.exists():
        print(f"no store at {args.store}; nothing recorded to replay")
        return

    conn = sqlite3.connect(f"file:{args.store}?mode=ro", uri=True)
    rows = [
        (float(ts), float(cos))
        for ts, cos in conn.execute(
            "SELECT ts, cos FROM observations WHERE skill_key = ? ORDER BY ts",
            (args.skill,),
        )
    ]
    if not rows:
        print(f"{args.skill}: no observations in {args.store}")
        return

    params = loosen_for(
        Params(
            enter_conf=args.enter,
            exit_conf=args.exit_conf,
            dwell_s=args.dwell,
            exit_s=args.exit_s,
            cooldown_s=0.0,
            min_cycle_s=args.min_cycle,
        ),
        args.n_labels,
    )
    print(
        f"{args.skill}: band enter={params.enter_conf:.2f} "
        f"exit={params.exit_conf:.2f} gap={params.enter_conf - params.exit_conf:+.2f}, "
        f"dwell={params.dwell_s}s, min_cycle={params.min_cycle_s}s\n"
    )

    totals = [0, 0, 0]
    for i, session in enumerate(sessions(rows), 1):
        when = datetime.datetime.fromtimestamp(session[0][0]).strftime("%H:%M:%S")
        minutes = (session[-1][0] - session[0][0]) / 60
        before, before_pinned = replay(
            session, replace(params, enter_conf=0.60, exit_conf=0.65), inverted=True
        )
        after, after_pinned = replay(session, params)
        unguarded, _ = replay(session, replace(params, min_cycle_s=0.0))
        totals = [totals[0] + before, totals[1] + after, totals[2] + unguarded]
        print(f"session {i}  {when}  {minutes:5.1f} min  {len(session):>5} frames")
        print(f"   inverted band  {before:>5}  ({before_pinned:5.1%} of scores at 0 or 1)")
        print(f"   as it stands   {after:>5}  ({after_pinned:5.1%})")
        if unguarded != after:
            print(f"   without min_cycle_s {unguarded:>5}")

    print(
        f"\ntotal across sessions: {totals[0]} before, {totals[1]} now"
        f"{'' if totals[2] == totals[1] else f', {totals[2]} without min_cycle_s'}"
    )


if __name__ == "__main__":
    main()
