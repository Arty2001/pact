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

    python make_demo_frames.py --scene screen --out traces/screen

The screen scene keeps that three-segment shape and exists to exercise the
one thing the camera scene cannot: a skill that asks about the LAYOUT of a
frame rather than its content. Its distinct segment is a short-form video
player, and the clip inside the player is re-randomised on every frame while
the player around it does not move at all. That is the real situation rather
than a contrived one: the chrome is the signal, and the clip is noise that
changes every few seconds.

Measured on these frames, two consecutive clips differ by 14.3 raw and 1.0
under `layout` - the collapse the transform exists for.

One warning, because it looks like a bug and is not. Replaying this under
`--embed stub` shows NO difference between a `full` skill and a `layout` one:
0.00047 of frame-to-frame swing either way. The stub builds its vector from
an 8x8 grid of the frame, which is coarser than the 16x16 `layout_only`
averages to, so the stub has already thrown the clip away before the
transform gets a chance to - it is, in effect, a layout-only encoder. The
stub is the right tool for checking that two views are encoded, stored and
scored separately; it cannot show the benefit. For that, `--embed local`.
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

#: Screens are widescreen and a room is not, so the screen scene has its own
#: shape. Small for the same reason the camera one is: the encoder resizes to
#: its own resolution anyway, and these get replayed thousands of times.
SCREEN_W, SCREEN_H = 320, 180


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", default="traces/demo")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument(
        "--scene",
        choices=("camera", "screen"),
        default="camera",
        help="A room, or a shared screen. See the module docstring.",
    )
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

    def distinct(i: int) -> np.ndarray:
        """The thing to detect: a bright block that is plainly not the room."""
        frame = rng.normal(45, 4, (H, W, 3))
        frame[20:110, 20:140] = 235
        frame[30:60, 50:110] = 180
        return frame

    def editor(i: int) -> np.ndarray:
        """
        The ordinary screen: a wide dark editor with lines of code in it.

        This is the background a screen skill's thresholds are fitted
        against, so it has to be a plausible other screen rather than a blank
        one. A bias fitted against black would sit underneath everything.
        """
        frame = rng.normal(38, 3, (SCREEN_H, SCREEN_W, 3))
        frame[:, 0:52] = 30  # a file tree down the left
        for row, y in enumerate(range(16, SCREEN_H - 12, 11)):
            # Lines of varying length, scrolling slowly, so the frame moves
            # enough to clear the motion gate without changing what it is.
            width = 40 + ((row * 37 + i * 13) % 150)
            frame[y : y + 4, 64 : 64 + width] = 150
        return frame

    def shorts(i: int) -> np.ndarray:
        """
        A short-form video player, with a different clip in it every frame.

        The panel and the button column never move: they are the chrome, and
        they are the whole of what a gate can honestly recognise. What is
        inside the panel is re-randomised on every call, which is the point -
        it is the part a `full` view skill cannot help but follow, and the
        part `layout` averages away.
        """
        frame = np.zeros((SCREEN_H, SCREEN_W, 3))
        frame[8:172, 118:202] = rng.integers(0, 255, (164, 84, 3))
        for y in range(96, 168, 18):  # the button column, down the right
            frame[y : y + 9, 212:221] = 205
        return frame

    screen = args.scene == "screen"
    background, middle = (editor, shorts) if screen else (ordinary, distinct)

    for i in range(ORDINARY_BEFORE):
        save(background(i))
    for i in range(DISTINCT):
        save(middle(i))
    for i in range(ORDINARY_AFTER):
        save(background(i))

    plain = "editor" if screen else "ordinary"
    thing = "short-form player, a new clip every frame" if screen else "distinct"
    w, h = (SCREEN_W, SCREEN_H) if screen else (W, H)
    print(
        f"wrote {n} {args.scene} frames at {w}x{h} to {out}\n"
        f"  {ORDINARY_BEFORE} {plain} (the calibration background)\n"
        f"  {DISTINCT} {thing} (the thing to detect)\n"
        f"  {ORDINARY_AFTER} {plain} (so the session has to close)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
