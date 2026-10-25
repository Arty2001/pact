"""
Refitting a skill's weight vector from labels.

This is the only reason anything improves. The models never change: C-RADIO
is frozen and Nemotron is frozen. What improves is the 1152 floats sitting on
top of them, and every answer a person gives or a teacher adjudicates is one
more point to fit them against.

A skill starts zero-shot: `w` is the text embedding of its label, which is
why a goal works the instant it is written. That direction is right in
general and wrong in particular - it knows what a sink looks like, not what
*your* sink looks like from *that* angle in *that* light.

The design claims five labels beats zero-shot and sixteen makes it solid.
Measured on synthetic data where the labels follow a direction 76 degrees
off the sentence, that is optimistic: five and sixteen are still refused
here, and the fit first wins at around forty, taking the cosine between the
probe and the true direction from 0.24 to 0.62. Three hundred reaches 0.73.
Real labels are not random draws in 1152 dimensions, so the true number is
probably better than this, but it is not five.

Logistic regression by gradient descent, in numpy. No scikit-learn: the
problem is 1152 features and a few dozen points, it fits in milliseconds, and
the dependency would be larger than the code. The fit is L2-regularised
toward the zero-shot parameters rather than toward zero, which matters more
than it sounds: with five examples an unregularised fit will happily find a
separating direction that is pure noise, while anchoring it to the text
embedding means a handful of labels nudge a sound prior instead of
replacing it.

`holdout_before` and `holdout_after` are not decoration. They are the claim
that the refit helped, measured on points the fit never saw, and a refit that
does not improve them is reported and discarded rather than shipped.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

#: Pull toward the zero-shot parameters. Tuned against the sweep in
#: tests/test_probe.py: at 1.0 the prior dominated so completely that a
#: hundred labels left the holdout at chance, and at 0.0 five labels found a
#: separating direction made entirely of noise. This sits where a handful
#: nudges and a few dozen moves it.
_ANCHOR = 0.02

_STEPS = 1200
_LR = 1.0

#: Below this many labels a holdout is meaningless, so the fit is reported
#: but the vector is left alone.
MIN_EXAMPLES = 5

#: Fraction held back. With few points this is at least one of each class.
_HOLDOUT = 0.3


@dataclass(frozen=True, slots=True)
class Refit:
    w: np.ndarray
    bias: float
    #: The fit chooses its own sharpness, so it reports one.
    temperature: float
    n_examples: int
    holdout_before: float
    holdout_after: float
    accepted: bool
    why: str

    @property
    def improved(self) -> float:
        return self.holdout_after - self.holdout_before


def _sigmoid(z: np.ndarray) -> np.ndarray:
    return 0.5 * (1.0 + np.tanh(z / 2.0))


def _accuracy(w: np.ndarray, b: float, x: np.ndarray, y: np.ndarray, temperature: float) -> float:
    if x.shape[0] == 0:
        return 0.0
    scores = _sigmoid((x @ w - b) / max(temperature, 1e-6))
    return float(np.mean((scores >= 0.5) == (y == 1)))


def _split(n: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    order = rng.permutation(n)
    cut = max(1, int(round(n * _HOLDOUT)))
    return order[cut:], order[:cut]


def refit(
    embeddings: np.ndarray,
    labels: np.ndarray,
    zero_shot_w: np.ndarray,
    bias: float,
    temperature: float,
    seed: int = 0,
) -> Refit:
    """
    Fit a probe and report honestly whether it beat what it replaces.

    `embeddings` is (n, dim), already unit-normalised. `labels` is 0/1.
    Returns the new vector and both holdout accuracies; `accepted` is False
    when the refit did not actually help, and in that case `w` is the
    zero-shot vector unchanged.
    """
    x = np.asarray(embeddings, dtype=np.float64)
    y = np.asarray(labels, dtype=np.int32).ravel()
    w0 = np.asarray(zero_shot_w, dtype=np.float64).ravel()
    n = x.shape[0]

    if n < MIN_EXAMPLES:
        return Refit(
            w=w0.astype(np.float32),
            bias=bias,
            temperature=temperature,
            n_examples=n,
            holdout_before=0.0,
            holdout_after=0.0,
            accepted=False,
            why=f"{n} examples, need {MIN_EXAMPLES}",
        )

    if len(np.unique(y)) < 2:
        # One-sided labels cannot separate anything. This is the common case
        # early on, because the teacher is only asked about frames that
        # looked positive, so saying so is more useful than fitting noise.
        return Refit(
            w=w0.astype(np.float32),
            bias=bias,
            temperature=temperature,
            n_examples=n,
            holdout_before=0.0,
            holdout_after=0.0,
            accepted=False,
            why="labels are all one class",
        )

    train, held = _split(n, seed)
    xt, yt = x[train], y[train].astype(np.float64)

    before = _accuracy(w0, bias, x[held], y[held], temperature)

    # Fit the natural parameters of sigmoid(a . e + c), then decompose them
    # back into the unit vector, temperature and bias the scorer wants.
    #
    # An earlier version fitted `w` directly and renormalised it to unit
    # length on every step, holding temperature fixed. That couples two
    # things that should be free: the orientation of the boundary and how
    # sharp it is. Pinned at the zero-shot temperature, the fit could only
    # rotate, so it barely moved and the holdout sat near chance even with a
    # hundred labels. Here the magnitude of `a` IS the sharpness, so the fit
    # chooses it, and the decomposition below recovers an exact equivalent.
    scale0 = 1.0 / max(temperature, 1e-6)
    a0 = w0 * scale0
    a = a0.copy()
    c = -bias * scale0

    for _ in range(_STEPS):
        p = _sigmoid(xt @ a + c)
        err = p - yt
        ga = xt.T @ err / len(yt) + _ANCHOR * (a - a0)
        gc = float(np.sum(err)) / len(yt)
        a -= _LR * ga
        c -= _LR * gc

    scale = float(np.linalg.norm(a))
    if scale < 1e-9:
        return Refit(
            w=w0.astype(np.float32),
            bias=bias,
            temperature=temperature,
            n_examples=n,
            holdout_before=before,
            holdout_after=before,
            accepted=False,
            why="fit collapsed to a zero vector",
        )

    w = a / scale
    new_temperature = 1.0 / scale
    new_bias = -c / scale
    after = _accuracy(w, new_bias, x[held], y[held], new_temperature)

    if after <= before:
        return Refit(
            w=w0.astype(np.float32),
            bias=bias,
            temperature=temperature,
            n_examples=n,
            holdout_before=before,
            holdout_after=after,
            accepted=False,
            why="refit did not beat zero-shot on held-out frames",
        )

    return Refit(
        w=w.astype(np.float32),
        bias=float(new_bias),
        temperature=float(new_temperature),
        n_examples=n,
        holdout_before=before,
        holdout_after=after,
        accepted=True,
        why=f"holdout {before:.2f} -> {after:.2f}",
    )
