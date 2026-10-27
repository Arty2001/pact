/**
 * Shapes for the goal model: skills, goals, instances, questions, and the
 * transitions perception sends up.
 *
 * Literal unions rather than enums throughout, matching `DeviceKind` in
 * `src/types.ts`. These values cross a wire and land in SQLite as text, and a
 * union is already the thing that is stored; an enum would be a second
 * representation to keep in step with it.
 */

/**
 * The six kinds of skill. They differ only in their numbers and in which part
 * of the output is read, which is what makes a rep counter configuration
 * rather than new machinery.
 *
 *   gate           is it active now? everything beneath it is skipped if not
 *   object         is it active now? a condition, not an event
 *   action         how long it stayed active. one session, with a duration
 *   counter        how many times it entered active. each entry is one rep
 *   discriminator  which one of K. the only kind returning a distribution
 *   metric         nothing. no camera can see it, so it asks you instead
 */
export type SkillKind = "gate" | "object" | "action" | "counter" | "discriminator" | "metric";

/**
 * What a skill is looking at, and what a frame came from.
 *
 * A room camera and a shared screen are both just JPEGs by the time they
 * reach perception, and they reach it down the same socket. The distinction
 * has to be carried explicitly or it is lost: a screen skill scored against a
 * bathroom camera is merely wrong, but a camera skill scored against
 * screenshots also *calibrates* against them, and calibration is what decides
 * where its thresholds sit. That failure is silent.
 *
 * `any` is for skills that genuinely do not care, and is the default so that
 * every skill written before this distinction existed keeps behaving exactly
 * as it did.
 */
export type Surface = "camera" | "screen" | "any";

/** Kinds perception scores. A metric never reaches the encoder. */
export const SCORED_KINDS: readonly SkillKind[] = [
  "gate",
  "object",
  "action",
  "counter",
  "discriminator",
];

/**
 * How a skill came to have a weight vector.
 *
 * `pending` exists because the planner cannot compute one. Skill creation
 * happens here, in the Worker, while the text encoder lives in perception, so
 * a skill is born with a label and no vector and is filled in on perception's
 * next poll. Worth knowing when reading the ledger: a pending skill is not
 * broken, it is young.
 */
export type WeightState = "pending" | "zeroshot" | "fitted";

/** Who or what settled an instance. This column is the whole trust model. */
export type SettledBy = "camera" | "vlm" | "human";

/** A goal you want to hit, or one you want to avoid. The rule is inverted. */
export type GoalType = "target" | "limit";

/** What a skill does for a goal that references it. */
export type SkillRole = "gate" | "required" | "discriminating";

export type InstanceState = "pending" | "active" | "done" | "violated" | "missed";

/**
 * One skill. Shared by every goal rather than owned by one, which is what
 * makes the second goal in a room nearly free.
 */
export interface Skill {
  key: string;
  kind: SkillKind;
  /** What a camera would literally see. This text is the zero-shot weight. */
  label: string;
  room: string | null;
  /** Camera frames, screen frames, or both. See `Surface`. */
  surface: Surface;
  /** Self-referencing: the gate tree, written by the planner. */
  dependsOn: string | null;

  enterConf: number;
  exitConf: number;
  dwellS: number;
  exitS: number;
  cooldownS: number;
  escalateAfterS: number;
  /**
   * Shortest believable gap between two counts, measured count-to-count.
   * A pose detector fires honestly every time you are in the pose, so a
   * counter needs a floor that cooldown cannot express: cooldown runs from
   * the end of a session, not from the previous count.
   */
  minCycleS: number;

  /** Discriminator only. The last entry is always the implicit `none`. */
  classes: string[] | null;
  /** Discriminator only: the top class must beat the runner-up by this. */
  margin: number | null;

  /**
   * The fitted score calibration. `sigmoid((w . e - bias) / temperature)`.
   * Not optional decoration: with bias at zero and temperature at one, every
   * score lands between 0.475 and 0.599 and `enterConf` is unreachable.
   */
  bias: number;
  temperature: number;

  /**
   * Which embedding space `w` was fitted in, as `model/adaptor@resolution`.
   * A vector is meaningless under a different encoder and the failure is
   * silent, so perception refuses to score on a mismatch rather than
   * returning confident nonsense.
   */
  encoderId: string | null;
  dim: number | null;
  weightState: WeightState;
  /** Labels collected. A young skill runs looser and asks more often. */
  nLabels: number;

  /**
   * Frames per second this skill needs. Per skill because the range is wide:
   * a gate asking "is anyone here" is fine at 0.5, while a bench press rep
   * lasts two to four seconds and is invisible below about 4. The sampler
   * takes the maximum over whatever is currently eligible.
   */
  sampleHz: number;

  createdAt: number;
}

export interface Goal {
  /** Where the target came from, when the sentence did not name one. */
  sourceUrl?: string | null;
  key: string;
  description: string;
  type: GoalType;
  /** "daily" | "weekly:3" | "weekly:5". Parsed when materialising occurrences. */
  cadence: string;
  doneMin: number | null;
  doneMax: number | null;
  /** Local wall-clock window, e.g. ["17:00", "02:00"]. May cross midnight. */
  windowStart: string | null;
  windowEnd: string | null;
  /**
   * The user's zone, as an IANA name. Required rather than inferred: a window
   * of 17:00 to 02:00 is meaningless without one, and a Durable Object runs
   * in UTC.
   */
  tz: string;

  /**
   * Longest gap between two steps of one sequenced pass, in seconds. Zero
   * disables the timeout. Ignored by a goal whose links carry no
   * sequence index, which is every unordered goal.
   */
  sequenceWindowS: number;

  /** Progressions: 135 lb, +5 a week, only when the last one succeeded. */
  stepValue: number | null;
  stepPeriod: "week" | "month" | null;
  stepOn: "success" | "always" | null;

  createdAt: number;
}

/** The join table. This row is the sharing. */
export interface GoalSkill {
  goalKey: string;
  skillKey: string;
  role: SkillRole;
  /** Which class of a shared discriminator THIS goal wants. */
  classKey: string | null;
  /** Counters: "at least 5 reps". */
  minCount: number | null;
  /** Actions: sum durations across the day rather than settling on one. */
  accumulate: boolean;
  sequenceIndex: number | null;
}

/**
 * One occurrence of one goal, and how it ended.
 *
 * `targetMin` is frozen when the instance is created rather than read from the
 * goal at settle time. That is what makes progressions work: this week's
 * target stays this week's target even after next week's has been raised.
 */
export interface Instance {
  id: string;
  goalKey: string;
  /** The local date this occurrence belongs to, as YYYY-MM-DD. */
  occurrenceOn: string;
  state: InstanceState;
  observed: number;
  targetMin: number | null;
  settledAt: number | null;
  settledBy: SettledBy | null;
  /** When this occurrence was last spoken about without being asked. */
  nudgedAt: number | null;
  createdAt: number;
}

export interface Question {
  id: string;
  instanceId: string;
  skillKey: string;
  prompt: string;
  /** Pre-filled, so the common case is one tap rather than a form. */
  proposedValue: string | null;
  askedAt: number;
  answeredAt: number | null;
  answer: string | null;
}

/**
 * What perception sends up. The only thing that crosses the process boundary.
 *
 * Perception computes several scores a second and none of them appear here.
 * That is the "7,200 scores an hour becomes one event" property expressed as
 * a wire format: if a score could be posted, it eventually would be, and the
 * control plane would drown in them.
 */
export interface Transition {
  skillKey: string;
  kind: "entered" | "exited" | "rejected" | "escalate";
  at: number;
  room: string;
  traceId: string;
  score: number;
  reason: string;

  dwellMs?: number;
  durationMs?: number;
  heldMs?: number;
  neededMs?: number;
  /**
   * On a rejection where dwell was satisfied, the confidence the score had to
   * reach. Zero when duration was the binding constraint. The two want
   * opposite fixes, so the field is what makes them distinguishable.
   */
  neededConf?: number;
  peak?: number;
  count?: number;

  /** Discriminator outcome, when one was involved in this transition. */
  classKey?: string;
  p1?: number;
  p2?: number;
  margin?: number;
  /** Set when a teacher call resolved this rather than the camera alone. */
  verdictBy?: SettledBy;
}

/** Engine -> perception. The registry, pushed rather than polled for. */
export type EngineMessage =
  | { type: "registry"; skills: Skill[]; encoderId: string | null }
  | {
      type: "frame";
      room: string;
      /** Where this picture came from, so only matching skills score it. */
      surface: Surface;
      seq: number;
      ts: number;
      jpegBase64: string;
    }
  | { type: "rate"; room: string; hz: number }
  /**
   * A person's answer, on its way to becoming a training example.
   *
   * The answer is decided here and the embedding it describes lives in
   * perception, so the label has to travel. `at` is the moment being
   * labelled, not the moment the answer arrived - the two are seconds apart
   * and the frame belongs to the first one.
   */
  | {
      type: "label";
      room: string;
      skillKey: string;
      at: number;
      /**
       * A stretch of time to label, rather than one moment.
       *
       * The single most useful correction a person can make is about
       * something the cameras MISSED, and that case has no moment to point
       * at: nothing fired, so there is no transition to anchor to and no
       * question to answer. "I was doing that for the last twenty minutes"
       * is the natural way to say it, and it is also the only way to produce
       * labels in the quantity a refit needs - one sentence covers every
       * frame in the window instead of one.
       *
       * Absent means a single moment, which is what a teacher verdict or an
       * answered question is. `from`/`to` are inclusive epoch ms.
       */
      from?: number;
      to?: number;
      label: 0 | 1;
      source: string;
    }
  /**
   * Work out what this skill should have been looking for, and say so.
   *
   * Distinct from a label, which is one more piece of evidence toward a
   * refit that needs tens of them. This asks for the sentence itself to be
   * reconsidered, which perception can answer from one complaint: it has
   * the frames, something that can see them, and the embeddings to measure
   * any candidate against what this skill normally scores.
   */
  | {
      type: "relabel";
      room: string;
      skillKey: string;
      /**
       * The stretch being complained about, inclusive epoch ms.
       *
       * Carried rather than guessed at because the complaint already knows
       * it: "I was doing that all morning" names a window, and reading the
       * label off the last ninety seconds instead would describe whatever
       * is in front of the camera now - which, by the time someone has
       * finished saying it, is a person talking to a laptop.
       */
      from?: number;
      to?: number;
    };

/** Perception -> Engine. */
export type PerceptionMessage =
  | { type: "hello"; room: string; encoderId: string; dim: number }
  /** "this room needs N fps now", from the skills currently eligible there. */
  | { type: "rate"; room: string; hz: number }
  /**
   * A downsampled snapshot of what every eligible skill is scoring.
   *
   * Fanned to watching browsers and never written anywhere. That is not a
   * loophole in the "the ledger never sees scores" rule, it is the rule: a
   * live view of a number is not a record of it, and nothing here survives
   * the socket closing.
   */
  | {
      type: "scores";
      room: string;
      hz: number;
      scores: Record<string, { score: number; phase: string }>;
    }
  | { type: "transition"; transition: Transition }
  | { type: "weights"; skillKey: string; encoderId: string; dim: number; w: string; bias: number; temperature: number }
  | {
      type: "refit";
      skillKey: string;
      nExamples: number;
      holdoutBefore: number;
      holdoutAfter: number;
      /**
       * Whether the new vector was kept. A refit that cannot beat what it
       * replaced is discarded, and that outcome is reported rather than
       * swallowed: someone who has just spoken a correction is asking "did
       * that do anything", and a declined fit answers it.
       */
      accepted?: boolean;
    }
  /**
   * A label perception measured as better than the one in use.
   *
   * Carried as a proposal rather than a write because a label is the whole
   * detector: it is what the vector started as, what a refit drifts away
   * from, and the only part of a skill a person can read. Changing it is a
   * change to what the system believes, so it arrives with the numbers that
   * argue for it and waits.
   */
  | {
      type: "proposal";
      skillKey: string;
      label: string;
      /** Separation over spread, for the proposed label and the current one. */
      ratioAfter: number;
      ratioBefore: number;
      /** The ones that lost, so a person can pick a different winner. */
      runnersUp: string[];
    };
