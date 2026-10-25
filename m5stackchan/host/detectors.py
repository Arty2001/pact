"""
Candidate detectors, scored against recorded data rather than impressions.

The frame-differencing detector the firmware ships cannot do the job it was
given. Differencing sees the MOMENT something moves, so a person standing
in front of the camera is invisible to it - measured at 4-8 lit cells while
the person filled a third of the frame, against 2.1 for an empty room. It
only spiked when they walked toward the camera.

"Stick to the person" is a presence question, not a motion question, and it
needs a model of what the room looks like without them.
"""

import numpy as np


def diff_cells(grids, thr):
    """Frame differencing - what the firmware does today."""
    out = np.zeros(len(grids), dtype=np.int32)
    for i in range(1, len(grids)):
        d = grids[i].astype(np.int16) - grids[i - 1].astype(np.int16)
        out[i] = (np.abs(d - int(d.mean())) >= thr).sum()
    return out


def largest_blob(mask):
    """
    Centre of the biggest connected region, and its size.

    A person is one connected thing. Taking the centroid over every lit cell
    averages the person together with any scattered noise, which lands the
    aim between them - on nothing. Flood fill is cheap on a 20x15 grid and
    is what makes the difference between aiming at a person and aiming at
    the mean of a person and some sensor noise.
    """
    gh, gw = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    best = (0, 0.0, 0.0)

    for sy in range(gh):
        for sx in range(gw):
            if not mask[sy, sx] or seen[sy, sx]:
                continue
            stack = [(sy, sx)]
            seen[sy, sx] = True
            cells = []
            while stack:
                y, x = stack.pop()
                cells.append((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if (0 <= ny < gh and 0 <= nx < gw
                            and mask[ny, nx] and not seen[ny, nx]):
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            if len(cells) > best[0]:
                xs = sum(c[1] for c in cells) / len(cells)
                # Aim high in the blob, not at its centre.
                #
                # A standing person's blob runs from head to feet, so its
                # centroid is around the waist - verified on the footage,
                # where the marker sat on the knees. A robot looking at
                # someone should look at their face. Taking a point near the
                # top of the blob puts the aim on head and shoulders, and
                # costs nothing: the blob is already in hand.
                ys_all = sorted(c[0] for c in cells)
                ys = ys_all[len(ys_all) // 5]      # upper fifth
                best = (len(cells), xs, ys)
    return best


def bgsub(grids, thr=12, fast=0.02, slow=0.002, warmup=15, want_mask=False):
    """
    Background subtraction with a TWO-SPEED update.

    A purely selective update - where cells currently called foreground never
    update the background - deadlocks. Measured on real footage: the dark
    kitchen counter got misclassified early, and because it was foreground it
    was never learned, so it stayed foreground in every frame for three
    minutes and the largest blob sat on it instead of on the person. The rule
    that was meant to protect a stationary person from dissolving also
    guaranteed that any early mistake became permanent.

    So foreground cells still adapt, just ten times slower. A person standing
    still survives for a minute or so, while a mistake washes out. The two
    rates ARE the tradeoff, stated once and measurable, instead of a special
    case bolted on later.

    The background starts as the median of the first frames rather than one
    frame, so a single bad exposure cannot define the room.

    Returns (cells, x, y) per frame; x and y are -1..1 from the centre.
    """
    gh, gw = grids.shape[1:]
    bg = np.median(grids[:warmup], axis=0).astype(np.float32)
    out, masks = [], []

    for i, raw in enumerate(grids):
        f = raw.astype(np.float32)
        d = f - bg
        # Remove the frame-wide shift first: the GC0308 runs auto-exposure
        # continuously, so the whole image drifts in brightness on its own.
        mask = np.abs(d - np.median(d)) >= thr
        masks.append(mask)

        if i < warmup:
            bg = 0.75 * bg + 0.25 * f
            out.append((0, 0.0, 0.0))
            continue

        n, cx, cy = largest_blob(mask)

        rate = np.where(mask, slow, fast).astype(np.float32)
        bg += rate * (f - bg)

        if n == 0:
            out.append((0, 0.0, 0.0))
        else:
            out.append((n,
                        (cx - (gw - 1) / 2) / ((gw - 1) / 2),
                        (cy - (gh - 1) / 2) / ((gh - 1) / 2)))
    return (out, masks) if want_mask else out


def bgsub_gated(grids, thr=12, move_thr=10, hold=100,
                fast=0.03, slow=0.001, warmup=15, want_mask=False):
    """
    Background subtraction, with the update gated on recent motion.

    This resolves the tension that neither single-rate version could. Learn
    foreground too fast and a person standing still dissolves; learn it too
    slowly and an early misclassification becomes permanent - measured, the
    kitchen counter stayed lit for three minutes and the aim sat on it.

    The way out is that the two cases are physically different, and the
    difference is observable. A person standing still GOT there by moving,
    and will move again. A misclassified counter never moves at all.

    So each cell remembers when it last changed frame-to-frame. A cell that
    differs from the background AND has moved recently is protected and
    stays foreground. A cell that differs but has been perfectly still for
    `hold` frames is a modelling error, and gets absorbed at the fast rate.

    Nothing here is a special case bolted on: it is one rule, and it makes
    the deadlock impossible rather than merely slow.
    """
    gh, gw = grids.shape[1:]
    bg = np.median(grids[:warmup], axis=0).astype(np.float32)
    last_move = np.full((gh, gw), -10 ** 6, dtype=np.int32)
    prev = grids[0].astype(np.float32)
    out, masks = [], []

    for i, raw in enumerate(grids):
        f = raw.astype(np.float32)

        # Frame-to-frame motion, global brightness drift removed.
        fd = f - prev
        moved = np.abs(fd - np.median(fd)) >= move_thr
        last_move[moved] = i
        prev = f

        d = f - bg
        mask = np.abs(d - np.median(d)) >= thr
        alive = mask & ((i - last_move) < hold)
        masks.append(alive)

        if i < warmup:
            bg = 0.75 * bg + 0.25 * f
            out.append((0, 0.0, 0.0))
            continue

        n, cx, cy = largest_blob(alive)

        # Protected only while recently moving; everything else is learned.
        rate = np.where(alive, slow, fast).astype(np.float32)
        bg += rate * (f - bg)

        if n == 0:
            out.append((0, 0.0, 0.0))
        else:
            out.append((n,
                        (cx - (gw - 1) / 2) / ((gw - 1) / 2),
                        (cy - (gh - 1) / 2) / ((gh - 1) / 2)))
    return (out, masks) if want_mask else out
