/**
 * The sequencer, which is the one piece of goal logic with real branching in
 * it: credit, reject, rewind, reset, complete. Each of those has a wrong
 * version that still returns a plausible number, which is why they are
 * tested rather than read.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { sequence, stepsOf } from "./sequence.ts";
import type { GoalSkill, Transition } from "./types.ts";

function link(skillKey: string, index: number | null, minCount: number | null = null): GoalSkill {
  return {
    goalKey: "g",
    skillKey,
    role: "required",
    classKey: null,
    minCount,
    accumulate: false,
    sequenceIndex: index,
  };
}

/** `at` is milliseconds, matching what the transitions table stores. */
function entered(skillKey: string, atSeconds: number): Transition {
  return {
    skillKey,
    kind: "entered",
    at: atSeconds * 1000,
    room: "gym",
    traceId: "t",
    score: 0.9,
    reason: "dwell satisfied",
  };
}

function exited(skillKey: string, atSeconds: number): Transition {
  return { ...entered(skillKey, atSeconds), kind: "exited", reason: "exit confirmed" };
}

test("no sequence index means no steps, so nothing is sequenced", () => {
  const out = sequence([link("squat", null, 10)], [entered("squat", 1)], 600);
  assert.equal(out.completions, 0);
  assert.equal(out.cursor, null);
  assert.deepEqual(out.steps, []);
});

test("steps come out in index order regardless of link order", () => {
  const steps = stepsOf([link("reps", 2), link("weight", 1), link("rack", 0)]);
  assert.deepEqual(
    steps.map((s) => s.index),
    [0, 1, 2],
  );
});

test("a gate never becomes a step, even carrying an index", () => {
  const gate: GoalSkill = { ...link("person_in_gym", 0), role: "gate" };
  const steps = stepsOf([gate, link("reps", 1, 3)]);
  assert.deepEqual(
    steps.map((s) => s.index),
    [1],
  );
});

test("steps in order complete one pass", () => {
  const links = [link("coffee", 0), link("desk", 1)];
  const out = sequence(links, [exited("coffee", 10), exited("desk", 20)], 600);
  assert.equal(out.completions, 1);
  assert.equal(out.outOfOrder.length, 0);
});

test("the later step alone is rejected, not credited", () => {
  const links = [link("coffee", 0), link("desk", 1)];
  const out = sequence(links, [exited("desk", 10)], 600);
  assert.equal(out.completions, 0);
  assert.equal(out.outOfOrder.length, 1);
  assert.deepEqual(out.outOfOrder[0], {
    skillKey: "desk",
    at: 10_000,
    step: 1,
    waitingOn: 0,
  });
});

test("a rejected event stays rejected once the order is put right", () => {
  // The early desk sitting is gone; only the one after the coffee counts.
  const links = [link("coffee", 0), link("desk", 1)];
  const out = sequence(
    links,
    [exited("desk", 5), exited("coffee", 10), exited("desk", 20)],
    600,
  );
  assert.equal(out.completions, 1);
  assert.equal(out.outOfOrder.length, 1);
});

test("a counter needs min_count entries before its step is satisfied", () => {
  const links = [link("weight", 0), link("reps", 1, 3)];
  const out = sequence(
    links,
    [exited("weight", 0), entered("reps", 1), entered("reps", 2)],
    600,
  );
  assert.equal(out.completions, 0);
  assert.equal(out.cursor, 1);
  assert.deepEqual(out.steps[1].counts, [{ skillKey: "reps", observed: 2, needed: 3 }]);
});

test("the pass completes on the last rep and not before", () => {
  const links = [link("weight", 0), link("reps", 1, 3)];
  const out = sequence(
    links,
    [exited("weight", 0), entered("reps", 1), entered("reps", 2), entered("reps", 3)],
    600,
  );
  assert.equal(out.completions, 1);
});

test("two full passes are two completions", () => {
  const links = [link("weight", 0), link("reps", 1, 2)];
  const out = sequence(
    links,
    [
      exited("weight", 0),
      entered("reps", 1),
      entered("reps", 2),
      exited("weight", 10),
      entered("reps", 11),
      entered("reps", 12),
    ],
    600,
  );
  assert.equal(out.completions, 2);
  assert.equal(out.outOfOrder.length, 0);
});

test("going back discards the half-finished step above it", () => {
  // Set one's two reps must not survive into set two, or the next pass
  // completes on its first rep.
  const links = [link("weight", 0), link("reps", 1, 3)];
  const out = sequence(
    links,
    [
      exited("weight", 0),
      entered("reps", 1),
      entered("reps", 2),
      exited("weight", 10), // re-racked: a new set starts here
      entered("reps", 11),
      entered("reps", 12),
    ],
    600,
  );
  assert.equal(out.completions, 0, "two reps of a three-rep set is not a set");
  assert.deepEqual(out.steps[1].counts, [{ skillKey: "reps", observed: 2, needed: 3 }]);
});

test("a gap longer than the window abandons the open pass", () => {
  const links = [link("weight", 0), link("reps", 1, 2)];
  const out = sequence(
    links,
    [exited("weight", 0), entered("reps", 1), entered("reps", 700)],
    600,
  );
  assert.equal(out.resets, 1);
  assert.equal(out.completions, 0);
  // After the reset the sequence wants step 0 again, so the late rep is
  // out of order rather than the second half of a set from ten minutes ago.
  assert.equal(out.outOfOrder.length, 1);
});

test("a window of zero means no timeout at all", () => {
  const links = [link("weight", 0), link("reps", 1, 2)];
  const out = sequence(
    links,
    [exited("weight", 0), entered("reps", 1), entered("reps", 100_000)],
    0,
  );
  assert.equal(out.resets, 0);
  assert.equal(out.completions, 1);
});

test("the wrong transition kind is not a credit", () => {
  // A counter counts entries; its exits are the same rep leaving, and
  // counting both would double every set.
  const links = [link("weight", 0), link("reps", 1, 2)];
  const out = sequence(
    links,
    [exited("weight", 0), entered("reps", 1), exited("reps", 2), entered("reps", 3)],
    600,
  );
  assert.equal(out.completions, 1);
});

test("an action's step turns on its exit, not its entry", () => {
  const links = [link("coffee", 0), link("desk", 1)];
  const entries = sequence(links, [entered("coffee", 1), entered("desk", 2)], 600);
  assert.equal(entries.completions, 0, "an unfinished session is not a fact yet");
  const done = sequence(links, [exited("coffee", 1), exited("desk", 2)], 600);
  assert.equal(done.completions, 1);
});

test("all links sharing an index must be met before the step passes", () => {
  const links = [link("shoes", 0), link("laces", 0), link("run", 1)];
  const partial = sequence(links, [exited("shoes", 1), exited("run", 2)], 600);
  assert.equal(partial.completions, 0);
  assert.equal(partial.outOfOrder.length, 1, "run came early: step 0 was half done");

  const full = sequence(
    links,
    [exited("shoes", 1), exited("laces", 2), exited("run", 3)],
    600,
  );
  assert.equal(full.completions, 1);
});

test("out-of-time input is sorted rather than miscounted", () => {
  const links = [link("coffee", 0), link("desk", 1)];
  const out = sequence(links, [exited("desk", 20), exited("coffee", 10)], 600);
  assert.equal(out.completions, 1, "coffee happened first however the rows arrived");
  assert.equal(out.outOfOrder.length, 0);
});

test("a skill in no step is ignored, not rejected", () => {
  // An unsequenced requirement is still a requirement; it is just not this
  // function's business, and treating it as out of order would invent a
  // failure the goal never had.
  const links = [link("coffee", 0), link("desk", 1), link("stretch", null)];
  const out = sequence(
    links,
    [exited("stretch", 1), exited("coffee", 2), exited("desk", 3)],
    600,
  );
  assert.equal(out.completions, 1);
  assert.equal(out.outOfOrder.length, 0);
});

test("one step is a valid sequence", () => {
  const out = sequence([link("reps", 0, 3)], [entered("reps", 1), entered("reps", 2)], 600);
  assert.equal(out.completions, 0);
  assert.equal(out.cursor, 0);
  const done = sequence(
    [link("reps", 0, 2)],
    [entered("reps", 1), entered("reps", 2)],
    600,
  );
  assert.equal(done.completions, 1);
});

test("sparse indices are positions, not step numbers", () => {
  // The planner may well emit 10 and 20. Ordering is what matters; the
  // numbers themselves are only labels, and must survive as labels.
  const links = [link("weight", 10), link("reps", 20, 2)];
  const out = sequence(links, [exited("weight", 0), entered("reps", 1)], 600);
  assert.equal(out.cursor, 20);
  assert.deepEqual(
    out.steps.map((s) => s.index),
    [10, 20],
  );
});
