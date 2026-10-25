"""
Scoring and calibration.

The first test here documents the bug the rest of the module exists to fix,
because it is the kind of thing that would otherwise be rediscovered at 2am
during a demo: with the formula as originally written, no threshold above 0.6
is reachable and the system simply never fires.
"""

from __future__ import annotations

import numpy as np
import pytest

from pact_perception.machine import Params
from pact_perception.skills import (
    Distribution,
    EncoderMismatch,
    Skill,
    calibrate,
    discriminate,
    loosen_for,
    score,
    sigmoid,
    softmax,
)

ENCODER = "c-radio_v3-b/siglip2@384"
DIM = 16  # small enough to write by hand; the arithmetic does not care


def unit(x: np.ndarray) -> np.ndarray:
    return x / np.linalg.norm(x)


def orthonormal_rows(k: int, seed: int, dim: int = DIM) -> np.ndarray:
    """
    `k` mutually orthogonal unit rows.

    Not a convenience. Two random unit vectors in 16 dimensions have a
    typical cosine around 0.25, so "independent classes" built by sampling
    are nothing of the kind, and a test asserting which class wins would be
    asserting on the draw rather than on the arithmetic.
    """
    rng = np.random.default_rng(seed)
    q, _ = np.linalg.qr(rng.normal(size=(dim, k)))
    return q.T[:k]


def skill_at(cos_boundary: float, temperature: float, w: np.ndarray) -> Skill:
    return Skill(
        key="person_at_sink",
        kind="gate",
        label="a person standing at a bathroom sink",
        w=w,
        bias=cos_boundary,
        temperature=temperature,
        encoder_id=ENCODER,
    )


# -------------------------------------------------- the problem being fixed --


def test_uncalibrated_sigmoid_cannot_reach_the_design_thresholds():
    """
    Why `bias` and `temperature` are not optional.

    sigmoid(cosine) with no scale and no offset compresses the entire usable
    range of a CLIP-family cosine into roughly 0.47 to 0.60. An enter
    threshold of 0.75 is not badly tuned, it is unreachable, and a system
    built on it would report nothing forever while looking healthy.
    """
    cosines = np.array([-0.10, 0.0, 0.10, 0.20, 0.30, 0.40])
    scores = sigmoid(cosines)
    assert scores.max() < 0.61
    assert scores.min() > 0.47
    assert not (scores >= 0.75).any(), "nothing can ever cross enter_conf"


# ------------------------------------------------------------- calibration --


def test_calibration_puts_background_below_half_and_a_match_above_enter():
    rng = np.random.default_rng(7)
    background = rng.normal(0.08, 0.02, size=400)  # an empty room, 400 frames
    bias, temperature = calibrate(background, quantile=0.98, band_sigmas=1.5)

    w = unit(rng.normal(size=DIM))

    # A typical background frame: cosine at the mean of what we calibrated on.
    typical = _embedding_with_cosine(w, 0.08)
    assert score(skill_at(bias, temperature, w), typical, ENCODER) < 0.5

    # A strong match: several standard deviations above the background.
    strong = _embedding_with_cosine(w, 0.08 + 6 * 0.02)
    assert score(skill_at(bias, temperature, w), strong, ENCODER) > 0.75


def test_the_hysteresis_band_spans_the_requested_sigmas():
    """
    The number that makes hysteresis mean anything.

    Borrowing SigLIP's own learned scale would put the whole 0.45-to-0.75
    band inside 0.013 of cosine, which is narrower than frame-to-frame noise,
    so it would debounce nothing. Here the band is sized in units of the
    background's own spread.
    """
    sigma = 0.02
    rng = np.random.default_rng(11)
    background = rng.normal(0.08, sigma, size=4000)
    bias, temperature = calibrate(background, band_sigmas=1.5)

    # Invert the sigmoid at both thresholds and measure the gap in cosine.
    cos_at_enter = bias + temperature * np.log(0.75 / 0.25)
    cos_at_exit = bias + temperature * np.log(0.45 / 0.55)
    band = cos_at_enter - cos_at_exit

    measured_sigma = float(np.std(background))
    assert band == pytest.approx(1.5 * measured_sigma, rel=0.02)


def test_wider_band_sigmas_gives_a_wider_band():
    rng = np.random.default_rng(3)
    background = rng.normal(0.1, 0.03, size=500)
    _, t_narrow = calibrate(background, band_sigmas=1.0)
    _, t_wide = calibrate(background, band_sigmas=3.0)
    assert t_wide > t_narrow * 2.5


def test_calibration_refuses_a_sample_too_small_to_mean_anything():
    with pytest.raises(ValueError, match="at least 8"):
        calibrate(np.array([0.1, 0.2, 0.15]))


def test_a_flat_background_does_not_divide_by_zero():
    """A frozen frame or a test fixture has zero spread. Degrade, do not explode."""
    bias, temperature = calibrate(np.full(50, 0.12))
    assert np.isfinite(bias) and np.isfinite(temperature)
    assert temperature > 0


# ----------------------------------------------------------- discriminator --


def test_discriminator_sums_to_one_so_exactly_one_class_can_win():
    rows = orthonormal_rows(3, seed=5)
    sk = Skill(
        key="which_product",
        kind="discriminator",
        label="which skincare bottle",
        w=rows,
        bias=0.10,
        temperature=0.02,
        encoder_id=ENCODER,
        classes=("moisturizer", "cleanser", "serum"),
    )
    e = _embedding_with_cosine(rows[0], 0.25)
    d = discriminate(sk, e, ENCODER)

    assert sum(d.probs) == pytest.approx(1.0)
    assert d.names == ("moisturizer", "cleanser", "serum", "none")
    assert d.top == "moisturizer"
    assert d.margin == pytest.approx(d.p1 - d.p2)


def test_none_wins_when_every_real_class_is_weak():
    """
    The class with no sentence to embed.

    `none` is a logit of zero, so a real class only beats it once its cosine
    clears that class's bias. Holding a toothbrush should produce `none`
    rather than forcing a choice between two bottles.
    """
    rows = orthonormal_rows(3, seed=13)
    sk = Skill(
        key="which_product",
        kind="discriminator",
        label="which skincare bottle",
        w=rows,
        bias=0.30,  # every class needs a cosine above 0.30 to beat `none`
        temperature=0.02,
        encoder_id=ENCODER,
        classes=("moisturizer", "cleanser", "serum"),
    )
    weak = _embedding_with_cosine(rows[0], 0.05)
    d = discriminate(sk, weak, ENCODER)
    assert d.top == "none"


def test_a_tight_margin_is_what_triggers_escalation():
    """
    The two-white-bottles case: evidence that genuinely does not favour
    either class must produce a small margin rather than a confident guess.

    The embedding is built to be exactly equidistant from both class rows,
    which is the only honest way to assert this. An earlier version of this
    test perturbed one row slightly and expected a tight margin, which was
    wrong: at a sharp temperature even a 0.02 difference in cosine separates
    two classes decisively, and it should.
    """
    rows = orthonormal_rows(2, seed=17)
    sk = Skill(
        key="which_bottle",
        kind="discriminator",
        label="which white bottle",
        w=rows,
        bias=0.10,
        temperature=0.05,
        encoder_id=ENCODER,
        classes=("moisturizer", "cleanser"),
        margin=0.15,
    )
    # The midpoint of the two rows, used directly. Building a vector at some
    # chosen cosine to the midpoint does not work: the perpendicular part it
    # adds is orthogonal to the midpoint but not to each row, so it lands
    # unevenly and destroys the equidistance this test depends on.
    e = unit(rows[0] + rows[1])
    d = discriminate(sk, e, ENCODER)

    assert float(np.dot(rows[0], e)) == pytest.approx(float(np.dot(rows[1], e)))
    assert d.margin < sk.margin, "equidistant evidence must not be guessed between"


def test_a_clear_winner_clears_the_margin_and_is_not_escalated():
    """The other half of the rule: a confident call must not spend a teacher call."""
    rows = orthonormal_rows(2, seed=31)
    sk = Skill(
        key="which_bottle",
        kind="discriminator",
        label="which white bottle",
        w=rows,
        bias=0.10,
        temperature=0.05,
        encoder_id=ENCODER,
        classes=("moisturizer", "cleanser"),
        margin=0.15,
    )
    e = _embedding_with_cosine(rows[0], 0.40)
    d = discriminate(sk, e, ENCODER)
    assert d.top == "moisturizer"
    assert d.margin > sk.margin


# ------------------------------------------------------------ safety rails --


def test_scoring_a_skill_from_another_encoder_raises_rather_than_guessing():
    rng = np.random.default_rng(19)
    w = unit(rng.normal(size=DIM))
    sk = Skill(key="k", kind="gate", label="l", w=w, encoder_id="c-radio_v3-b/siglip2@512")
    with pytest.raises(EncoderMismatch, match="fitted against"):
        score(sk, _embedding_with_cosine(w, 0.2), ENCODER)


def test_a_dimension_change_also_raises():
    rng = np.random.default_rng(23)
    sk = Skill(key="k", kind="gate", label="l", w=unit(rng.normal(size=DIM)), encoder_id=ENCODER)
    with pytest.raises(EncoderMismatch, match="-d weights"):
        score(sk, unit(rng.normal(size=DIM * 2)), ENCODER)


def test_a_skill_with_no_weights_yet_is_not_scorable():
    sk = Skill(key="k", kind="gate", label="a person at a sink")
    assert not sk.ready
    with pytest.raises(ValueError, match="no weight vector"):
        score(sk, np.ones(DIM) / np.sqrt(DIM), ENCODER)


def test_a_metric_skill_is_never_scored():
    """No camera can read the weight on a bar, so it never reaches the encoder."""
    sk = Skill(key="weight_on_bar", kind="metric", label="weight on the bar in lb")
    assert not sk.scored


# -------------------------------------------------------------- warming up --


def test_a_skill_with_no_labels_runs_looser_and_escalates_sooner():
    tuned = Params(enter_conf=0.75, escalate_after_s=60.0)
    cold = loosen_for(tuned, n_labels=0)
    warm = loosen_for(tuned, n_labels=10)
    assert cold.enter_conf == 0.60
    assert cold.escalate_after_s == 30.0
    assert warm.enter_conf == 0.70
    assert loosen_for(tuned, n_labels=50) == tuned, "a well-labelled skill keeps its tuning"


def test_loosening_never_tightens_a_skill_beyond_its_own_setting():
    already_loose = Params(enter_conf=0.55)
    assert loosen_for(already_loose, n_labels=0).enter_conf == 0.55


# ----------------------------------------------------------------- helpers --


def _embedding_with_cosine(w: np.ndarray, target: float) -> np.ndarray:
    """
    A unit vector whose cosine against `w` is exactly `target`.

    Built rather than sampled so the tests assert on scores instead of on
    whatever a random draw happened to produce.
    """
    rng = np.random.default_rng(abs(hash(float(target))) % (2**32))
    perp = rng.normal(size=w.shape[0])
    perp = perp - np.dot(perp, w) * w
    perp = perp / np.linalg.norm(perp)
    return target * w + np.sqrt(max(1.0 - target**2, 0.0)) * perp


def test_the_helper_really_produces_the_requested_cosine():
    rng = np.random.default_rng(29)
    w = unit(rng.normal(size=DIM))
    for target in (0.05, 0.2, 0.5):
        assert float(np.dot(w, _embedding_with_cosine(w, target))) == pytest.approx(target)


def test_softmax_is_a_distribution():
    p = softmax(np.array([2.0, 1.0, 0.0, -50.0]))
    assert sum(p) == pytest.approx(1.0)
    assert (p > 0).all()


def test_distribution_margin_is_top_minus_runner_up():
    d = Distribution(
        probs=(0.58, 0.31, 0.06, 0.05),
        names=("moisturizer", "cleanser", "serum", "none"),
        top="moisturizer",
        p1=0.58,
        runner_up="cleanser",
        p2=0.31,
    )
    assert d.margin == pytest.approx(0.27)


# --------------------------------------------------------------- detection --

def _dist(top: str, p1: float, p2: float = 0.2) -> Distribution:
    return Distribution(
        probs=(p1, p2), names=(top, "other"), top=top, p1=p1, runner_up="other", p2=p2
    )


def test_a_confident_none_is_not_a_detection() -> None:
    """
    The softmax floor is the whole problem. A winner cannot score less than
    1/(K+1), so `none` winning at 0.64 used to clear an enter threshold of
    0.60 and open a session on the confident absence of everything.
    """
    assert _dist("none", 0.64).detection == 0.0


def test_a_real_class_scores_its_probability() -> None:
    assert _dist("a person squatting", 0.82).detection == 0.82


def test_detection_is_zero_however_sure_none_is() -> None:
    assert _dist("none", 0.995).detection == 0.0


def test_margin_is_unchanged_by_any_of_this() -> None:
    """Margin is the escalation trigger and means the same for every class."""
    d = _dist("none", 0.64, 0.30)
    assert abs(d.margin - 0.34) < 1e-9
    assert d.detection == 0.0
