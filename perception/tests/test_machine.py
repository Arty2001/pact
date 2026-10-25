"""
The state machine's arithmetic.

These tests exist because the machine's whole job is a claim about counting:
thousands of scores an hour become a handful of events. A bug here does not
crash anything, it just quietly credits you with forty workouts or none, so
every test below is phrased as a count rather than as a state inspection.

Scores are fed as explicit traces at a fixed sample interval, which is the
same shape a recording off a real camera has. That is deliberate: when a
threshold needs retuning, these traces get replaced by real ones and the
assertions stay exactly as they are.
"""

from __future__ import annotations

from pact_perception.machine import Event, Params, State, initial, step

DT = 0.5  # sample interval, seconds. 2 Hz.


def run(
    scores: list[float],
    p: Params,
    dt: float = DT,
    state: State | None = None,
) -> tuple[State, list[Event]]:
    """Replay a score trace and collect every event it produced."""
    st = state if state is not None else initial(0.0)
    events: list[Event] = []
    for i, s in enumerate(scores):
        st, ev = step(st, s, i * dt, p)
        if ev is not None:
            events.append(ev)
    return st, events


def kinds(events: list[Event]) -> list[str]:
    return [e.kind for e in events]


def count(events: list[Event], kind: str) -> int:
    return sum(1 for e in events if e.kind == kind)


# --------------------------------------------------------------- the claim --


def test_one_session_produces_one_entered_and_one_exited():
    p = Params(dwell_s=2.0, exit_s=2.0, cooldown_s=5.0)
    # 1s idle, 20s well above enter, 10s well below exit.
    scores = [0.1] * 2 + [0.9] * 40 + [0.1] * 20
    _, ev = run(scores, p)
    assert count(ev, "entered") == 1
    assert count(ev, "exited") == 1
    assert count(ev, "rejected") == 0


def test_ten_walkthroughs_produce_ten_events_not_four_hundred():
    """The headline property. Ten sessions in, ten sessions out."""
    p = Params(dwell_s=2.0, exit_s=2.0, cooldown_s=5.0)
    one = [0.9] * 30 + [0.1] * 24  # 15s present, 12s away: clears cooldown
    scores = one * 10
    _, ev = run(scores, p)
    assert count(ev, "entered") == 10
    assert count(ev, "exited") == 10
    # The trace is 540 samples. Anything near that many events is the bug
    # this machine exists to prevent.
    assert len(ev) == 20


def test_a_jittery_score_does_not_fire_repeatedly():
    """
    A score oscillating across enter_conf is the classic false-positive
    generator. Hysteresis means it stays one session, because nothing dips
    under exit_conf.
    """
    p = Params(enter_conf=0.75, exit_conf=0.45, dwell_s=2.0, exit_s=2.0, cooldown_s=5.0)
    scores = [0.1] * 2 + [0.9, 0.62, 0.88, 0.58, 0.91, 0.70] * 12 + [0.1] * 20
    _, ev = run(scores, p)
    assert count(ev, "entered") == 1
    assert count(ev, "exited") == 1


# ------------------------------------------------------------- near-misses --


def test_dropping_out_before_dwell_is_rejected_with_its_peak():
    p = Params(dwell_s=20.0, exit_conf=0.45)
    # Crosses enter, holds 2s, then falls away. Never reaches the 20s dwell.
    scores = [0.1] * 2 + [0.80, 0.84, 0.79, 0.81] + [0.1] * 4
    _, ev = run(scores, p)
    assert kinds(ev) == ["rejected"]
    r = ev[0]
    assert r.peak == 0.84, "the peak is what tells a near-miss from a non-event"
    assert r.needed_ms == 20_000
    assert 0 < r.held_ms < 20_000


def test_a_spike_then_mid_band_is_not_promoted():
    """
    The failure mode hysteresis introduces. A single frame at 0.9 followed by
    a long stretch at 0.5 must NOT be credited: it never cleared enter_conf
    again, so dwell completing is not enough on its own.
    """
    p = Params(enter_conf=0.75, exit_conf=0.45, dwell_s=2.0, escalate_after_s=999.0)
    scores = [0.9] + [0.5] * 40
    st, ev = run(scores, p)
    assert count(ev, "entered") == 0
    assert st.phase == "candidate", "it should still be waiting, not credited"


def test_mid_band_eventually_escalates_exactly_once():
    p = Params(enter_conf=0.75, exit_conf=0.45, dwell_s=2.0, escalate_after_s=10.0)
    scores = [0.9] + [0.6] * 80  # 40s stuck between the thresholds
    _, ev = run(scores, p)
    assert count(ev, "escalate") == 1, "one teacher call per candidacy, not one per frame"
    assert count(ev, "entered") == 0


# ---------------------------------------------------------------- counting --


def test_counter_config_counts_each_rep_separately():
    """
    Five reps through the same four states. dwell_s=1 and cooldown_s=0 are the
    only differences from the action config above.
    """
    p = Params(dwell_s=1.0, exit_s=0.5, cooldown_s=0.0, enter_conf=0.75, exit_conf=0.45)
    rep = [0.9, 0.9, 0.9, 0.2, 0.2, 0.2]  # 1.5s up, 1.5s down
    st, ev = run(rep * 5, p)
    assert count(ev, "entered") == 5
    assert st.count == 5, "count is what a counter skill reads"


def test_cooldown_suppresses_a_second_credit_for_one_session():
    p = Params(dwell_s=1.0, exit_s=1.0, cooldown_s=60.0)
    # Away for 4s, which is well inside the 60s cooldown, then back.
    scores = [0.9] * 6 + [0.1] * 8 + [0.9] * 6
    _, ev = run(scores, p)
    assert count(ev, "entered") == 1, "re-entry inside cooldown must not re-credit"
    assert count(ev, "exited") == 1


# ---------------------------------------------------------------- duration --


def test_session_duration_measures_active_not_candidacy():
    p = Params(dwell_s=2.0, exit_s=2.0, cooldown_s=5.0)
    scores = [0.9] * 40 + [0.1] * 20
    _, ev = run(scores, p)
    exited = next(e for e in ev if e.kind == "exited")
    # 40 samples at 0.5s = 20s above enter. 2s of that was dwell, and the exit
    # is confirmed 2s after the score drops, so the session spans ~18s + 2s.
    assert 19_000 <= exited.duration_ms <= 21_000


def test_brief_dip_under_exit_does_not_close_the_session():
    p = Params(exit_conf=0.45, exit_s=3.0, dwell_s=1.0, cooldown_s=5.0)
    # One sample at 0.2 is a 0.5s dip, well short of the 3s exit debounce.
    scores = [0.9] * 10 + [0.2] + [0.9] * 10 + [0.1] * 20
    _, ev = run(scores, p)
    assert count(ev, "exited") == 1
    exited = next(e for e in ev if e.kind == "exited")
    assert exited.duration_ms > 10_000, "the dip must not have split the session"


# ------------------------------------------------------------------ purity --


def test_step_does_not_mutate_the_state_it_is_given():
    p = Params()
    before = initial(0.0)
    snapshot = (before.phase, before.since, before.peak, before.count)
    step(before, 0.99, 1.0, p)
    assert (before.phase, before.since, before.peak, before.count) == snapshot


def test_same_trace_twice_gives_identical_events():
    """Replayability is the whole reason this function is pure."""
    p = Params(dwell_s=2.0, exit_s=2.0, cooldown_s=5.0)
    scores = [0.1, 0.8, 0.9, 0.9, 0.9, 0.3, 0.2] * 6
    _, a = run(scores, p)
    _, b = run(scores, p)
    assert a == b


def test_hysteresis_is_why_there_is_one_event_and_not_many():
    """
    Pins the reason the design carries two thresholds instead of one.

    The same jittery trace is run twice: once with a gap between enter and
    exit, once with them collapsed together. Asserted on the total event
    count rather than on one kind, because the chatter a single threshold
    produces on this trace is a storm of rejections rather than of sessions:
    the score never holds above a collapsed threshold long enough to be
    promoted, so it is thrown out and re-admitted on every other sample.
    Either way the claim is the same one, and it is about volume.
    """
    scores = [0.1] * 2 + [0.9, 0.62, 0.88, 0.58, 0.91, 0.70] * 12 + [0.1] * 20

    with_gap = Params(enter_conf=0.75, exit_conf=0.45, dwell_s=1.0, exit_s=1.0, cooldown_s=0.0)
    collapsed = Params(enter_conf=0.75, exit_conf=0.75, dwell_s=1.0, exit_s=1.0, cooldown_s=0.0)

    _, a = run(scores, with_gap)
    _, b = run(scores, collapsed)

    assert kinds(a) == ["entered", "exited"], "the gap yields exactly one session"
    assert len(b) > 10, "a single threshold should chatter on this trace"
    assert count(b, "entered") == 0, "and never actually credit anything"


def test_default_params_keep_a_gap_between_the_thresholds():
    """
    The invariant the test above demonstrates, asserted on the shipped
    defaults too. Collapsing these is a one-character edit that every other
    test would survive, because they all pass their thresholds explicitly.
    """
    p = Params()
    assert p.exit_conf < p.enter_conf


def test_a_rejection_says_which_constraint_actually_failed():
    """
    The most useful line in the system must not lie about why.

    Two near-misses look identical if you only record held_ms and needed_ms:
    one never held long enough, the other held plenty long but never reached
    enter_conf. They want opposite fixes - a shorter dwell versus a lower
    threshold - so a rejection that reports "before dwell" when dwell was
    satisfied sends you tuning the wrong number. This was a real bug, caught
    by a run whose rejection read held_ms=3008 needed_ms=2000.
    """
    p = Params(enter_conf=0.75, exit_conf=0.45, dwell_s=2.0, escalate_after_s=999.0)

    # Ran out of time: crossed enter, dropped away after 1s.
    _, quick = run([0.9, 0.9, 0.2, 0.2], p)
    assert len(quick) == 1
    assert quick[0].held_ms < quick[0].needed_ms
    assert quick[0].reason == "dropped below exit before dwell"
    assert quick[0].needed_conf == 0.0

    # Sagged: crossed enter once, then sat mid-band well past dwell before
    # falling away. Note the peak is 0.9 and that is not a contradiction -
    # crossing enter is how it became a candidate at all, so the peak can
    # never be the thing that failed. What failed is where the score was when
    # dwell elapsed.
    _, slow = run([0.9] + [0.6] * 10 + [0.2, 0.2], p)
    assert len(slow) == 1
    assert slow[0].held_ms > slow[0].needed_ms, "dwell was satisfied"
    assert slow[0].reason == "held past dwell but sagged below enter"
    assert slow[0].needed_conf == 0.75, "and it says what the score had to beat"
    assert slow[0].peak >= 0.75, "the peak cleared enter; that was never the problem"
    assert slow[0].score < p.exit_conf


def test_a_counter_will_not_count_faster_than_a_rep_can_happen():
    """
    A counter counts entries into a pose, and a pose detector fires honestly
    every time you are in that pose — sitting down, bending over, pausing
    mid-set. Cooldown cannot express the constraint, because it is measured
    from the end of the last session rather than from the last count.

    This is the guard that stopped a squat counter reading 98 for 20 squats.
    """
    p = Params(
        enter_conf=0.75,
        exit_conf=0.45,
        dwell_s=0.3,
        exit_s=0.25,
        cooldown_s=0.0,
        min_cycle_s=1.5,
    )
    # A pose that flickers on and off every half second. Without the guard
    # each return is a fresh count.
    flicker = ([0.9] * 2 + [0.1] * 2) * 12
    _, ev = run(flicker, p, dt=0.25)

    assert count(ev, "entered") <= 2, "a 1.5s floor cannot admit more than two in six seconds"


def test_the_minimum_cycle_measures_from_the_last_count_not_the_last_exit():
    """
    The distinction that cooldown gets wrong, shown both ways.

    Cooldown runs from the moment a session ends, so it punishes a long hold
    followed by a legitimate second rep, and forgives two counts half a
    second apart as long as each session was brief. Measuring count-to-count
    inverts both: a long session does not suppress the next rep, and a rapid
    pair is refused however short the sessions were.
    """
    p = Params(
        enter_conf=0.75, exit_conf=0.45, dwell_s=0.3, exit_s=0.25, cooldown_s=0.0, min_cycle_s=2.0
    )

    # A long hold, then a second entry immediately after it ends. Five and a
    # half seconds since the count, so it is a real rep and it counts.
    _, after_long = run([0.9] * 20 + [0.1] * 2 + [0.9] * 4, p, dt=0.25)
    assert count(after_long, "entered") == 2, "a long session must not suppress the next rep"

    # Two brief entries less than two seconds apart. Cooldown would allow
    # these; count-to-count refuses the second.
    _, rapid = run([0.9] * 3 + [0.1] * 2 + [0.9] * 3, p, dt=0.25)
    assert count(rapid, "entered") == 1, "a second count inside the window is not a rep"


def test_a_counter_with_no_minimum_cycle_behaves_as_before():
    """The guard is opt-in; zero must be a true no-op."""
    p = Params(
        enter_conf=0.75, exit_conf=0.45, dwell_s=0.3, exit_s=0.25, cooldown_s=0.0, min_cycle_s=0.0
    )
    rep = [0.9] * 3 + [0.2] * 3
    _, ev = run(rep * 5, p, dt=0.25)
    assert count(ev, "entered") == 5
