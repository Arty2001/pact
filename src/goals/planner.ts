import { Nebius, type Tool } from "./nebius";
import type { Skill } from "./types";

/**
 * Sentence in, goal draft out.
 *
 * The planner's real job is reuse, not invention. A goal is a list of skills
 * plus a rule about them, and the first goal in a room legitimately costs
 * three or four new skills while every goal after it should cost one - the
 * thing that makes it different. That only happens if the model can see what
 * already exists, so the catalogue goes in the prompt and `create_skill` is
 * described as the expensive option it is.
 *
 * The output is a draft rather than a commit. It fills the same form a person
 * would have filled, and a person presses the button. That is not timidity
 * about the model: a skill's label IS its detector, so a sentence that reads
 * fine but describes something a camera cannot see produces a skill that
 * silently never fires, and the cheapest place to catch that is before it is
 * written down.
 */

/** Text planner. Tool calling, no images. */
const PLANNER_MODEL = "nvidia/nemotron-3-super-120b-a12b";

/**
 * How many tool turns to allow before giving up.
 *
 * A goal needs at most one turn per new skill plus one for the goal itself,
 * and the first goal in a room is the expensive one at three or four skills.
 * Six leaves room for that without letting a confused model bill for an
 * unbounded conversation.
 */
const MAX_TURNS = 6;

const SYSTEM = `You turn a plain sentence about a habit or goal into skills and a goal rule for a tracker that watches either a ROOM CAMERA or a SHARED SCREEN.

A skill is a single visual question about one frame. Its label becomes the detector directly, with no training, so the label must describe what would LITERALLY BE SEEN. Never an intention, a feeling, or anything requiring memory of earlier frames.

Good labels:   "a person standing at a bathroom sink"
               "a person lying on a bench pressing a barbell upward"
Bad labels:    "someone being healthy"  (not visible)
               "the user finished their routine"  (needs memory)

The six kinds:
  gate          a place or presence. Everything beneath it is skipped when it is false.
  object        a thing being held or present. A condition, not an event.
  action        something done over time. Read as a duration.
  counter       a repeated movement. Each repetition is one entry. Use for reps.
  discriminator one of K similar things. Use when two things answer the same sentence.
  metric        a number no camera can read, like weight on a bar. It asks the person.

EVERY skill has a surface: "camera" for a room camera, "screen" for a shared screen. Choose by what the goal is actually about. Desk work, studying, coding, writing, reading, email, meetings and screen time are all "screen" goals - a camera pointed at a desk shows a person sitting, which is true whatever they are doing, so it cannot tell study from scrolling. Physical habits, rooms and bodies are "camera".

Screen skills follow one extra rule, and it is the one that decides whether they work.

The detector behind a label CANNOT READ TEXT. It recognises the overall look of a screen - a code editor, a spreadsheet, a video player, a chat app, a slide deck, a terminal. It cannot tell one file from another, Python from JavaScript, or a work document from a personal one. So:

  - a "screen" GATE must name a recognisable kind of screen, not a specific thing:
      good: "a code editor filling the screen, with a file tree and syntax-highlighted code"
      bad:  "VS Code with main.py open"      (needs reading)
  - the CHILD beneath it is where the specific thing goes. It is allowed to be
    specific, because when it is uncertain a vision-language model that CAN read
    the screen is asked to settle it:
      good: "Python source code being edited, with def and import statements visible"

Describe appearance, layout and colour, not brand names. "a dark code editor with a file tree down the left" beats "VS Code".

Screen goals are nearly always an "action" child accumulating time beneath a "screen" gate. Set accumulate true on the child so sessions sum across the day, and set done_min to the number of SECONDS the goal needs - an hour is 3600.

Reuse is the point. Call create_skill ONLY when no existing skill fits. Prefer an existing one even if its label is not a perfect match for your phrasing. Never reuse a skill whose surface is wrong for this goal.

Always include exactly one gate, and give every non-gate skill a depends_on pointing at it. Call create_goal exactly once, last.`;

const TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "create_skill",
      description:
        "Define a NEW visual skill. Expensive: it adds a detector that must be " +
        "calibrated before it is trustworthy. Only call this when no existing " +
        "skill in the catalogue fits. Prefer reuse.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "snake_case identifier, e.g. person_in_bathroom" },
          kind: {
            type: "string",
            enum: ["gate", "object", "action", "counter", "discriminator", "metric"],
          },
          label: {
            type: "string",
            description: "What a camera would literally see. This text IS the detector.",
          },
          room: { type: "string", description: "bathroom, gym, kitchen, office, ..." },
          surface: {
            type: "string",
            enum: ["camera", "screen"],
            description:
              "What this watches. 'screen' for a shared screen, 'camera' for a room camera. " +
              "A skill is only ever scored against frames from its own surface.",
          },
          depends_on: {
            type: "string",
            description: "Key of the skill that gates this one. Usually the gate.",
          },
          classes: {
            type: "array",
            items: { type: "string" },
            description: "Discriminator only: the mutually exclusive options.",
          },
        },
        required: ["key", "kind", "label"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_goal",
      description: "Define the rule over the skills. Call exactly once, after any create_skill.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "namespaced, e.g. skincare/moisturizer" },
          description: { type: "string" },
          type: {
            type: "string",
            enum: ["target", "limit"],
            description: "limit inverts the rule: firing at all is a violation.",
          },
          cadence: { type: "string", enum: ["daily", "weekly:1", "weekly:3", "weekly:5"] },
          done_min: {
            type: "number",
            description:
              "The threshold to hit. SECONDS for an accumulating action, so an hour is 3600.",
          },
          window_start: { type: "string", description: "local HH:MM" },
          window_end: { type: "string", description: "local HH:MM, may cross midnight" },
          uses: {
            type: "array",
            items: {
              type: "object",
              properties: {
                skill_key: { type: "string" },
                role: { type: "string", enum: ["gate", "required", "discriminating"] },
                class_key: { type: "string" },
                min_count: { type: "number" },
                accumulate: { type: "boolean" },
              },
              required: ["skill_key", "role"],
            },
          },
        },
        required: ["key", "description", "cadence", "uses"],
      },
    },
  },
];

export interface PlanDraft {
  key: string;
  description: string;
  type: string;
  cadence: string;
  doneMin: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  uses: Array<{
    key: string;
    label: string;
    kind: string;
    /** "camera" | "screen" | "any". Decides which frames ever score it. */
    surface: string;
    /**
     * The gate above this skill. Carried out of the draft rather than
     * discarded: without it there is no gate tree, every skill is scored
     * against every frame, and the two-tier "cheap question, then expensive
     * question" structure the planner was asked to build does not exist.
     */
    dependsOn: string | null;
    role: string;
    classKey: string | null;
    minCount: number | null;
    /** Actions: sum sessions across the day instead of settling on one. */
    accumulate: boolean;
    isNew: boolean;
  }>;
  reused: number;
  created: number;
  usage: { prompt: number; completion: number; reasoning: number };
}

export async function plan(
  apiKey: string,
  sentence: string,
  catalogue: Skill[],
  tz: string,
): Promise<PlanDraft> {
  const listing =
    catalogue.length === 0
      ? "(empty - this is the first goal, so new skills are expected)"
      : catalogue
          .map((s) => `  ${s.key}  ${s.kind}  "${s.label}"${s.room ? `  [${s.room}]` : ""}`)
          .join("\n");

  const nebius = new Nebius(apiKey);
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content:
        `EXISTING SKILLS - reuse whenever one fits:\n${listing}\n\n` +
        `The person's timezone is ${tz}.\n\n` +
        `Their goal: "${sentence}"`,
    },
  ];

  const known = new Map(catalogue.map((s) => [s.key, s]));
  const drafted = new Map<
    string,
    { kind: string; label: string; surface: string; dependsOn: string | null }
  >();
  let goal: Record<string, unknown> | null = null;
  const usage = { prompt: 0, completion: 0, reasoning: 0 };

  /**
   * A tool conversation, not a single call.
   *
   * This was a single request at first and it worked only by accident: a goal
   * that reuses everything reaches create_goal on the first turn, so the
   * bathroom case passed while every goal needing a new skill failed with no
   * create_goal at all. A tool-calling model emits create_skill and then
   * stops, waiting to be told it succeeded. Each result has to go back,
   * echoing the call id, before it will continue.
   */
  for (let turn = 0; turn < MAX_TURNS && goal === null; turn++) {
    const out = await nebius.chat({
      model: PLANNER_MODEL,
      tools: TOOLS,
      maxTokens: 2048,
      messages,
    });
    usage.prompt += out.usage.prompt;
    usage.completion += out.usage.completion;
    usage.reasoning += out.usage.reasoning;

    if (out.toolCalls.length === 0) {
      // Empty content with reasoning present is the max_tokens trap, and it
      // is worth naming rather than reporting a generic failure.
      const hint =
        out.content === "" && out.reasoning !== "" ? " (ran out of budget while reasoning)" : "";
      throw new Error(`planner stopped calling tools after ${turn} turn(s)${hint}`);
    }

    messages.push(out.raw as Record<string, unknown>);

    for (const call of out.toolCalls) {
      let result: string;
      if (call.name === "create_skill") {
        const key = String(call.args.key ?? "");
        if (key) {
          drafted.set(key, {
            kind: String(call.args.kind ?? "object"),
            label: String(call.args.label ?? ""),
            surface: call.args.surface === "screen" ? "screen" : "camera",
            dependsOn: call.args.depends_on ? String(call.args.depends_on) : null,
          });
        }
        result = JSON.stringify({ ok: true, key, note: "drafted; now call create_goal" });
      } else if (call.name === "create_goal") {
        goal = call.args;
        result = JSON.stringify({ ok: true });
      } else {
        result = JSON.stringify({ ok: false, error: `unknown tool ${call.name}` });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  if (goal === null) {
    throw new Error(`planner never called create_goal within ${MAX_TURNS} turns`);
  }

  const rawUses = Array.isArray(goal.uses) ? (goal.uses as Array<Record<string, unknown>>) : [];
  const uses = rawUses.map((u) => {
    const key = String(u.skill_key ?? "");
    const existing = known.get(key);
    const fresh = drafted.get(key);
    const kind = existing?.kind ?? fresh?.kind ?? "object";
    return {
      key,
      label: existing?.label ?? fresh?.label ?? "",
      kind,
      surface: existing?.surface ?? fresh?.surface ?? "any",
      dependsOn: existing?.dependsOn ?? fresh?.dependsOn ?? null,
      role: String(u.role ?? "required"),
      classKey: u.class_key === undefined ? null : String(u.class_key),
      minCount: u.min_count === undefined ? null : Number(u.min_count),
      // An accumulating action is the shape nearly every screen goal wants -
      // "an hour of this today", summed over however many sittings it took -
      // so it is defaulted on rather than left to be asked for and forgotten.
      // Without it a goal settles on the first session of any length, which
      // would credit a full hour for thirty seconds of having the right
      // window open.
      accumulate: u.accumulate === undefined ? kind === "action" : Boolean(u.accumulate),
      isNew: existing === undefined,
    };
  });

  return {
    key: String(goal.key ?? ""),
    description: String(goal.description ?? sentence),
    type: String(goal.type ?? "target"),
    cadence: String(goal.cadence ?? "daily"),
    doneMin: goal.done_min === undefined ? null : Number(goal.done_min),
    windowStart: goal.window_start === undefined ? null : String(goal.window_start),
    windowEnd: goal.window_end === undefined ? null : String(goal.window_end),
    uses,
    reused: uses.filter((u) => !u.isNew).length,
    created: uses.filter((u) => u.isNew).length,
    usage,
  };
}
