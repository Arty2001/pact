"""
Generate the synthetic recording the quickstart replays.

`traces/` is gitignored, because committing footage is how a repository ends
up carrying pictures of someone's bathroom. So the demo frames are generated
rather than shipped, which also makes them reproducible: same seed, same
frames, same scores, which is the property the whole tuning workflow rests on.

    python make_demo_frames.py

Three segments, and the shape matters more than the content. Most frames are
an "ordinary" scene with something small moving, because that is what a room
looks like whenever anything is happening at all and it is therefore what a
skill's calibration background is actually made of. A short distinct segment
sits in the middle. Then ordinary again, so a session has to close as well as
open.

Nothing here is a person and nothing here is detectable by a real encoder
looking for one. These frames exist to exercise the pipeline, not to prove a
detection; for that, point a camera at yourself and use --embed local.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image

ORDINARY_BEFORE = 100
DISTINCT = 30
ORDINARY_AFTER = 40

W, H = 160, 120


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", default="traces/demo")
    p.add_argument("--seed", type=int, default=7)
    args = p.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("*.jpg"):
        stale.unlink()

    rng = np.random.default_rng(args.seed)
    n = 0

    def save(frame: np.ndarray) -> None:
        nonlocal n
        Image.fromarray(frame.clip(0, 255).astype("uint8")).save(out / f"{n:04d}.jpg", quality=92)
        n += 1

    def ordinary(i: int) -> np.ndarray:
        """A dim shape drifting across a noisy background."""
        frame = rng.normal(45, 4, (H, W, 3))
        x = 10 + (i * 7) % 120
        frame[70:95, x : x + 20] = 95
        return frame

    for i in range(ORDINARY_BEFORE):
        save(ordinary(i))

    for _ in range(DISTINCT):
        frame = rng.normal(45, 4, (H, W, 3))
        frame[20:110, 20:140] = 235
        frame[30:60, 50:110] = 180
        save(frame)

    for i in range(ORDINARY_AFTER):
        save(ordinary(i))

    print(
        f"wrote {n} frames to {out}\n"
        f"  {ORDINARY_BEFORE} ordinary (the calibration background)\n"
        f"  {DISTINCT} distinct (the thing to detect)\n"
        f"  {ORDINARY_AFTER} ordinary (so the session has to close)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
