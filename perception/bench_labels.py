"""
Score every label against every recorded scene at once.

rank_labels answers "is this label better than that one, here". This answers
the question that actually decides whether a skill works: does it score
HIGHEST on the thing it names, across everything the cameras have ever seen?

A label can separate its scene from one other scene and still be useless,
because the scene it quietly prefers is a third one nobody compared it to.
That is not a hypothetical - "a person is visible" is a camera gate, and the
only way to find out what it does to a screen recording is to score it
against one.

    python bench_labels.py

Reads the windows below out of the store, embeds each label once, and prints
a matrix of mean cosine. What matters is the diagonal: a label should win on
its own scene, and the margin to the runner-up is how much room a threshold
has. A label that loses on its own scene cannot be fixed by calibration.
"""

from __future__ import annotations

import argparse
import datetime
import sqlite3
from pathlib import Path

import numpy as np

from pact_perception.embed import LocalEmbedder

#: Recorded scenes, by when they happened. Grouped by what was in front of
#: the camera rather than by which skill was running, because the question is
#: what the frames look like.
SCENES: dict[str, list[tuple[str, str]]] = {
    "shorts": [("18:30", "18:48"), ("19:38", "19:50"), ("20:05", "20:07")],
    "wikipedia": [("19:17", "19:19")],
    "desk": [("09:24", "09:27"), ("10:14", "10:18"), ("02:07", "02:18")],
    "bathroom": [("13:28", "13:32"), ("16:39", "16:49"), ("17:51", "17:53")],
    "squats": [("00:30", "00:49"), ("11:12", "11:17")],
}

#: Every label in production, plus the alternatives worth knowing about.
LABELS: dict[str, str] = {
    "shorts": "a short-form vertical video player",
    "video-player": "a video player filling most of the screen",
    "wikipedia": "an encyclopedia article with dense text and a sidebar",
    "code-editor": "a dark code editor with syntax-highlighted code",
    "person": "a person is visible",
    "at-desk": "a person sitting at a desk in front of a computer",
    "bathroom": "a person standing at a bathroom sink",
    "moisturiser": "a person rubbing cream into their face with their fingertips",
    "flossing": "a person holding dental floss between both hands",
    "squat": "a person at the bottom of a squat, hips below knees, thighs parallel to the floor",
    "sitting": "a person sitting down on a chair with their back supported",
}


def at(day: datetime.date, hhmm: str) -> float:
    h, m = (int(x) for x in hhmm.split(":"))
    return datetime.datetime.combine(day, datetime.time(h, m)).timestamp()


def frames(db: Path, day: datetime.date, spans: list[tuple[str, str]]) -> np.ndarray:
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    out = []
    for a, b in spans:
        rows = conn.execute(
            "SELECT embedding, dim FROM frames WHERE ts BETWEEN ? AND ?", (at(day, a), at(day, b))
        ).fetchall()
        out += [np.frombuffer(blob, dtype=np.float32).reshape(dim) for blob, dim in rows]
    return np.stack(out) if out else np.zeros((0, 0), dtype=np.float32)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--store", type=Path, default=Path("traces/perception.db"))
    ap.add_argument("--resolution", type=int, default=384)
    ap.add_argument("--day", help="YYYY-MM-DD; defaults to today")
    args = ap.parse_args()

    day = datetime.date.fromisoformat(args.day) if args.day else datetime.date.today()
    scenes = {name: frames(args.store, day, spans) for name, spans in SCENES.items()}
    scenes = {k: v for k, v in scenes.items() if v.size > 0}
    if not scenes:
        print("no frames in any of those windows")
        return

    print("  scenes: " + ", ".join(f"{k} ({len(v)})" for k, v in scenes.items()) + "\n")
    embedder = LocalEmbedder(resolution=args.resolution)

    names = list(scenes)
    head = "".join(f"{n[:9]:>11}" for n in names)
    print(f"  {'label':<14}{head}   verdict")

    for key, text in LABELS.items():
        w = embedder.encode_text([text])[0]
        means = {n: float((scenes[n] @ w).mean()) for n in names}
        row = "".join(f"{means[n]:>11.4f}" for n in names)
        best = max(means, key=means.get)
        rest = sorted((v for k, v in means.items() if k != best), reverse=True)
        margin = means[best] - rest[0] if rest else 0.0
        # A label is only usable if the scene it prefers is the scene it
        # names. Everything else is a detector for something else.
        verdict = (
            f"wins on {best} by {margin:.4f}"
            if key not in scenes or best == key
            else f"PREFERS {best}, not {key}"
        )
        print(f"  {key:<14}{row}   {verdict}")

    print(
        "\n  The diagonal is the test. A label that scores highest on a scene\n"
        "  it does not name is a detector for that other scene, and no\n"
        "  threshold fixes it."
    )


if __name__ == "__main__":
    main()
