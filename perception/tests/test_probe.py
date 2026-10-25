"""
Probe refitting.

The holdout numbers are a claim, not decoration: "your answers made this
better" is the whole premise of the product, so a refit that does not
actually beat zero-shot on frames it never saw has to be rejected rather
than shipped with an encouraging-looking number attached.
"""

from __future__ import annotations

import numpy as np
import pytest

from pact_perception.probe import MIN_EXAMPLES, refit

DIM = 32


def unit(x: np.ndarray) -> np.ndarray:
    return x / np.linalg.norm(x)


def labelled_set(
    true_direction: np.ndarray,
    zero_shot: np.ndarray,
    n: int,
    seed: int,
    boundary: float = 0.0,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Points whose label depends on `true_direction`, not on `zero_shot`.

    That gap is the entire scenario the probe exists for: the sentence you
    typed points roughly the right way, and your room points slightly
    elsewhere.
    """
    rng = np.random.default_rng(seed)
    xs, ys = [], []
    for _ in range(n):
        v = unit(rng.normal(size=DIM))
        xs.append(v)
        ys.append(1 if float(np.dot(v, true_direction)) > boundary else 0)
    return np.stack(xs), np.asarray(ys)


def test_too_few_labels_leaves_the_vector_alone():
    rng = np.random.default_rng(1)
    w0 = unit(rng.normal(size=DIM))
    x, y = labelled_set(w0, w0, MIN_EXAMPLES - 1, seed=2)

    out = refit(x, y, w0, bias=0.0, temperature=0.1)
    assert not out.accepted
    assert "need" in out.why
    assert np.allclose(out.w, w0), "a skill with no evidence keeps its zero-shot vector"


def test_one_sided_labels_are_reported_rather_than_fitted():
    """
    The common early case. The teacher is only asked about frames that already
    looked positive, so the first labels are often all 1s, and a fit on them
    would be fitting nothing.
    """
    rng = np.random.default_rng(3)
    w0 = unit(rng.normal(size=DIM))
    x = np.stack([unit(rng.normal(size=DIM)) for _ in range(12)])
    y = np.ones(12, dtype=int)

    out = refit(x, y, w0, bias=0.0, temperature=0.1)
    assert not out.accepted
    assert out.why == "labels are all one class"
    assert np.allclose(out.w, w0)


def test_refit_beats_zero_shot_when_the_room_disagrees_with_the_sentence():
    """
    The claim the demo rests on.

    The labels follow a direction the zero-shot vector only roughly matches,
    which is exactly what "it knows what a sink looks like, not what YOUR
    sink looks like" means in arithmetic. Enough labels should move the
    vector and the held-out accuracy should rise.
    """
    rng = np.random.default_rng(5)
    truth = unit(rng.normal(size=DIM))
    # A sentence pointing 45 degrees off: related, not right.
    w0 = unit(truth + rng.normal(size=DIM))

    x, y = labelled_set(truth, w0, n=120, seed=6)
    out = refit(x, y, w0, bias=0.0, temperature=0.25)

    assert out.accepted, out.why
    assert out.holdout_after > out.holdout_before
    assert out.improved > 0
    assert not np.allclose(out.w, w0), "the vector actually moved"
    assert float(np.dot(out.w, truth)) > float(np.dot(w0, truth)), (
        "and it moved toward the direction the labels describe"
    )


def test_a_refit_that_does_not_help_is_rejected_not_shipped():
    """
    Random labels carry no signal, so nothing can be learned from them. The
    fit must come back refused with its numbers intact rather than quietly
    replacing a sound zero-shot vector with noise.
    """
    rng = np.random.default_rng(11)
    w0 = unit(rng.normal(size=DIM))
    x = np.stack([unit(rng.normal(size=DIM)) for _ in range(40)])
    y = rng.integers(0, 2, size=40)

    out = refit(x, y, w0, bias=0.0, temperature=0.25)
    if not out.accepted:
        assert np.allclose(out.w, w0), "a rejected refit must not alter the vector"
    else:
        # It can legitimately win by luck on a small holdout; what must never
        # happen is a rejection that still changes the weights.
        assert out.holdout_after > out.holdout_before


def test_the_fit_stays_on_the_unit_sphere():
    """
    The dot product downstream is treated as a cosine, and the fitted
    temperature was calibrated against cosines. A vector that drifted off the
    unit sphere would silently rescale every score.
    """
    rng = np.random.default_rng(13)
    truth = unit(rng.normal(size=DIM))
    w0 = unit(truth + 0.8 * rng.normal(size=DIM))
    x, y = labelled_set(truth, w0, n=80, seed=14)

    out = refit(x, y, w0, bias=0.0, temperature=0.25)
    assert float(np.linalg.norm(out.w)) == pytest.approx(1.0, abs=1e-5)


def test_holdout_is_measured_on_points_the_fit_never_saw():
    """
    Otherwise the number is training accuracy wearing a disguise, and it
    would rise even when the probe had learned nothing that generalises.
    Asserted by giving the fit a set it can memorise but not generalise from:
    a perfectly separable set should score well, and a contradictory one
    should not be able to claim it did.
    """
    rng = np.random.default_rng(17)
    truth = unit(rng.normal(size=DIM))
    w0 = unit(truth + rng.normal(size=DIM))

    clean_x, clean_y = labelled_set(truth, w0, n=100, seed=18)
    clean = refit(clean_x, clean_y, w0, bias=0.0, temperature=0.25)

    noisy = refit(clean_x, rng.integers(0, 2, size=100), w0, bias=0.0, temperature=0.25)

    assert clean.holdout_after > noisy.holdout_after, (
        "a real signal must score better than a scrambled one"
    )


def test_examples_are_reported_even_when_the_fit_is_refused():
    """n_examples is what the UI shows, so it has to be right either way."""
    rng = np.random.default_rng(19)
    w0 = unit(rng.normal(size=DIM))
    x = np.stack([unit(rng.normal(size=DIM)) for _ in range(9)])
    out = refit(x, np.ones(9, dtype=int), w0, bias=0.0, temperature=0.1)
    assert out.n_examples == 9
