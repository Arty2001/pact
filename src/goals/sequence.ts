/**
 * Order within a goal. Some things only count if they happen in sequence.
 *
 * "Bench press ten reps at 135" is not ten reps and a weight; it is a weight
 * and THEN ten reps, and a rep observed before the weight was read is not a
 * rep at 135 - it is a rep at nothing. The same holds without any numbers:
 * sitting at a desk before making the coffee is not making coffee and then
 * sitting down.
 *
 * The cursor is derived, never stored. Every evaluation already receives the
 * whole window of transitions in time order, so walking them reconstructs
 * exactly where the sequence stands; keeping a cursor in a table would mean
 * the ledger and the cursor could disagree, and then the ledger would stop
 * being the only thing that is true. It also stays cheap for the reason the
 * ledger is cheap: a transition exists at a state change, so twenty squats
 * is forty rows, not forty thousand frames.
 *
 * This is deliberately NOT where "down, then up" lives. That is one skill's
 * score trajectory and belongs to the state machine, which is per-skill and
 * pure. Ordering across skills is a different question asked of a different
 * input, and mixing the two would put cross-skill knowledge inside the one
 * function that must not have any.
 */

import type { GoalSkill, Transition } from "./types.ts";

/** The links sharing one `sequence_index`, in the order they must happen. */
export interface Step {
  index: number;
  links: GoalSkill[];
}

/** How far one step got in the pass that is currently open. */
export interface StepProgress {
  index: number;
  met: boolean;
  /** Per-skill credited events, so a part-finished step can be displayed. */
  counts: { skillKey: string; observed: number; needed: number }[];
}

/**
 * An event that was credited to nothing because it arrived out of turn.
 *
 * Reported rather than dropped. A low count whose cause is invisible sends
 * you looking at the detector, which is where the last three days went; a
 * low count that says "four reps while still waiting on the weight" tells
 * you what to do instead.
 */
export interface OutOfOrder {
  skillKey: string;
  at: number;
  /** The step this event belongs to, and the one the sequence wants next. */
  step: number;
  waitingOn: number;
}

export interface SequenceOutcome {
  /** Completed passes through every step. One per set. */
  completions: number;
  /** The `sequence_index` the pass is waiting on, or null once none is. */
  cursor: number | null;
  steps: StepProgress[];
  outOfOrder: OutOfOrder[];
  /** Times the pass was abandoned because the gap grew too large. */
  resets: number;
}

/** Steps, in order, from whichever links carry a sequence index. */
export function stepsOf(links: readonly GoalSkill[]): Step[] {
  const byIndex = new Map<number, GoalSkill[]>();
  for (const link of links) {
    if (link.sequenceIndex === null || link.role === "gate") continue;
    const group = byIndex.get(link.sequenceIndex);
    if (group === undefined) byIndex.set(link.sequenceIndex, [link]);
    else group.push(link);
  }
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, group]) => ({ index, links: group }));
}

/** How many times this link has to fire before its step is satisfied. */
function needed(link: GoalSkill): number {
  return link.minCount ?? 1;
}

/**
 * Does this transition count towards this link?
 *
 * The same reading the unsequenced path uses, and for the same reason: a
 * counter's reps are entries into active, while an action's session is only
 * a fact once it has finished.
 */
function credits(link: GoalSkill, t: Transition): boolean {
  return link.minCount !== null ? t.kind === "entered" : t.kind === "exited";
}

/**
 * Walk the window and work out where the sequence stands.
 *
 * `windowS` is the longest gap allowed between two steps of one pass; zero
 * means no limit. Without it a weight read at nine in the morning would go
 * on scoping reps at six in the evening, which is true of no workout.
 */
export function sequence(
  links: readonly GoalSkill[],
  transitions: readonly Transition[],
  windowS: number,
): SequenceOutcome {
  const steps = stepsOf(links);
  if (steps.length === 0) {
    return { completions: 0, cursor: null, steps: [], outOfOrder: [], resets: 0 };
  }

  // Which step each skill belongs to, and the link that put it there.
  const stepAt = new Map<string, number>();
  const linkAt = new Map<string, GoalSkill>();
  steps.forEach((step, position) => {
    for (const link of step.links) {
      stepAt.set(link.skillKey, position);
      linkAt.set(link.skillKey, link);
    }
  });

  // Sorted here rather than trusted. The caller does order its query, but a
  // mis-ordered list would not fail - it would quietly miscount, and a
  // quiet miscount is the exact failure this whole module exists to stop.
  const ordered = [...transitions].sort((a, b) => a.at - b.at);

  const progress = new Map<string, number>();
  const outOfOrder: OutOfOrder[] = [];
  let cursor = 0;
  let completions = 0;
  let resets = 0;
  let lastAt: number | null = null;

  const stepMet = (position: number): boolean =>
    steps[position].links.every((l) => (progress.get(l.skillKey) ?? 0) >= needed(l));

  const clearFrom = (position: number): void => {
    for (const step of steps.slice(position)) {
      for (const link of step.links) progress.delete(link.skillKey);
    }
  };

  for (const t of ordered) {
    const position = stepAt.get(t.skillKey);
    const link = linkAt.get(t.skillKey);
    if (position === undefined || link === undefined) continue;
    if (!credits(link, t)) continue;

    if (windowS > 0 && lastAt !== null && t.at - lastAt > windowS * 1000) {
      // The pass went cold. Anything half-finished is abandoned rather than
      // carried, because a step whose partner is hours away was not part of
      // the same effort.
      cursor = 0;
      progress.clear();
      resets += 1;
    }
    lastAt = t.at;

    if (position > cursor) {
      // Skipping ahead is never legitimate: the earlier step is a
      // precondition, and crediting this would be crediting a rep at a
      // weight nobody has read.
      outOfOrder.push({
        skillKey: t.skillKey,
        at: t.at,
        step: steps[position].index,
        waitingOn: steps[cursor].index,
      });
      continue;
    }

    if (position < cursor) {
      // Going back IS legitimate, and this asymmetry is the whole design.
      // Re-reading the weight means the next reps belong to a new set, so
      // the pass restarts here and everything above it is discarded - carry
      // it forward and set one's reps leak into set two.
      cursor = position;
      clearFrom(position);
    }

    progress.set(t.skillKey, (progress.get(t.skillKey) ?? 0) + 1);

    while (cursor < steps.length && stepMet(cursor)) cursor += 1;
    if (cursor >= steps.length) {
      completions += 1;
      cursor = 0;
      progress.clear();
    }
  }

  return {
    completions,
    cursor: cursor < steps.length ? steps[cursor].index : null,
    steps: steps.map((step, position) => ({
      index: step.index,
      met: stepMet(position),
      counts: step.links.map((l) => ({
        skillKey: l.skillKey,
        observed: progress.get(l.skillKey) ?? 0,
        needed: needed(l),
      })),
    })),
    outOfOrder,
    resets,
  };
}
