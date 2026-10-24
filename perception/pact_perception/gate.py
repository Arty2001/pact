"""
L0: the motion gate.

This is the only level in the whole tree that saves real compute. Every skill
below it is a dot product against an embedding that has already been paid for,
so skipping skills saves microseconds; skipping the *embedding* saves the
entire cost of the frame. An empty room should cost nothing, and this is what
makes that true.

The measure is the fraction of pixels that changed by more than a noise floor,
on a heavily downscaled greyscale copy. Downscaling is not an optimisation
here, it is the algorithm: at 32x32 a person walking through the frame moves a
large fraction of the pixels while sensor noise, compression mosquito noise and
a flickering light move almost none. Comparing full-resolution frames would
make those indistinguishable.

The same arithmetic runs in the publisher's browser, where it matters more:
gating at the true edge means an empty room sends no bytes at all.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image

#: Side length of the comparison thumbnail. Small enough that noise averages
#: out, large enough that a person is more than one pixel.
GRID = 32

#: Per-pixel 0..1 change below this is treated as sensor noise, not movement.
NOISE_FLOOR = 0.08


def thumbnail(image: Image.Image) -> np.ndarray:
    """A 32x32 greyscale float array in 0..1. The only view the gate has."""
    small = image.convert("L").resize((GRID, GRID), Image.Resampling.BILINEAR)
    return np.asarray(small, dtype=np.float32) / 255.0


@dataclass(frozen=True, slots=True)
class Motion:
    """What the gate decided, and the number it decided on."""

    moved: float
    passed: bool


class MotionGate:
    """
    Holds the previous thumbnail and compares against it.

    The very first frame always passes. There is nothing to compare it to, and
    starting the system in front of a still but occupied room should not mean
    waiting for someone to move before anything is ever embedded.
    """

    def __init__(self, threshold: float = 0.012) -> None:
        self.threshold = threshold
        self._prev: np.ndarray | None = None

    def check(self, image: Image.Image) -> Motion:
        cur = thumbnail(image)
        prev, self._prev = self._prev, cur
        if prev is None:
            return Motion(moved=1.0, passed=True)
        moved = float(np.mean(np.abs(cur - prev) > NOISE_FLOOR))
        return Motion(moved=moved, passed=moved >= self.threshold)

    def reset(self) -> None:
        """Forget history, so the next frame passes. Used when a feed restarts."""
        self._prev = None
