"""
The state machine that turns a stream of scores into a handful of events.

This is the piece that makes the whole system cheap to reason about: roughly
7,200 scores an hour go in and one event comes out. It is also the piece most
likely to be wrong in a way nobody notices, which is why it is written as a
pure function.

    step(state, score, now) -> (state, event | None)

No clock, no logging, no network, no mutation. Everything it knows arrives as
an argument. That is not purity for its own sake: it is the only way to tune
thresholds without re-performing the action. You record a score trace once,
then replay it through this function a hundred times with different numbers.
A machine that read the clock itself could not be tested that way.

Four states, and between them every outcome the product has to explain:

    IDLE -> CANDIDATE      score crossed enter_conf; nothing has happened yet
    CANDIDATE -> ACTIVE    dwell satisfied; the session begins
    CANDIDATE -> IDLE      dropped out before dwell; a near-miss, logged loudly
    CANDIDATE -> escalate  stuck between the thresholds; ask the teacher
    ACTIVE -> COOLDOWN     exit confirmed; the session closes with a duration

Two thresholds rather than one is the entire reason a two-minute routine
produces one event instead of forty. Once above enter_conf, a dip to 0.6
changes nothing; only falling under exit_conf starts the exit timer. A single
threshold would fire on every wobble of the curve.

Promotion additionally requires the score to be at or above enter_conf at the
moment dwell elapses. Without that, a score that spiked once and then sat at
0.5 for the whole dwell would be credited as a confident detection, which is
the failure mode hysteresis introduces if you are careless with it.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Literal

Phase = Literal["idle", "candidate", "active", "cooldown"]
EventKind = Literal["entered", "exited", "rejected", "escalate"]


@dataclass(frozen=True, slots=True)
class Params:
    """
    Per-skill numbers. The six kinds of skill differ only in these.

    A rep counter is not new machinery: it is dwell_s=1, cooldown_s=0 and
    reading `count` instead of `duration_ms`. Five reps is five trips through
    the same four states that a two-minute routine makes once.

    The defaults are placeholders and are known to be wrong. A raw cosine
    pushed through a sigmoid lands everything between 0.47 and 0.60, so
    enter_conf=0.75 is unreachable until a temperature and a bias have been
    fitted from a recorded trace.
    """

    enter_conf: float = 0.75
    exit_conf: float = 0.45
    dwell_s: float = 2.0
    #: How long the score must stay under exit_conf before a session closes.
    #: Its own knob rather than reusing dwell_s: a counter needs to release in
    #: well under a second so the next rep is a separate entry, while an
    #: action wants seconds of grace so one turn away does not split a
    #: session in two.
    exit_s: float = 2.0
    cooldown_s: float = 10.0
    escalate_after_s: float = 60.0


@dataclass(frozen=True, slots=True)
class State:
    phase: Phase = "idle"
    #: When the current phase began.
    since: float = 0.0
    #: Highest score seen during this phase. Survives into the rejection
    #: event, where it is the difference between "nearly" and "never close".
    peak: float = 0.0
    #: When the score first fell under exit_conf while active, or None.
    below_since: float | None = None
    #: When the current session began, for the duration on exit.
    active_since: float | None = None
    #: Entries into ACTIVE. Monotonic; a counter reads deltas of this.
    count: int = 0
    #: Whether this candidacy already escalated, so it only asks once.
    escalated: bool = False


@dataclass(frozen=True, slots=True)
class Event:
    kind: EventKind
    at: float
    score: float
    reason: str
    dwell_ms: int = 0
    held_ms: int = 0
    needed_ms: int = 0
    peak: float = 0.0
    duration_ms: int = 0
    count: int = 0


def initial(now: float = 0.0) -> State:
    return State(phase="idle", since=now)


def _ms(seconds: float) -> int:
    return round(seconds * 1000)


def step(state: State, score: float, now: float, p: Params) -> tuple[State, Event | None]:
    """
    Advance by one score sample.

    Returns the next state and at most one event. One event per call keeps the
    caller's job trivial: log it, record it, move on. The only place two things
    could happen at once is a session closing straight into a new candidacy,
    and that is resolved by letting the next sample open it.
    """
    peak = max(state.peak, score)

    if state.phase == "idle":
        if score >= p.enter_conf:
            return State(phase="candidate", since=now, peak=score, count=state.count), None
        # Peak is meaningless while idle, and leaving it set would inflate the
        # next rejection's report with a score from a previous attempt.
        return replace(state, peak=0.0), None

    if state.phase == "candidate":
        held = now - state.since
        if score < p.exit_conf:
            return (
                State(phase="idle", since=now, count=state.count),
                Event(
                    kind="rejected",
                    at=now,
                    score=score,
                    reason="dropped below exit before dwell",
                    peak=state.peak,
                    held_ms=_ms(held),
                    needed_ms=_ms(p.dwell_s),
                    count=state.count,
                ),
            )
        if held >= p.dwell_s and score >= p.enter_conf:
            return (
                State(
                    phase="active",
                    since=now,
                    peak=peak,
                    active_since=now,
                    count=state.count + 1,
                ),
                Event(
                    kind="entered",
                    at=now,
                    score=score,
                    reason="dwell satisfied",
                    dwell_ms=_ms(held),
                    peak=peak,
                    count=state.count + 1,
                ),
            )
        if not state.escalated and held >= p.escalate_after_s:
            # Between the thresholds for a long time is the best reason there
            # is to spend a teacher call: not a miss, not a hit, and no amount
            # of further waiting will resolve it.
            return (
                replace(state, peak=peak, escalated=True),
                Event(
                    kind="escalate",
                    at=now,
                    score=score,
                    reason="held between thresholds",
                    peak=peak,
                    held_ms=_ms(held),
                    needed_ms=_ms(p.dwell_s),
                    count=state.count,
                ),
            )
        return replace(state, peak=peak), None

    if state.phase == "active":
        if score >= p.exit_conf:
            # Still going. Clearing below_since is what makes the exit timer a
            # debounce rather than a countdown that ignores recovery.
            return replace(state, peak=peak, below_since=None), None

        below = state.below_since if state.below_since is not None else now
        if now - below >= p.exit_s:
            started = state.active_since if state.active_since is not None else state.since
            event = Event(
                kind="exited",
                at=now,
                score=score,
                reason="exit confirmed",
                peak=state.peak,
                duration_ms=_ms(now - started),
                count=state.count,
            )
            # A counter sets cooldown_s=0 and must be able to count the next
            # rep immediately, so skip a cooldown that would expire instantly.
            nxt: Phase = "cooldown" if p.cooldown_s > 0 else "idle"
            return State(phase=nxt, since=now, count=state.count), event

        return replace(state, peak=peak, below_since=below), None

    # cooldown: suppress re-entry so one session cannot be credited twice.
    if now - state.since >= p.cooldown_s:
        return State(phase="idle", since=now, count=state.count), None
    return state, None
