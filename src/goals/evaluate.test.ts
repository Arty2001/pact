/**
 * The sequenced branch of the goal rule.
 *
 * The sequencer's own tests cover where a pass gets to. These cover what a
 * pass is worth: that a set is one unit of `observed`, that three sets of
 * ten settle at three and not at thirty, and that an unordered goal still
 * takes the path it always took.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluate } from "./evaluate.ts";
import type { Goal, GoalSkill, Transition } from "./types.ts";

function goal(over: Partial<Goal> = {}): Goal {
  return {
    key: "fitness/bench",
    description: "three sets of ten",
    type: "target",
    cadence: "daily",
    doneMin: null,
    doneMax: null,
    windowStart: null,
    windowEnd: null,
    tz: "UTC",
    sequenceWindowS: 600,
    stepValue: null,
    stepPeriod: null,
    stepOn: null,
    createdAt: 0,
    ...over,
  };
}

function link(skillKey: string, index: number | null, minCount: number | null = null): GoalSkill {
  return {
    goalKey: "fitness/bench",
    skillKey,
    role: "required",
    classKey: null,
    minCount,
    accumulate: false,
    sequenceIndex: index,
  };
}

function at(skillKey: string, seconds: number, kind: Transition["kind"]): Transition {
  return {
    skillKey,
    kind,
    at: seconds * 1000,
    room: "gym",
    traceId: "t",
    score: 0.9,
    reason: kind,
  };
}

const rep = (s: number) => at("reps", s, "entered");
const rack = (s: number) => at("rack", s, "exited");

test("an unordered goal is untouched by any of this", () => {
  const out = evaluate(
    goal({ doneMin: 2 }),
    [link("reps", null, 2)],
    [rep(1), rep(2), rep(3)],
    new Map(),
  );
  assert.equal(out.sequence, undefined, "no sequence detail on an unordered goal");
  assert.equal(out.observed, 3, "unordered counters still report reps");
  assert.equal(out.settled, true);
});

test("observed is passes, not events", () => {
  // Two sets of two. Ten reps would be the wrong unit: the goal is sets.
  const links = [link("rack", 0), link("reps", 1, 2)];
  const out = evaluate(
    goal({ doneMin: 2 }),
    links,
    [rack(0), rep(1), rep(2), rack(10), rep(11), rep(12)],
    new Map(),
  );
  assert.equal(out.observed, 2);
  assert.equal(out.settled, true);
  assert.equal(out.sequence?.completions, 2);
});

test("three sets of ten do not settle on the first set", () => {
  const links = [link("rack", 0), link("reps", 1, 10)];
  const transitions: Transition[] = [rack(0)];
  for (let i = 1; i <= 10; i += 1) transitions.push(rep(i));

  const out = evaluate(goal({ doneMin: 3 }), links, transitions, new Map());
  assert.equal(out.observed, 1);
  assert.equal(out.settled, false, "one set of three is not three sets");
});

test("a part-finished set reads as progress, not as failure", () => {
  const links = [link("rack", 0), link("reps", 1, 10)];
  const out = evaluate(
    goal({ doneMin: 1 }),
    links,
    [rack(0), rep(1), rep(2), rep(3)],
    new Map(),
  );
  assert.equal(out.settled, false);
  const reps = out.subgoals.find((s) => s.skillKey === "reps");
  assert.equal(reps?.observed, 3);
  assert.equal(reps?.needed, 10);
  assert.match(reps?.why ?? "", /step 1: 3 of 10/);
  assert.equal(out.sequence?.cursor, 1, "still waiting on the reps");
});

test("reps before the rack settle nothing and are reported", () => {
  const links = [link("rack", 0), link("reps", 1, 2)];
  const out = evaluate(goal({ doneMin: 1 }), links, [rep(1), rep(2)], new Map());
  assert.equal(out.settled, false);
  assert.equal(out.observed, 0);
  assert.equal(out.sequence?.outOfOrder.length, 2);
  assert.equal(out.sequence?.cursor, 0, "still waiting on the first step");
});

test("a sequenced limit fires on one pass", () => {
  // "Do not go back to the fridge after dinner": the order is the breach.
  const links = [link("rack", 0), link("reps", 1, 1)];
  const out = evaluate(
    goal({ type: "limit", doneMax: 0 }),
    links,
    [rack(0), rep(1)],
    new Map(),
  );
  assert.equal(out.settled, true);
  assert.equal(out.observed, 1);
});

test("a sequenced limit with nothing completed is not a breach", () => {
  const links = [link("rack", 0), link("reps", 1, 1)];
  const out = evaluate(goal({ type: "limit", doneMax: 0 }), links, [rack(0)], new Map());
  assert.equal(out.settled, false);
});

test("doneMin absent means one pass is enough", () => {
  const links = [link("rack", 0), link("reps", 1, 1)];
  const out = evaluate(goal(), links, [rack(0), rep(1)], new Map());
  assert.equal(out.settled, true);
});

test("the window is taken from the goal", () => {
  const links = [link("rack", 0), link("reps", 1, 2)];
  const rows = [rack(0), rep(1), rep(700)];
  assert.equal(
    evaluate(goal({ doneMin: 1, sequenceWindowS: 600 }), links, rows, new Map()).sequence
      ?.resets,
    1,
  );
  assert.equal(
    evaluate(goal({ doneMin: 1, sequenceWindowS: 0 }), links, rows, new Map()).sequence
      ?.resets,
    0,
  );
});

test("a gate does not make a goal sequenced", () => {
  // A gate carrying an index must not flip an otherwise unordered goal onto
  // the sequenced path, where its single counter would become a one-step
  // pass and report sets instead of reps.
  const gate: GoalSkill = { ...link("person_in_gym", 0), role: "gate" };
  const out = evaluate(goal({ doneMin: 2 }), [gate, link("reps", null, 2)], [rep(1), rep(2)], new Map());
  assert.equal(out.sequence, undefined);
  assert.equal(out.observed, 2, "reps, not passes");
});
