"""
A skill is a dot product. This is where the dot product happens.

There is no model behind a skill. There is a vector the same width as the
embedding, so scoring fifty skills against one frame is fifty dot products of
1152 terms each, which is microseconds. That is the property the whole design
rests on: adding a goal costs nothing per frame.

The part the design got wrong, and the reason this module exists at all, is
turning a cosine into a score. The written formula is sigmoid(w*e + b), and
with b at zero that produces nothing usable: cosines in a CLIP-family space
run from about -0.1 to 0.4, so every score lands between 0.475 and 0.599 and
an enter threshold of 0.75 is not merely untuned, it is unreachable. Nothing
would ever fire.

Borrowing SigLIP's own learned scale fails the other way. At a scale near 100
the band from 0.45 to 0.75 spans 0.013 of cosine, so the hysteresis that is
supposed to debounce a wobbling signal covers less than the frame-to-frame
noise and debounces nothing.

So the scale and the offset are per skill and fitted from recorded frames:

    score = sigmoid((w . e - bias) / temperature)

`bias` is the cosine at which the score is exactly 0.5, placed at a high
quantile of what the room looks like when nothing is happening. `temperature`
is chosen so the 0.45-to-0.75 band spans a stated number of standard
deviations of that background. Both come out of `calibrate`, which needs
background footage and no labels at all.

The `none` class of a discriminator is a scalar rather than a text row. Zero
shot gives every class the embedding of its label, but no sentence describes
"none of the above", so there is nothing to embed. A logit of zero is exactly
right instead: a real class only beats it once its cosine clears that class's
own bias, which is the definition of the class being present.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

import numpy as np

from .machine import Params

SkillKind = (
    "gate",
    "object",
    "action",
    "counter",
    "discriminator",
    "metric",
)

#: Kinds perception actually scores. A metric is a question for a person;
#: no camera can see it, so it never reaches the encoder.
SCORED_KINDS = frozenset({"gate", "object", "action", "counter", "discriminator"})

#: What a skill is looking at. A room camera and a shared screen arrive down
#: the same socket and are indistinguishable once they are JPEGs, so the
#: distinction is carried rather than inferred.
SURFACES = frozenset({"camera", "screen", "any"})


def applies_to(skill: Skill, surface: str) -> bool:
    """
    Should this skill score a frame from `surface`?

    The reason this exists is not that a screen skill scored against a camera
    returns a wrong answer - it returns a low one, which looks fine. It is
    that every score also feeds calibration, and calibration is what decides
    where the thresholds sit. Mixing surfaces means a bathroom skill learns
    its idea of an ordinary frame partly from screenshots, and then drifts in
    a way nothing reports.

    `any` on either side means no opinion, which is what every skill written
    before surfaces existed has.
    """
    return skill.surface == "any" or surface == "any" or skill.surface == surface


def sigmoid(x: np.ndarray | float) -> np.ndarray:
    # Written through tanh rather than exp so a large negative input returns
    # zero instead of overflowing on the way there.
    return 0.5 * (1.0 + np.tanh(np.asarray(x, dtype=np.float64) / 2.0))


def softmax(x: np.ndarray) -> np.ndarray:
    z = np.asarray(x, dtype=np.float64)
    z = z - np.max(z)
    e = np.exp(z)
    return e / np.sum(e)


@dataclass(frozen=True, slots=True)
class Skill:
    """
    One row of the registry.

    `w` is (dim,) for every kind but a discriminator, where it is (K, dim),
    one row per real class. `encoder_id` records the embedding space the
    vector was fitted in: a weight vector is meaningless under a different
    encoder or a different input resolution, and the failure is silent rather
    than loud, so it is checked before scoring rather than hoped about.
    """

    key: str
    kind: str
    label: str
    #: "camera", "screen", or "any". See `applies_to`.
    surface: str = "any"
    w: np.ndarray | None = None
    bias: float = 0.0
    temperature: float = 1.0
    encoder_id: str = ""
    params: Params = field(default_factory=Params)
    depends_on: str | None = None
    classes: tuple[str, ...] = ()
    margin: float = 0.15
    #: Labels collected so far. A skill with none of them should run looser
    #: and ask more often than one with fifty; see `loosen_for`.
    n_labels: int = 0

    @property
    def ready(self) -> bool:
        return self.w is not None

    @property
    def scored(self) -> bool:
        return self.kind in SCORED_KINDS


#: The implicit class every discriminator carries: none of the above.
NONE = "none"


@dataclass(frozen=True, slots=True)
class Distribution:
    """A discriminator's output. The only kind that returns more than a number."""

    probs: tuple[float, ...]
    names: tuple[str, ...]
    top: str
    p1: float
    runner_up: str
    p2: float

    @property
    def margin(self) -> float:
        return self.p1 - self.p2

    @property
    def detection(self) -> float:
        """
        How much better the best real class explains this frame than nothing
        does: a two-way contest between them, which is what a detection
        actually asks.

        Three formulations were measured over 6,720 recorded frames.

        p1, the winner's probability, cannot fall below 1/(K+1) - 0.345 here
        - and peaks exactly when the discriminator is most certain, INCLUDING
        when it is certain the answer is `none`. That opened sessions on 1,048
        frames whose verdict was "none of these". It also had the narrowest
        spread of anything tried, p10 to p90 of just 0.36: it looked decisive
        because it sat high, not because it separated anything.

        Zeroing on a `none` verdict fixes the first fault and adds a cliff -
        0.68 to 0 on a thousandth of movement, crossed on 5% of all samples.

        Dividing by the two together keeps every good property and recovers
        the range: p10 to p90 of 0.66, nearly twice the original's, with 2.1%
        of frames moving more than 0.3. `none` can only ever divide this
        down, never raise it. And because the contest is against `none` alone,
        adding a third real class does not dilute an unrelated one's score -
        which plain max over the real classes could not say.
        """
        none = 0.0
        best = 0.0
        for prob, name in zip(self.probs, self.names, strict=True):
            if name == NONE:
                none = prob
            else:
                best = max(best, prob)
        total = best + none
        return best / total if total > 0 else 0.0


class EncoderMismatch(RuntimeError):
    """
    Raised rather than scoring a skill fitted against a different encoder.

    Swapping the model or the input resolution moves every vector in the
    space. Scoring anyway returns plausible numbers that mean nothing, which
    is far worse than stopping.
    """


def score(skill: Skill, embedding: np.ndarray, encoder_id: str) -> float:
    """Sigmoid score for every kind except a discriminator."""
    _check(skill, embedding, encoder_id)
    assert skill.w is not None
    cos = float(np.dot(skill.w, embedding))
    return float(sigmoid((cos - skill.bias) / max(skill.temperature, 1e-6)))


def discriminate(skill: Skill, embedding: np.ndarray, encoder_id: str) -> Distribution:
    """
    Softmax over K real classes plus `none`.

    A softmax rather than K independent sigmoids because mutual exclusivity
    has to be structural: two sigmoids can both fire, and nothing in that
    arithmetic knows you only have one hand. The margin between the top two
    is the escalation trigger, and it is a far better one than any absolute
    threshold, because it says "I cannot tell these apart" rather than "I am
    unsure in general".
    """
    _check(skill, embedding, encoder_id)
    assert skill.w is not None
    w = np.atleast_2d(skill.w)
    cos = w @ embedding
    logits = (cos - skill.bias) / max(skill.temperature, 1e-6)
    # `none` sits at zero, so a real class wins exactly when its cosine has
    # cleared the bias. No sentence to embed, and nothing to tune.
    probs = softmax(np.concatenate([logits, np.zeros(1)]))
    names = (*skill.classes[: len(logits)], NONE)
    order = np.argsort(probs)[::-1]
    return Distribution(
        probs=tuple(float(p) for p in probs),
        names=names,
        top=names[int(order[0])],
        p1=float(probs[order[0]]),
        runner_up=names[int(order[1])],
        p2=float(probs[order[1]]),
    )


def _check(skill: Skill, embedding: np.ndarray, encoder_id: str) -> None:
    if skill.w is None:
        raise ValueError(f"skill {skill.key!r} has no weight vector yet")
    if skill.encoder_id and skill.encoder_id != encoder_id:
        raise EncoderMismatch(
            f"skill {skill.key!r} was fitted against {skill.encoder_id!r}, "
            f"but the live encoder is {encoder_id!r}"
        )
    if np.atleast_2d(skill.w).shape[-1] != embedding.shape[-1]:
        raise EncoderMismatch(
            f"skill {skill.key!r} has {np.atleast_2d(skill.w).shape[-1]}-d weights, "
            f"embedding is {embedding.shape[-1]}-d"
        )


# ------------------------------------------------------------- calibration --


def calibrate(
    background_cosines: np.ndarray,
    *,
    enter_conf: float = 0.75,
    exit_conf: float = 0.45,
    quantile: float = 0.98,
    band_sigmas: float = 1.5,
) -> tuple[float, float]:
    """
    Fit `bias` and `temperature` from footage of nothing happening.

    Returns the two numbers that make `enter_conf` and `exit_conf` mean
    something for this skill in this room. Needs no labels, which is what
    lets a brand new skill be usable immediately: point a camera at an empty
    room for a few minutes and the background distribution is the calibration
    set.

    `bias` goes at a high quantile of the background, so an ordinary frame
    scores well under 0.5 and only an unusual one crosses it.

    `temperature` is set so the distance from exit_conf to enter_conf covers
    `band_sigmas` standard deviations of that background. The algebra: a
    sigmoid reaches p at bias + temperature * logit(p), so the band spans
    temperature * (logit(enter) - logit(exit)) in cosine, and we want that to
    equal band_sigmas * sigma.
    """
    cos = np.asarray(background_cosines, dtype=np.float64).ravel()
    if cos.size < 8:
        raise ValueError(f"need at least 8 background samples to calibrate, got {cos.size}")

    span_in_logits = _logit(enter_conf) - _logit(exit_conf)
    if span_in_logits <= 0:
        # enter at or below exit is not a narrow band, it is an inverted one,
        # and the arithmetic below turns it into a negative temperature that
        # the old clamp quietly rounded up to 1e-6 - a perfect step function
        # with no band at all for hysteresis to work in. That shipped, and a
        # squat counter read 98 for 20 squats because every frame scored
        # exactly 0 or exactly 1. Refuse it instead of producing it.
        raise ValueError(
            f"enter_conf {enter_conf} must sit above exit_conf {exit_conf}; "
            "an inverted band has no hysteresis to calibrate"
        )

    bias = float(np.quantile(cos, quantile))
    sigma = float(np.std(cos))
    # A flat background - a frozen frame, a fixture - would divide by zero.
    # Degrade to something narrow but finite rather than exploding.
    sigma = max(sigma, 1e-3)

    temperature = (band_sigmas * sigma) / span_in_logits
    return bias, float(temperature)


@dataclass(frozen=True, slots=True)
class Ranked:
    """One candidate label, measured against real frames."""

    label: str
    #: Mean cosine inside the window minus mean cosine outside it. Says a
    #: threshold can exist at all.
    separation: float
    #: Standard deviation inside the window. Says whether a FIXED threshold
    #: can hold, which is the only kind this system has.
    spread: float
    #: separation / spread. What actually decides it.
    ratio: float


def rank_candidates(
    want: np.ndarray,
    other: np.ndarray,
    vectors: dict[str, np.ndarray],
) -> list[Ranked]:
    """
    Order candidate labels by how well each separates these frames.

    Pure, and separate from the call that produced the candidates, because
    this is the part with a right answer. Generating labels needs something
    that can see; choosing between them is arithmetic over embeddings
    already recorded, and arithmetic belongs somewhere it can be tested.

    The ratio rather than the separation is the sort key, and the difference
    is not academic. A label keyed on something that changes - the clip
    playing inside a video player, rather than the player - scores high on
    the frames it was read off and swings as the content does. Measured on
    real frames, the template SigLIP 2's own documentation recommends buys
    about 5% more separation for 24% more spread: a bigger number and a
    worse detector. A fixed threshold over time cannot use separation it
    cannot rely on.
    """
    ranked: list[Ranked] = []
    for label, w in vectors.items():
        hit, miss = want @ w, other @ w
        # A spread of exactly zero means every frame in the window embedded
        # identically, which in practice means one frame. Treated as maximal
        # uncertainty rather than as a perfect detector: dividing by an
        # epsilon would hand first place to the least evidence.
        spread = float(hit.std())
        separation = float(hit.mean() - miss.mean())
        ratio = separation / spread if spread > 1e-6 else 0.0
        ranked.append(Ranked(label, separation, spread, ratio))
    ranked.sort(key=lambda r: r.ratio, reverse=True)
    return ranked


def _logit(p: float) -> float:
    return float(np.log(p / (1.0 - p)))


def apply_calibration(skill: Skill, bias: float, temperature: float, encoder_id: str) -> Skill:
    return replace(skill, bias=bias, temperature=temperature, encoder_id=encoder_id)


# ----------------------------------------------------------------- warm-up --

#: A skill with no labels should catch more and miss less, accept the extra
#: teacher calls, and tighten as evidence arrives. These are the design's
#: warm-up bands: looser entry and faster escalation while n is small.
_WARMUP: tuple[tuple[int, float, float], ...] = (
    (0, 0.60, 30.0),
    (5, 0.65, 45.0),
    (16, 0.70, 60.0),
)


def loosen_for(params: Params, n_labels: int) -> Params:
    """
    Relax the thresholds of a skill that has not learned anything yet.

    The honest failure this mitigates: the first time you do something new in
    front of a camera that has never seen it, you get zero-shot quality, and
    if that is weak for your room the session may be missed entirely. Running
    loose at the start is the mitigation, not a cure, which is why the manual
    entry path has to stay first class.

    Crucially, the band moves as a unit. Lowering enter_conf on its own can
    put it underneath exit_conf, and an inverted band is not a loose skill -
    it is a skill with no hysteresis whose score becomes a step function. That
    is exactly how a counter came to read 98 for 20 squats.
    """
    band = next((b for b in _WARMUP if n_labels <= b[0]), None)
    if band is None:
        return params
    _, loose_enter, escalate = band

    enter = min(loose_enter, params.enter_conf)
    # Keep the gap the skill was configured with, so loosening never collapses
    # or inverts it.
    gap = max(params.enter_conf - params.exit_conf, 0.05)
    exit_conf = max(min(params.exit_conf, enter - gap), 0.01)
    return replace(
        params,
        enter_conf=enter,
        exit_conf=exit_conf,
        escalate_after_s=escalate,
    )
