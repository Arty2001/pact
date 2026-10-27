"""
Throwing away the content while keeping the layout.

This is the transform for screen skills whose question is "what am I
looking at" rather than "what is in it". It can be checked without the
encoder: what matters is that large structure survives and small detail
does not, and both are measurable on pixels.
"""

from __future__ import annotations

import numpy as np
from PIL import Image

from pact_perception.embed import layout_only


def shorts_like(noise_seed: int) -> Image.Image:
    """
    A dark screen with a bright upright panel and a column of dots.

    The panel and the column are the chrome - the part that says "short-form
    video player". The noise inside the panel is the clip, and it is
    different every time, which is the whole problem.
    """
    rng = np.random.default_rng(noise_seed)
    frame = np.zeros((384, 384, 3), dtype=np.uint8)
    # The clip: a bright upright panel of entirely different content each call.
    frame[40:344, 130:254] = rng.integers(0, 255, (304, 124, 3), dtype=np.uint8)
    # The buttons: a column of pale marks down the right of the panel.
    for y in range(180, 330, 36):
        frame[y : y + 18, 268:286] = 210
    return Image.fromarray(frame)


def test_two_different_clips_become_nearly_the_same_frame() -> None:
    """
    The point of the whole transform.

    Two Shorts frames with completely different video in them should end up
    close together, because what distinguishes them is exactly what the
    skill is not asking about.
    """
    a, b = np.asarray(layout_only(shorts_like(1))), np.asarray(layout_only(shorts_like(2)))
    raw_a, raw_b = np.asarray(shorts_like(1)), np.asarray(shorts_like(2))

    before = float(np.abs(raw_a.astype(float) - raw_b.astype(float)).mean())
    after = float(np.abs(a.astype(float) - b.astype(float)).mean())
    # Not merely smaller: the difference between two clips has to collapse,
    # or the score still swings as the content does.
    assert after < before / 5, f"before {before:.1f}, after {after:.1f}"


def test_the_layout_survives() -> None:
    """
    Collapsing everything to one flat colour would also pass the test above
    and would be useless. The panel must still read as brighter than the
    ground it sits on, or there is nothing left to recognise.
    """
    out = np.asarray(layout_only(shorts_like(3))).astype(float)
    panel = out[40:344, 130:254].mean()
    ground = out[40:344, 10:110].mean()
    assert panel > ground + 30, f"panel {panel:.1f} vs ground {ground:.1f}"


def test_a_different_layout_stays_different() -> None:
    """
    A wide light page is not a tall bright panel on black, and must not
    become one. If every screen collapsed to the same thing the transform
    would have destroyed the signal along with the noise.
    """
    page = Image.fromarray(np.full((384, 384, 3), 235, dtype=np.uint8))
    a = np.asarray(layout_only(page)).astype(float)
    b = np.asarray(layout_only(shorts_like(4))).astype(float)
    assert float(np.abs(a - b).mean()) > 40


def test_the_size_is_unchanged() -> None:
    # The encoder resizes to its own resolution anyway, but handing it a
    # different shape than the untransformed path would make the two views
    # quietly incomparable.
    out = layout_only(shorts_like(5))
    assert out.size == (384, 384)
    assert out.mode == "RGB"


def test_text_becomes_texture() -> None:
    """
    The privacy half, stated as a test. A page of writing has to come back
    as an even field rather than as legible rows, or the embedding still
    carries what was being read instead of only that reading happened.
    """
    text = np.full((384, 384, 3), 245, dtype=np.uint8)
    for y in range(60, 330, 14):  # lines of "writing"
        text[y : y + 6, 50:334] = 20
    out = np.asarray(layout_only(Image.fromarray(text))).astype(float)
    # Row-to-row variation is what makes lines readable as lines.
    # The interior only: the top and bottom edges of the block are a
    # resampling ramp, which is a different thing from legible lines.
    rows = out[120:280, 50:334].mean(axis=(1, 2))
    # Measured: 11.6 at the default grid of 16, against 16.3 at 32 and
    # 35.5 at 48, where the lines alias against the cell pitch and come
    # back as bands.
    assert float(rows.std()) < 14, f"rows still vary by {float(rows.std()):.1f}"


def test_a_grid_of_one_is_refused() -> None:
    # A grid of 1 is a solid colour: every screen identical, every score the
    # same, and nothing to say so. Better to fail at the call.
    try:
        layout_only(shorts_like(6), grid=1)
    except ValueError:
        return
    raise AssertionError("a grid below 2 should raise")
