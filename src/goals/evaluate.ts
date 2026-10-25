/**
 * The goal rule. Skills report; this decides what it adds up to.
 *
 * A goal is not a model. It is a list of skills plus a rule about them, and
 * that rule is the only thing separating "apply moisturizer every evening"
 * from "stop snacking after 9pm" - identical skills, identical state
 * machines, identical thresholds, inverted conclusion. Keeping the rule here
 * and out of the skills is what makes a limit goal need no new machinery.
 *
 * Pure, like the state machine and for the same reason: given a goal, its
 * skill rows and the transitions inside a window, the verdict is a function
 * with no clock and no database in it, so it can be tested against recorded
 * rows.
 */

import { sequence, stepsOf } from "./sequence.ts";
import type { SequenceOutcome } from "./sequence.ts";
import type { GoalSkill, Goal, Transition } from "./types.ts";

/** What one required skill contributed, and whether it was enough. */
export interface SubgoalResult {
  skillKey: string;
  role: string;
  met: boolean;
  /** Sessions for an action, entries for a counter, 1 or 0 for an object. */
  observed: number;
  needed: number;
  why: string;
}

export interface Verdict {
  /** True when a target goal is satisfied, or a limit goal is breached. */
  settled: boolean;
  /** Totals the instance records: seconds for an action, reps for a counter. */
  observed: number;
  subgoals: SubgoalResult[];
  /** Which skills still need a person to answer before this can settle. */
  awaiting: string[];
  /** Set only for a goal whose links are ordered. Drives the step display. */
  sequence?: SequenceOutcome;
}

/**
 * Does a local wall-clock window contain this instant?
 *
 * Windows may cross midnight, which is the normal case rather than the edge
 * case: an evening routine is 17:00 to 02:00, and treating that as an empty
 * range would silently credit nothing.
 */
export function inWindow(hhmmStart: string, hhmmEnd: string, localMinutes: number): boolean {
  const start = toMinutes(hhmmStart);
  const end = toMinutes(hhmmEnd);
  return start <= end
    ? localMinutes >= start && localMinutes < end
    : localMinutes >= start || localMinutes < end;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((n) => Number.parseInt(n, 10));
  return h * 60 + (m || 0);
}

/**
 * Evaluate one goal against the transitions in its window.
 *
 * `transitions` must already be filtered to the occurrence's window; doing
 * that here would need a clock and a timezone, which is what keeps this
 * function testable.
 */
export function evaluate(
  goal: Goal,
  links: GoalSkill[],
  transitions: Transition[],
  metricAnswers: Map<string, number>,
): Verdict {
  // An ordered goal is a different question, not a variation on this one:
  // it reads transitions in time order and asks where the pass has got to,
  // where this reads them per skill and asks how many there were. Branching
  // here rather than threading order through the loop below keeps the
  // unordered path exactly as it was.
  if (stepsOf(links).length > 0) return evaluateSequenced(goal, links, transitions);

  const subgoals: SubgoalResult[] = [];
  const awaiting: string[] = [];
  let observed = 0;

  for (const link of links) {
    // The gate is a precondition, not a sub-goal. Nothing below it could have
    // fired without it, so scoring it again would double-count the same fact.
    if (link.role === "gate") continue;

    const mine = transitions.filter((t) => t.skillKey === link.skillKey);

    if (link.role === "discriminating") {
      // A shared discriminator: this goal only wants its own class, and a
      // confident call for a different class is a conflict rather than a miss.
      const hit = mine.find((t) => t.classKey === link.classKey);
      subgoals.push({
        skillKey: link.skillKey,
        role: link.role,
        met: hit !== undefined,
        observed: hit ? 1 : 0,
        needed: 1,
        why: hit ? `classified ${link.classKey}` : `no ${link.classKey} in window`,
      });
      continue;
    }

    const answer = metricAnswers.get(link.skillKey);
    if (answer !== undefined) {
      const needed = goal.doneMin ?? 0;
      subgoals.push({
        skillKey: link.skillKey,
        role: link.role,
        met: answer >= needed,
        observed: answer,
        needed,
        why: `answered ${answer}`,
      });
      observed = Math.max(observed, answer);
      continue;
    }

    if (link.minCount !== null) {
      // A counter. Entries into active are reps, so the last transition's
      // running count is the total rather than the number of rows.
      const entries = mine.filter((t) => t.kind === "entered");
      const reps = entries.length;
      subgoals.push({
        skillKey: link.skillKey,
        role: link.role,
        met: reps >= link.minCount,
        observed: reps,
        needed: link.minCount,
        why: `${reps} entries`,
      });
      observed = Math.max(observed, reps);
      continue;
    }

    const sessions = mine.filter((t) => t.kind === "exited");
    const totalMs = sessions.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);

    if (link.accumulate) {
      // Durations sum across the day until the threshold is crossed. Same
      // state machine, different reading of its output.
      const seconds = Math.round(totalMs / 1000);
      const needed = goal.doneMin ?? 0;
      observed += seconds;
      subgoals.push({
        skillKey: link.skillKey,
        role: link.role,
        met: seconds >= needed,
        observed: seconds,
        needed,
        why: `${sessions.length} sessions totalling ${seconds}s`,
      });
      continue;
    }

    const fired = sessions.length > 0;
    subgoals.push({
      skillKey: link.skillKey,
      role: link.role,
      met: fired,
      observed: sessions.length,
      needed: 1,
      why: fired ? `${sessions.length} sessions` : "never fired",
    });
    if (fired) observed = Math.max(observed, Math.round(totalMs / 1000));
  }

  // A metric with no answer yet leaves the instance unsure rather than
  // failed. An unanswered question must never be a verdict.
  for (const link of links) {
    if (link.role === "gate") continue;
    const seen = subgoals.find((s) => s.skillKey === link.skillKey);
    if (seen === undefined) awaiting.push(link.skillKey);
  }

  const required = subgoals.filter((s) => s.role !== "gate");
  const allMet = required.length > 0 && required.every((s) => s.met);

  // A limit fires when it happens at all, which is the inverse of every
  // other goal and the only line that distinguishes the two.
  const settled =
    goal.type === "limit" ? required.some((s) => s.observed > (goal.doneMax ?? 0)) : allMet;

  return { settled, observed, subgoals, awaiting };
}

/**
 * Evaluate a goal whose links carry a sequence index.
 *
 * `observed` is completed passes, so "three sets of ten" has doneMin 3 and
 * each pass is a set. The per-step counts describe the pass that is open
 * right now, which is what makes a part-finished set legible rather than
 * looking like a failure.
 *
 * Settling comes from the completion count and not from the subgoal rows,
 * because a subgoal row describes the open pass: after two of three sets the
 * open pass is empty, and `every(met)` over it would read as nothing done.
 */
function evaluateSequenced(
  goal: Goal,
  links: GoalSkill[],
  transitions: Transition[],
): Verdict {
  const out = sequence(links, transitions, goal.sequenceWindowS);
  const needed = Math.max(goal.doneMin ?? 1, 1);

  const subgoals: SubgoalResult[] = out.steps.flatMap((step) =>
    step.counts.map((count) => ({
      skillKey: count.skillKey,
      role: "required",
      met: count.observed >= count.needed,
      observed: count.observed,
      needed: count.needed,
      why:
        count.observed >= count.needed
          ? `step ${step.index} satisfied`
          : `step ${step.index}: ${count.observed} of ${count.needed}`,
    })),
  );

  const settled =
    goal.type === "limit"
      ? out.completions > (goal.doneMax ?? 0)
      : out.completions >= needed;

  // A metric step would belong here, since an unanswered measurement must
  // leave the instance unsure rather than failed. Ordering shipped without
  // it on purpose: the measurement path reports an unanswered metric as
  // "never fired", and a sequence cannot paper over that.
  return { settled, observed: out.completions, subgoals, awaiting: [], sequence: out };
}
