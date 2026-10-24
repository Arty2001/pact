"""
Run detectors over a recording and show what they decide, frame by frame.

The device streams the raw 20x15 grid it sampled, so these detectors see the
exact bytes the firmware saw. A detector that works here works on the robot;
the only thing that does not carry over is timing.

    python replay.py <recording> [detector]
    python replay.py <recording> --sheet     # annotated contact sheet

Add a detector by writing a function that takes the grid stack and returns one
Decision per frame, then listing it in DETECTORS. Nothing else changes.
"""

import os
import sys
from dataclasses import dataclass

import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recordings")


@dataclass
class Decision:
    """What a detector concluded about one frame."""
    x: float = 0.0          # -1..1 from frame centre
    y: float = 0.0
    strength: float = 0.0   # 0..1
    valid: bool = False
    cells: int = 0
    note: str = ""


def load(name):
    d = os.path.join(ROOT, name)
    grids = np.load(os.path.join(d, "grids.npy")).astype(np.int16)
    times = np.load(os.path.join(d, "times.npy"))
    jpgs = sorted(f for f in os.listdir(d) if f.endswith(".jpg"))
    return d, grids, times, jpgs


def centroid(mag, threshold):
    """Energy-weighted centre of the cells above threshold, normalized."""
    gh, gw = mag.shape
    hot = mag >= threshold
    n = int(hot.sum())
    if n == 0:
        return None, 0
    w = np.where(hot, mag, 0).astype(np.float64)
    total = w.sum()
    ys, xs = np.mgrid[0:gh, 0:gw]
    cx = (w * xs).sum() / total
    cy = (w * ys).sum() / total
    return ((cx - (gw - 1) / 2) / ((gw - 1) / 2),
            (cy - (gh - 1) / 2) / ((gh - 1) / 2)), n


# --------------------------------------------------------------- detectors --

def det_device(grids, **_):
    """Exactly what vision.c does today: adjacent-frame diff, mean removed."""
    THRESH, MIN_CELLS, MAX_FRAC = 22, 4, 0.40
    out = [Decision(note="first")]
    gh, gw = grids.shape[1:]
    for i in range(1, len(grids)):
        d = grids[i] - grids[i - 1]
        mag = np.abs(d - int(d.mean()))
        c, n = centroid(mag, THRESH)
        if c is None or n < MIN_CELLS:
            out.append(Decision(cells=n, note="too few"))
        elif n > MAX_FRAC * gw * gh:
            out.append(Decision(cells=n, note="global"))
        else:
            out.append(Decision(c[0], c[1], min(n / 30.0, 1.0), True, n))
    return out


def det_lowthresh(grids, **_):
    """Same, but a threshold low enough to see a person walking, not waving."""
    THRESH, MIN_CELLS, MAX_FRAC = 10, 3, 0.55
    out = [Decision(note="first")]
    gh, gw = grids.shape[1:]
    for i in range(1, len(grids)):
        d = grids[i] - grids[i - 1]
        mag = np.abs(d - int(d.mean()))
        c, n = centroid(mag, THRESH)
        if c is None or n < MIN_CELLS:
            out.append(Decision(cells=n, note="too few"))
        elif n > MAX_FRAC * gw * gh:
            out.append(Decision(cells=n, note="global"))
        else:
            out.append(Decision(c[0], c[1], min(n / 30.0, 1.0), True, n))
    return out


def det_background(grids, **_):
    """
    Difference against a slow background instead of the previous frame.

    Adjacent-frame differencing only sees the moment of movement, so a person
    who pauses becomes invisible and the head loses them. A running median-ish
    background keeps showing whatever is not part of the empty room, so a
    person who stops still reads as present.
    """
    THRESH, MIN_CELLS, MAX_FRAC = 12, 4, 0.60
    ALPHA = 0.02          # background adapts over ~50 frames (~7s at 7fps)
    out = [Decision(note="warmup")]
    gh, gw = grids.shape[1:]
    bg = grids[0].astype(np.float64)
    for i in range(1, len(grids)):
        f = grids[i].astype(np.float64)
        d = f - bg
        mag = np.abs(d - np.median(d))
        bg = (1 - ALPHA) * bg + ALPHA * f
        if i < 15:
            out.append(Decision(note="warmup"))
            continue
        c, n = centroid(mag, THRESH)
        if c is None or n < MIN_CELLS:
            out.append(Decision(cells=n, note="too few"))
        elif n > MAX_FRAC * gw * gh:
            out.append(Decision(cells=n, note="global"))
        else:
            out.append(Decision(c[0], c[1], min(n / 40.0, 1.0), True, n))
    return out


DETECTORS = {
    "device": det_device,
    "lowthresh": det_lowthresh,
    "background": det_background,
}


# ------------------------------------------------------------------ report --

def report(name, which):
    d, grids, times, jpgs = load(name)
    t = (times - times[0]) / 1e6
    print(f"{name}: {len(grids)} frames, {t[-1]:.1f}s, "
          f"grid {grids.shape[2]}x{grids.shape[1]}")
    print(f"grid value range {grids.min()}..{grids.max()}\n")

    for key in ([which] if which else DETECTORS):
        dec = DETECTORS[key](grids)
        hits = [x for x in dec if x.valid]
        print(f"--- {key}: {len(hits)}/{len(dec)} frames detected "
              f"({100 * len(hits) / len(dec):.0f}%)")
        if hits:
            xs = np.array([h.x for h in hits])
            ys = np.array([h.y for h in hits])
            print(f"    x {xs.min():+.2f}..{xs.max():+.2f} (spread {xs.std():.2f})"
                  f"   y {ys.min():+.2f}..{ys.max():+.2f} (spread {ys.std():.2f})")
            print(f"    cells median {int(np.median([h.cells for h in hits]))}")
        from collections import Counter
        why = Counter(x.note for x in dec if not x.valid)
        if why:
            print(f"    misses: {dict(why)}")
        print()
    return d, grids, times, jpgs, dec


def sheet(name, which, every=1):
    """Write annotated frames so the decision can be seen, not just read."""
    from PIL import Image, ImageDraw
    d, grids, times, jpgs, _ = report(name, which)
    dec = DETECTORS[which or "device"](grids)
    out = os.path.join(d, f"annot_{which or 'device'}")
    os.makedirs(out, exist_ok=True)

    n = 0
    for i, fn in enumerate(jpgs):
        if i % every:
            continue
        im = Image.open(os.path.join(d, fn)).convert("RGB")
        W, H = im.size
        dr = ImageDraw.Draw(im)
        k = dec[i] if i < len(dec) else Decision()
        if k.valid:
            # The camera image is mirrored, so mirror the overlay too - the
            # marker has to land on the thing the grid actually saw.
            px = (1 - (k.x + 1) / 2) * W
            py = (k.y + 1) / 2 * H
            r = 10 + 20 * k.strength
            dr.ellipse([px - r, py - r, px + r, py + r], outline=(0, 255, 90), width=3)
            dr.line([px - 16, py, px + 16, py], fill=(0, 255, 90))
            dr.line([px, py - 16, px, py + 16], fill=(0, 255, 90))
            dr.text((4, 4), f"{i} {k.x:+.2f},{k.y:+.2f} c{k.cells}", fill=(0, 255, 90))
        else:
            dr.text((4, 4), f"{i} -- {k.note} c{k.cells}", fill=(255, 90, 90))
        im.save(os.path.join(out, f"{i:04d}.png"))
        n += 1
    print(f"wrote {n} annotated frames -> {out}")


def score(empty="baseline_empty", person="person"):
    """
    Grade detector settings against two labelled recordings.

    A detector has exactly two ways to be wrong, and tuning one number
    trades them against each other: firing on an empty room makes the head
    twitch at nothing, and missing a person makes it ignore them. Measuring
    both at once is the only way to choose a threshold rather than guess it,
    and it is the part that was missing every previous time.
    """
    _, ge, _, _ = load(empty)
    _, gp, _, _ = load(person)

    def cells(g, thr):
        return np.array([
            (np.abs((g[i] - g[i - 1]) - int((g[i] - g[i - 1]).mean())) >= thr).sum()
            for i in range(1, len(g))
        ])

    print(f"empty: {len(ge)} frames    person: {len(gp)} frames\n")
    print("  thr  min   false-fire   detects person   margin")
    best = None
    for thr in (18, 22, 26, 30, 34):
        ce, cp = cells(ge, thr), cells(gp, thr)
        for mc in (4, 6, 8, 10, 12, 16, 20, 24):
            fp = (ce >= mc).mean()
            tp = (cp >= mc).mean()
            flag = ""
            # Useful means it almost never fires on an empty room and still
            # sees a person most of the time.
            if fp <= 0.02 and tp >= 0.60:
                sc = tp - 10 * fp
                if best is None or sc > best[0]:
                    best, flag = (sc, thr, mc), "  <-- best"
            print(f"  {thr:>3}  {mc:>3}   {100*fp:8.1f}%   {100*tp:11.1f}%"
                  f"   {tp - fp:+.2f}{flag}")
        print()
    if best:
        print(f"PICK: CELL_THRESHOLD {best[1]}, MIN_CELLS {best[2]}")
    else:
        print("No setting separates them. The detector needs changing, "
              "not retuning.")


if __name__ == "__main__":
    rec = sys.argv[1] if len(sys.argv) > 1 else "take"
    arg = sys.argv[2] if len(sys.argv) > 2 else None
    if arg == "--score":
        score(*(sys.argv[3:5] or ["baseline_empty", "person"]))
    elif arg == "--sheet":
        sheet(rec, sys.argv[3] if len(sys.argv) > 3 else None)
    else:
        report(rec, arg)
