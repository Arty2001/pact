"""
Choosing between candidate labels.

The teacher writes candidates and this decides between them, which makes it
the part with a right answer and the part worth holding to one. A label is
the whole detector, so picking the wrong candidate does not produce a
slightly worse skill - it produces a detector for something else, firing
confidently on the wrong frames.

Vectors here are synthetic and deliberately so. The question is whether the
rule prefers the right shape of evidence, and that must be true of any
embedding space rather than of the frames that happened to be recorded.
"""

from __future__ import annotations

import numpy as np

from pact_perception.skills import rank_candidates


def unit(*values: float) -> np.ndarray:
    v = np.array(values, dtype=np.float32)
    return v / np.linalg.norm(v)


def frames(axis: np.ndarray, n: int, jitter: float, seed: int = 0) -> np.ndarray:
    """n embeddings clustered around `axis`, with a given amount of wobble."""
    rng = np.random.default_rng(seed)
    noise = rng.normal(0.0, jitter, size=(n, axis.size)).astype(np.float32)
    out = axis[None, :] + noise
    return out / np.linalg.norm(out, axis=1, keepdims=True)


X, Y = unit(1, 0, 0), unit(0, 1, 0)


def test_the_label_naming_the_window_wins() -> None:
    want, other = frames(X, 40, 0.05, seed=1), frames(Y, 60, 0.05, seed=2)
    ranked = rank_candidates(want, other, {"right": X, "wrong": Y})
    assert ranked[0].label == "right"
    assert ranked[0].separation > 0
    # The loser does not merely lose: it reads higher outside the window
    # than inside it, which is what a detector for the wrong thing looks
    # like from here.
    assert ranked[-1].separation < 0


def test_a_steady_label_beats_a_bigger_but_wobblier_one() -> None:
    """
    The whole reason the ratio is the sort key rather than the separation.

    A label keyed on something that changes - the clip playing inside a
    video player rather than the player itself - scores high on the frames
    it was read off and swings as the content does. No fixed threshold can
    sit under a swing, and a fixed threshold is the only kind this system
    has, so more separation bought with more spread is a worse detector.
    """
    # A window with two modes in it, which is what a changing subject looks
    # like: half the frames one way, half another. `loud` points straight at
    # one mode, so it separates further and disagrees with itself across the
    # window; `steady` sits between them, separating less and wobbling less.
    want = np.concatenate(
        [frames(X, 20, 0.02, seed=3), frames(unit(1, 0.9, 0), 20, 0.02, seed=4)]
    )
    other = frames(Y, 40, 0.02, seed=5)
    loud, steady = X, unit(1, 0.45, 0)

    ranked = rank_candidates(want, other, {"loud": loud, "steady": steady})
    by = {r.label: r for r in ranked}
    assert by["loud"].separation > by["steady"].separation, "premise: loud separates further"
    assert by["loud"].spread > by["steady"].spread, "premise: loud also wobbles more"
    assert ranked[0].label == "steady"


def test_one_frame_cannot_win_on_having_no_spread() -> None:
    """
    A spread of zero is no evidence, not perfect evidence.

    Dividing by an epsilon would hand first place to whichever candidate was
    measured against the fewest frames, which is exactly backwards: the
    least-tested label would always be proposed.
    """
    single = frames(X, 1, 0.0, seed=6)
    other = frames(Y, 30, 0.05, seed=7)
    ranked = rank_candidates(single, other, {"untested": X})
    assert ranked[0].ratio == 0.0
    # The separation is still reported, so a caller can see what happened
    # rather than being told the candidate was worthless.
    assert ranked[0].separation > 0


def test_a_label_matching_everything_scores_nothing() -> None:
    """
    The measured failure that prompted all of this.

    "a person is visible" discriminated between two scenes by 0.0001 of
    cosine - it names something true of every frame, so it separates
    nothing. It has to rank below a label that actually divides the window
    from its surroundings, and not merely by a little.
    """
    want, other = frames(X, 30, 0.05, seed=8), frames(Y, 30, 0.05, seed=9)
    everything = unit(1, 1, 0)  # equidistant from both clusters by construction
    ranked = rank_candidates(want, other, {"specific": X, "everything": everything})
    assert ranked[0].label == "specific"
    assert abs(next(r for r in ranked if r.label == "everything").separation) < 0.01


def test_order_is_by_ratio_and_every_candidate_comes_back() -> None:
    want, other = frames(X, 25, 0.06, seed=10), frames(Y, 25, 0.06, seed=11)
    vectors = {"a": X, "b": Y, "c": unit(1, 1, 0), "d": unit(0, 0, 1)}
    ranked = rank_candidates(want, other, vectors)
    # Nothing is dropped: the caller needs the current label's own score to
    # decide whether a proposal is worth making at all.
    assert {r.label for r in ranked} == set(vectors)
    assert [r.ratio for r in ranked] == sorted((r.ratio for r in ranked), reverse=True)
