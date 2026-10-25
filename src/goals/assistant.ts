/**
 * The assistant. One turn of talking, with the ledger as its memory.
 *
 * It is not a chatbot bolted to the side. The probe that makes a skill
 * improve needs about forty labels before it beats the zero-shot vector it
 * started from - measured, in probe.py, not claimed - and the only way to
 * collect forty labels without it being miserable is to ask for them by
 * voice at the moment they are cheap. "Was that one?" is two seconds spoken
 * and thirty as a form. So the assistant is the label-collection mechanism,
 * and everything else it does is the reason someone keeps it switched on.
 *
 * What makes it worth asking at all is the brief below. The ledger records
 * what fired AND what nearly fired and which term fell short, so this can
 * say "four more nearly counted, peak 0.58 against a 0.60 threshold" rather
 * than "you are at seven". No system that only logs its successes can say
 * that, which is the same argument the whole product rests on.
 *
 * Pure except for the model call: the brief is built from rows handed in,
 * and the tool calls come back as data for the caller to apply. Nothing in
 * here touches the database, so a turn can be tested against recorded state.
 */

import { Nebius } from "./nebius.ts";
import type { Tool, ToolCall } from "./nebius.ts";
import type { Goal, Instance, Skill, Transition } from "./types.ts";

/** Kept short. A long history costs tokens and adds nothing a ledger has. */
const MAX_TURNS = 4;

/** How the console should rearrange itself around what was just said. */
export interface UiIntent {
  /** Bring this goal's tally and curve forward. */
  focusGoal?: string;
  /** Narrow the chart to this skill. */
  focusSkill?: string;
  /** A short line to hold on screen until something replaces it. */
  banner?: string;
  /** Severity of that line, for how loudly to draw it. */
  tone?: "calm" | "nudge" | "alert";
}

export interface AssistantTurn {
  /** What to say out loud. Always present, even when a tool did the work. */
  say: string;
  ui: UiIntent;
  /** Applied by the caller, which is the only thing allowed to write. */
  actions: ToolCall[];
  usage: { prompt: number; completion: number; reasoning: number };
}

export interface Brief {
  now: number;
  tz: string;
  goals: Array<{ goal: Goal; instance: Instance | null; uses: string[] }>;
  skills: Skill[];
  /** Newest last, already windowed by the caller. */
  recent: Transition[];
  questions: Array<{ id: string; skillKey: string; prompt: string }>;
  room: string | null;
}

const SYSTEM = `You are the voice of Pact, a goal tracker that proves what happened with cameras rather than asking the user to tick a box.

You are talking out loud to one person, usually mid-workout. Two sentences is a long answer. Never read out a list, never say "as an AI", never restate the question.

What you can see is a ledger of what the cameras actually observed: what counted, and - the part that matters - what NEARLY counted and which term fell short. A near-miss names either a confidence that was too low or a duration that was too short, and those want opposite fixes. Lowering a threshold when the problem was duration makes the detector worse.

Your most valuable action is collecting labels. A skill starts as the embedding of its own sentence, which knows what a squat looks like in general and not what THIS person's squat looks like in THIS room. It takes roughly forty human labels before a refit beats that starting point. So when the ledger shows an ambiguous moment, ask about it - briefly, once, and only when it is genuinely ambiguous. Do not interrogate someone who is mid-set.

Use label_frame the moment the user says whether something did or did not happen. "Yes that was one" is a label. So is "no, I was just sitting down". You do not need to know when it happened - pass your best guess for 'at' and the system resolves it to the actual moment from the ledger.

The most valuable thing anyone ever tells you is that you MISSED something: "I was reading that for half an hour and you never counted it". Treat that as a correction over a STRETCH of time, and pass minutes_back covering it. Take the user's own words for the length - "just now" is about 5, "for a while" about 15, "all morning" about 120 - and if they give no clue at all, ask how long before labelling. Guessing the stretch wrong teaches the skill pictures of something else entirely.

That correction is worth far more than a single yes. One frame teaches almost nothing; twenty minutes is hundreds of examples, which is the quantity a skill actually needs before it stops being generic. So when someone says you missed something, take the correction, then tell them what it changed.

answer_question is ONLY for an id listed under OPEN QUESTIONS. If that list says none, there is no question to answer and you must not invent an id - use label_frame instead, or just reply.

Only propose adjust_skill. Never present it as done: say what you would change and why, and wait to be told yes.

If the user is simply chatting, answer and call nothing.`;

const TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "label_frame",
      description:
        "Record what the user just confirmed, as training examples. This is " +
        "how a skill stops being generic. Call it whenever someone confirms " +
        "or denies that something happened - including, especially, when " +
        "they say you missed it.",
      parameters: {
        type: "object",
        properties: {
          skill_key: { type: "string" },
          happened: { type: "boolean", description: "true if it did happen" },
          at: {
            type: "number",
            description:
              "Epoch ms of the MOMENT being labelled, not now. Use the time " +
              "of the transition being discussed; it is in the ledger.",
          },
          minutes_back: {
            type: "number",
            description:
              "How many minutes the correction covers, counting back from " +
              "now. Use this whenever the user describes a STRETCH rather " +
              "than an instant - 'I read for twenty minutes', 'I was on " +
              "that all morning'. Every frame in the window is labelled, " +
              "which is what makes a correction worth more than a nod. " +
              "Omit for a single moment.",
          },
        },
        required: ["skill_key", "happened", "at"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "answer_question",
      description: "Answer an open question the system asked, e.g. a weight on a bar.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, value: { type: "string" } },
        required: ["id", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remind",
      description:
        "Schedule one nudge. Use when a goal's window is closing and nothing " +
        "has been observed, or when the user asks to be reminded.",
      parameters: {
        type: "object",
        properties: {
          in_minutes: { type: "number" },
          text: { type: "string", description: "Said out loud, one sentence." },
          goal_key: { type: "string" },
        },
        required: ["in_minutes", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_adjustment",
      description:
        "Suggest changing a skill's threshold or timing. A proposal only - " +
        "the user has to agree before anything changes.",
      parameters: {
        type: "object",
        properties: {
          skill_key: { type: "string" },
          enter_conf: { type: "number" },
          exit_conf: { type: "number" },
          dwell_s: { type: "number" },
          why: { type: "string" },
        },
        required: ["skill_key", "why"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show",
      description:
        "Rearrange the console around what you are talking about. Call this " +
        "alongside your answer whenever you mention a specific goal or skill.",
      parameters: {
        type: "object",
        properties: {
          goal_key: { type: "string" },
          skill_key: { type: "string" },
          banner: { type: "string", description: "One short line to hold on screen." },
          tone: { type: "string", enum: ["calm", "nudge", "alert"] },
        },
      },
    },
  },
];

/**
 * What the model is told, in the fewest tokens that still say it.
 *
 * Near-misses are spelled out with their failing term because that is the
 * one thing here no other tracker could print, and it is what turns "you are
 * at seven" into advice.
 */
export function brief(b: Brief): string {
  const clock = new Date(b.now).toLocaleTimeString("en-GB", {
    timeZone: b.tz,
    hour: "2-digit",
    minute: "2-digit",
  });

  const goals = b.goals.length
    ? b.goals
        .map(({ goal, instance, uses }) => {
          const seen = instance ? `${instance.observed}` : "0";
          const want = goal.doneMin ?? instance?.targetMin ?? 1;
          const win = goal.windowStart ? ` window ${goal.windowStart}-${goal.windowEnd}` : "";
          return `- ${goal.key} "${goal.description}" ${seen}/${want} ${instance?.state ?? "pending"}${win} [${uses.join(" ")}]`;
        })
        .join("\n")
    : "- none yet";

  const counted = b.recent.filter((t) => t.kind === "entered");
  const missed = b.recent.filter((t) => t.kind === "rejected");

  const misses = missed.length
    ? missed
        .slice(-6)
        .map((t) => {
          const term =
            (t.neededConf ?? 0) > 0
              ? `peak ${t.peak?.toFixed(2)} needed ${t.neededConf?.toFixed(2)}`
              : `held ${t.heldMs}ms needed ${t.neededMs}ms`;
          return `- ${t.skillKey} at ${t.at}: ${term} (${t.reason})`;
        })
        .join("\n")
    : "- none";

  const asks = b.questions.length
    ? b.questions.map((q) => `- ${q.id} ${q.skillKey}: ${q.prompt}`).join("\n")
    : "- none";

  return [
    `Local time ${clock}. Camera: ${b.room ?? "none publishing"}.`,
    "",
    "GOALS TODAY",
    goals,
    "",
    `COUNTED IN THE LAST HOUR: ${counted.length}`,
    "",
    "NEAR-MISSES, with the term that fell short",
    misses,
    "",
    "OPEN QUESTIONS",
    asks,
  ].join("\n");
}

/**
 * One turn.
 *
 * Tool calls are returned rather than performed. The caller owns every write
 * in this system and that stays true with a model in the loop: a turn that
 * could reach into the ledger itself would be a turn nobody could replay.
 */
export async function converse(
  apiKey: string,
  model: string,
  utterance: string,
  context: Brief,
  history: Array<Record<string, unknown>> = [],
): Promise<AssistantTurn> {
  const nebius = new Nebius(apiKey);
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: SYSTEM },
    { role: "system", content: brief(context) },
    ...history,
    { role: "user", content: utterance },
  ];

  const actions: ToolCall[] = [];
  const ui: UiIntent = {};
  let say = "";
  let usage = { prompt: 0, completion: 0, reasoning: 0 };

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const out = await nebius.chat({ model, messages, tools: TOOLS, maxTokens: 900 });
    usage = {
      prompt: usage.prompt + out.usage.prompt,
      completion: usage.completion + out.usage.completion,
      reasoning: usage.reasoning + out.usage.reasoning,
    };
    if (out.content) say = out.content.trim();
    if (out.toolCalls.length === 0) break;

    messages.push(out.raw as Record<string, unknown>);
    for (const call of out.toolCalls) {
      if (call.name === "show") {
        // Applied here rather than handed back, because it changes nothing
        // anyone could audit - it only says where to look.
        if (typeof call.args.goal_key === "string") ui.focusGoal = call.args.goal_key;
        if (typeof call.args.skill_key === "string") ui.focusSkill = call.args.skill_key;
        if (typeof call.args.banner === "string") ui.banner = call.args.banner;
        if (typeof call.args.tone === "string") ui.tone = call.args.tone as UiIntent["tone"];
      } else {
        actions.push(call);
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: "ok" });
    }
  }

  // A turn that spent its whole budget reasoning returns empty content, and
  // silence from something whose only output is speech reads as broken.
  if (!say) say = actions.length > 0 ? "Done." : "I didn't catch that.";
  return { say, ui, actions, usage };
}
