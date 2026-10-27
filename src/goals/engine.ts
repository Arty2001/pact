import { Logger, newTraceId } from "../log.ts";
import { converse } from "./assistant.ts";
import type { UiIntent } from "./assistant.ts";
import type { ToolCall } from "./nebius.ts";
import { evaluate, inWindow } from "./evaluate.ts";
import { sequence, stepsOf } from "./sequence.ts";
import { ground, needsGrounding } from "./ground.ts";
import { plan } from "./planner.ts";
import {
  type ComputeState,
  decide,
  start as startInstance,
  statusOf,
  stop as stopInstance,
  Tokens,
} from "../compute.ts";
import { ADDITIONS, MIGRATIONS, SCHEMA } from "./schema.ts";
import type {
  EngineMessage,
  Goal,
  GoalSkill,
  Instance,
  PerceptionMessage,
  Skill,
  Surface,
  Transition,
  View,
} from "./types.ts";

/**
 * The Engine is the control plane and the ledger, and there is one of them.
 *
 * It is deliberately the opposite of the Hub next door. The Hub keeps no
 * storage at all because "what is live" is derived from open sockets and
 * recording it twice could only create disagreement. The Engine's whole job
 * is the part that must outlive every socket: what you said you would do,
 * what the cameras saw, and how each occurrence ended. Mixing the two into
 * one object would cost the Hub the property that makes it simple.
 *
 * Two flows meet here, which is why one object owns both:
 *
 *   frames down   a browser posts a JPEG, it is fanned to perception
 *   events up     perception posts transitions, which settle instances
 *
 * Perception dials in rather than listening. It holds one WebSocket, exactly
 * as `bridge/` does to the Hub, which means it needs no inbound port, no
 * public address, no TLS and no CORS, and the identical process runs on a
 * laptop and on a cloud VM with nothing but an environment variable changed.
 *
 * Scores never arrive here. Perception computes several a second per skill
 * and posts only transitions, which is the "7,200 scores an hour becomes one
 * event" property expressed as a process boundary rather than a convention.
 */

/** Attached to each socket. Survives hibernation. */
type SocketMeta =
  | { role: "watcher" }
  | { role: "perception"; room: string; encoderId: string; dim: number };

/** How often to materialise occurrences and retire stale ones. */
const TICK_MS = 15 * 60 * 1000;

/**
 * How long a transition stays eligible to settle an instance. A goal asks
 * "did these fire inside one window", and without a bound the answer would
 * eventually be yes for everything.
 */
const WINDOW_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Longest stretch one spoken correction may relabel, in minutes.
 *
 * Four hours is generous for "I was on that all morning" and still bounded.
 * The cap is not about the person being wrong, it is about the model turning
 * a vague phrase into a number: there is no sentence a person would say that
 * should rewrite a whole day of frames, and a correction that did would be
 * unrecoverable because nothing records what the labels used to be.
 */
const MAX_CORRECTION_MIN = 240;

/**
 * How long a transition is kept.
 *
 * Longer than the 24-hour evaluation window, because the console shows a
 * fortnight of occurrences and an explanation has to survive long enough to
 * be asked for. Shorter than forever, which is what it was.
 */
const LEDGER_RETAIN_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * A key, made addressable.
 *
 * A key is a path segment before it is anything else, and the planner is a
 * model being asked for one - it produced "nos youtube_shorts_limit", whose
 * space made a goal that no URL could name. Normalising on the way in is
 * cheaper than every route downstream having to cope: slashes stay, because
 * a key is namespaced and they are the namespace.
 */
function asKey(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_/]+|[_/]+$/g, "");
}

/** The same planner model. It already knows the vocabulary of this system. */
const ASSISTANT_MODEL = "nvidia/nemotron-3-super-120b-a12b";

export class Engine implements DurableObject {
  private log: Logger;

  /**
   * Frames per second each room currently needs, as perception last asked.
   *
   * In memory rather than stored: it is a live negotiation, not a fact about
   * the world, and a stale rate read back after a restart would be worse
   * than the default. The publisher owns its own clock, so this reaches it
   * on the next frame response rather than being pushed.
   */
  private rates = new Map<string, number>();

  /**
   * When each room last actually delivered a frame.
   *
   * The one fact that distinguishes "nothing is happening in that room" from
   * "that publisher has stopped sending", which look identical everywhere
   * else: the camera stays on the wall either way, because that is a
   * separate socket the browser keeps open regardless.
   */
  private lastFrameAt = new Map<string, number>();
  /**
   * When perception last reported SCORES for a room.
   *
   * Distinct from lastFrameAt, which only moves on the browser's own frame
   * posting and so says nothing about whether anything is analysing them.
   * Without this the console cannot tell a quiet gate from a subscription
   * that is delivering nothing, and it guessed - wrongly, and confidently.
   */
  private lastScoreAt = new Map<string, number>();

  constructor(
    private ctx: DurableObjectState,
    // Narrowed to what the Engine actually reads, so the bindings it has no
    // business touching are not even in scope here. The two compute fields
    // are optional and the feature is simply off without them, which is the
    // laptop deployment.
    private env: {
      NEBIUS_API_KEY?: string;
      NEBIUS_INSTANCE_ID?: string;
      NEBIUS_COMPUTE_TOKEN?: string;
      TAVILY_API_KEY?: string;
    },
  ) {
    this.ctx.storage.sql.exec(SCHEMA);
    for (const statement of [...ADDITIONS, ...MIGRATIONS]) {
      // Expected to fail on every boot after the one that applied it, because
      // SQLite has no ADD COLUMN IF NOT EXISTS. Swallowed rather than probed
      // for: reading back the table definition to decide would be more code
      // for the same outcome.
      try {
        this.ctx.storage.sql.exec(statement);
      } catch {
        // Already applied.
      }
    }
    this.log = new Logger("engine");
    void this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  // ---------------------------------------------------------------- routing

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/ws") return this.acceptSocket(request);

    if (path === "/state" && request.method === "GET") {
      return Response.json(this.state());
    }

    // How many cameras are publishing, from the Hub. Idempotent by design:
    // it is a count, not an event.
    if (path === "/compute/publishers" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { publishers?: number };
      return this.onPublishers(Math.max(0, Math.trunc(Number(body.publishers ?? 0))));
    }

    if (path === "/plan" && request.method === "POST") return this.plan(request);
    if (path === "/assistant" && request.method === "POST") return this.assistant(request);

    if (path === "/skills") {
      if (request.method === "GET") return Response.json({ skills: this.skills() });
      if (request.method === "POST") return this.createSkill(request);
    }

    if (path === "/goals") {
      if (request.method === "GET") return Response.json({ goals: this.goals() });
      if (request.method === "POST") return this.createGoal(request);
    }

    // Today's tally, cleared. An occurrence is keyed by date, so a count
    // from a run that is now known to have been wrong sits on screen until
    // midnight with no way to say so - which is its own kind of lying about
    // what the camera saw.
    // Keys are matched loosely and decoded, because a key is whatever was
    // stored - and a planner that emitted "nos youtube_shorts_limit" made a
    // goal that no route could address, so deleting it did nothing and said
    // ok. A pattern that only accepts well-formed keys cannot clean up a
    // badly-formed one, which is exactly when you need it to.
    const resetMatch = path.match(/^\/goals\/(.+)\/instances$/);
    if (resetMatch && request.method === "DELETE") {
      this.sql("DELETE FROM instances WHERE goal_key = ?", decodeURIComponent(resetMatch[1]));
      this.log.info("goal.evaluate", { goal: decodeURIComponent(resetMatch[1]), detail: "instances cleared" });
      this.broadcastWatchers();
      return Response.json({ ok: true });
    }

    // Ordered above the goal delete deliberately: its path pattern
    // allows slashes, so it matches this one too and would answer it
    // by deleting nothing and reporting ok.
    const goalMatch = path.match(/^\/goals\/(.+)$/);
    if (goalMatch && request.method === "DELETE") {
      const key = decodeURIComponent(goalMatch[1]);
      // Written out rather than left to ON DELETE CASCADE, which only fires
      // when foreign keys are enforced and nothing here guarantees they are.
      this.sql("DELETE FROM goal_skills WHERE goal_key = ?", key);
      this.sql("DELETE FROM instances WHERE goal_key = ?", key);
      this.sql("DELETE FROM goals WHERE key = ?", key);

      // A skill no goal names any more is not merely clutter. Perception
      // embeds it, scores it on every frame and reports it, and the console
      // draws it a series - so an abandoned detector goes on costing a dot
      // product per frame forever and crowding the chart it appears on.
      // Delete a goal and whatever was only ever its goes with it; anything
      // another goal still shares is kept by the same query.
      // Joined against goals, not just goal_skills. A join row whose goal no
      // longer exists still names a skill, and a reference from a goal that
      // is gone kept every skill in the registry looking used - so nothing
      // was ever swept again after the first deletion that left one behind.
      // Counting only live references makes this self-healing whatever the
      // table has accumulated.
      const orphans = this.unreferencedSkills();
      for (const orphan of orphans) this.sql("DELETE FROM skills WHERE key = ?", orphan);

      this.log.info("goal.settle", {
        goal: key,
        detail: "goal deleted",
        orphaned_skills: orphans.join(",") || "none",
      });
      this.pushRegistry();
      this.broadcastWatchers();
      return Response.json({ ok: true, removedSkills: orphans });
    }

    // Ask perception what this skill SHOULD be looking for. Ordered above
    // the bare skill patterns because those allow slashes and would swallow
    // this path whole.
    const relabelMatch = path.match(/^\/skills\/(.+)\/relabel$/);
    if (relabelMatch && request.method === "POST") {
      const key = asKey(decodeURIComponent(relabelMatch[1]));
      const body = (await request.json().catch(() => ({}))) as { minutesBack?: number };
      // Clamped the same way a spoken correction is: a window of days read
      // off a request body would have perception describe last Tuesday.
      const minutes = Math.min(Math.max(Number(body.minutesBack ?? 0), 0), MAX_CORRECTION_MIN);
      // Both ends or neither. Half a window would have perception read the
      // label off a span open at one end, which is not a span.
      const stamp = Date.now();
      const from = minutes > 0 ? stamp - minutes * 60_000 : undefined;
      const to = from === undefined ? undefined : stamp;
      return Response.json({ ok: true, asked: this.askRelabel(key, from, to) });
    }

    const proposalMatch = path.match(/^\/proposals\/(.+)$/);
    if (proposalMatch && request.method === "POST") {
      return this.decideProposal(asKey(decodeURIComponent(proposalMatch[1])), request);
    }
    if (proposalMatch && request.method === "DELETE") {
      const key = asKey(decodeURIComponent(proposalMatch[1]));
      this.sql("DELETE FROM proposals WHERE skill_key = ?", key);
      this.broadcastWatchers();
      return Response.json({ ok: true });
    }

    const skillMatch = path.match(/^\/skills\/(.+)$/);
    if (skillMatch && request.method === "DELETE") {
      // A skill a goal still names cannot go: the goal would be left asking
      // for evidence nothing can produce, which reads as "never fired"
      // rather than as the broken reference it is.
      const used = this.rows<{ goal_key: string }>(
        `SELECT gs.goal_key FROM goal_skills gs
         JOIN goals g ON g.key = gs.goal_key
         WHERE gs.skill_key = ?`,
        decodeURIComponent(skillMatch[1]),
      ).map((r) => r.goal_key);
      if (used.length > 0) {
        this.log.warn("skill.rejected", {
          detail: "delete refused, still in use",
          skill: decodeURIComponent(skillMatch[1]),
          goals: used.join(","),
        });
        return Response.json({ error: "in use", goals: used }, { status: 409 });
      }
      this.sql("DELETE FROM skills WHERE key = ?", decodeURIComponent(skillMatch[1]));
      this.pushRegistry();
      return Response.json({ ok: true });
    }

    const frameMatch = path.match(/^\/frames\/([A-Za-z0-9_-]+)$/);
    if (frameMatch && request.method === "POST") {
      return this.relayFrame(frameMatch[1], request);
    }

    const answerMatch = path.match(/^\/questions\/([A-Za-z0-9_-]+)\/answer$/);
    if (answerMatch && request.method === "POST") {
      return this.answerQuestion(answerMatch[1], request);
    }

    const explainMatch = path.match(/^\/explain\/([A-Za-z0-9]+)$/);
    if (explainMatch) return Response.json(this.explain(explainMatch[1]));

    return new Response("not found", { status: 404 });
  }

  /**
   * Materialise today's occurrences.
   *
   * The Hub has never needed an alarm because nothing it holds has a future.
   * An instance does: "every evening" means a row has to appear for tomorrow
   * without anyone opening the page, or a goal only exists while someone is
   * looking at it.
   */
  async alarm(): Promise<void> {
    // Before the goals, because this is the one thing on the tick that is
    // costing money while it waits.
    await this.tickCompute();

    for (const goal of this.goals()) {
      this.ensureInstance(goal);
    }

    // Anything due gets said once and marked, rather than deleted: a nudge
    // that fired is a thing that happened, and the ledger keeps those.
    const due = this.rows<{ id: string; text: string; goal_key: string | null }>(
      "SELECT id, text, goal_key FROM reminders WHERE done = 0 AND at <= ?",
      Date.now(),
    );
    for (const r of due) {
      this.sql("UPDATE reminders SET done = 1 WHERE id = ?", r.id);
      this.log.info("question.asked", { detail: "reminder", prompt: r.text });
      this.toWatchers({
        type: "assistant",
        heard: "",
        say: r.text,
        ui: { banner: r.text, tone: "nudge", focusGoal: r.goal_key ?? undefined },
      });
    }

    // The ledger is append-only and nothing was ever removing from it. Every
    // read is windowed to the last day, so rows older than the retention
    // window are not merely unused - they are scanned past, forever, by a
    // query that can never return them. Settled instances keep their own
    // summary, so this loses no verdict.
    const stale = Date.now() - LEDGER_RETAIN_MS;
    const cut = this.rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM transitions WHERE at < ?",
      stale,
    )[0]?.n;
    if (cut !== undefined && cut > 0) {
      this.sql("DELETE FROM transitions WHERE at < ?", stale);
      this.sql("DELETE FROM reminders WHERE done = 1 AND at < ?", stale);
      this.log.info("goal.evaluate", { detail: `pruned ${cut} transitions past retention` });
    }

    // Rows left by a goal that went before the joins were cleaned up, and
    // the skills they stranded. Done on the tick because with no goals left
    // there is no deletion to hang it off, and a registry full of detectors
    // nothing asks for is scored on every frame forever.
    const stranded = this.unreferencedSkills();
    if (stranded.length > 0) {
      for (const key of stranded) this.sql("DELETE FROM skills WHERE key = ?", key);
      this.log.info("goal.settle", {
        detail: "swept skills no goal names",
        orphaned_skills: stranded.join(","),
      });
      this.pushRegistry();
    }

    // The next wake is whichever comes first: the regular tick, or a nudge.
    const next = this.rows<{ at: number }>(
      "SELECT at FROM reminders WHERE done = 0 ORDER BY at LIMIT 1",
    )[0]?.at;
    const tick = Date.now() + TICK_MS;
    await this.ctx.storage.setAlarm(next !== undefined ? Math.min(next, tick) : tick);
  }

  /**
   * Draft a goal from a sentence. Drafts only; a person presses the button.
   *
   * A skill's label IS its detector, so a sentence that reads well but
   * describes something no camera can see produces a skill that silently
   * never fires. The cheapest place to catch that is in front of a person,
   * before it is written down.
   */
  private plan = async (request: Request): Promise<Response> => {
    if (!this.env.NEBIUS_API_KEY) {
      return Response.json(
        { error: "the planner needs NEBIUS_API_KEY on the Worker" },
        { status: 503 },
      );
    }
    const { sentence, tz, surfaces } = (await request.json()) as {
      sentence?: string;
      tz?: string;
      surfaces?: string[];
    };
    if (!sentence) return Response.json({ error: "sentence is required" }, { status: 400 });

    // A skill that exists is not the same as a skill that works. One that
    // has never produced a transition is one whose label matched nothing,
    // and reusing it inherits that silently - so the count travels with it.
    const fired = new Map<string, number>(
      this.rows<{ skill_key: string; n: number }>(
        "SELECT skill_key, COUNT(*) AS n FROM transitions WHERE kind = 'entered' GROUP BY skill_key",
      ).map((r) => [r.skill_key, Number(r.n)]),
    );

    // Only when the sentence named no number. Searching to second-guess
    // somebody's own stated quantity would be useless and rude, and it runs
    // on every goal anyone writes, so restraint here is a latency decision
    // as much as a correctness one.
    const key = this.env.TAVILY_API_KEY;
    const guidance =
      key && needsGrounding(sentence) ? ((await ground(key, sentence)) ?? undefined) : undefined;
    if (guidance) {
      this.log.info("planner.call", {
        sentence,
        detail: `target grounded in ${guidance.sources.length} source(s)`,
        sources: guidance.sources.map((s) => s.url).join(" "),
      });
    }

    const started = Date.now();
    try {
      const draft = await plan(
        this.env.NEBIUS_API_KEY,
        sentence,
        this.planContext(tz, Array.isArray(surfaces) ? surfaces : [], fired, guidance),
      );
      this.log.info("planner.call", {
        sentence,
        created: draft.created,
        reused: draft.reused,
        ms: Date.now() - started,
        prompt_tokens: draft.usage.prompt,
        completion_tokens: draft.usage.completion,
        reasoning_tokens: draft.usage.reasoning,
      });
      return Response.json(draft);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.log.error("service.error", { detail, ms: Date.now() - started });
      return Response.json({ error: detail }, { status: 502 });
    }
  };

  // ------------------------------------------------------------- websockets

  private acceptSocket(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: "watcher" } satisfies SocketMeta);

    // Hand a new watcher today's events immediately. A console that opens
    // empty and fills in only as things happen shows nothing about a system
    // that has been running all day.
    try {
      server.send(JSON.stringify({ type: "events", events: this.recentTransitions() }));
    } catch {
      // The socket can close between accept and first send.
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== "string") return;

    let msg: PerceptionMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "hello") {
      // This socket is now a perception worker for a room. Recording the
      // encoder id here is what lets the registry push tell it which skills
      // it is actually allowed to score.
      ws.serializeAttachment({
        role: "perception",
        room: msg.room,
        encoderId: msg.encoderId,
        dim: msg.dim,
      } satisfies SocketMeta);
      this.send(ws, { type: "registry", skills: this.skills(), encoderId: msg.encoderId });
      return;
    }

    if (msg.type === "rate") {
      this.rates.set(msg.room, msg.hz);
      return;
    }

    if (msg.type === "scores") {
      this.lastScoreAt.set(msg.room, Date.now());
      // Straight out to the browsers and then gone. Nothing is persisted,
      // which is what keeps this from quietly becoming the observations
      // table the whole process split exists to avoid.
      this.toWatchers({ type: "scores", room: msg.room, hz: msg.hz, scores: msg.scores });
      return;
    }

    if (msg.type === "transition") {
      this.recordTransition(msg.transition);
      return;
    }

    if (msg.type === "weights") {
      // Perception computed the text embedding, because the text encoder
      // lives there and not here. A skill is created with a label and no
      // vector, and this is the second half of that handshake.
      this.sql(
        `UPDATE skills SET w = ?, encoder_id = ?, dim = ?, bias = ?, temperature = ?,
         weight_state = CASE weight_state WHEN 'fitted' THEN 'fitted' ELSE 'zeroshot' END
         WHERE key = ?`,
        msg.w,
        msg.encoderId,
        msg.dim,
        msg.bias,
        msg.temperature,
        msg.skillKey,
      );
      return;
    }

    if (msg.type === "refit") {
      const accepted = msg.accepted !== false;
      // Only a kept fit changes the row. A declined one still gets reported,
      // because "I tried and it did not help" is the honest answer to a
      // correction and marking it fitted anyway would be a lie in the one
      // column that says how far a skill has come.
      if (accepted) {
        this.sql("UPDATE skills SET weight_state = 'fitted' WHERE key = ?", msg.skillKey);
      }
      this.log.info("probe.refit", {
        skill: msg.skillKey,
        n_examples: msg.nExamples,
        holdout_before: msg.holdoutBefore,
        holdout_after: msg.holdoutAfter,
        accepted,
      });
      this.broadcastWatchers();

      // Say it out loud. A correction that teaches something and then
      // reports it only to a log is indistinguishable, to the person who
      // just spoke, from one that was ignored - and "did that do anything?"
      // is the entire question they are asking. The numbers are the answer:
      // the after figure is measured on frames the fit never saw, so it is
      // evidence rather than encouragement.
      const before = Math.round(msg.holdoutBefore * 100);
      const after = Math.round(msg.holdoutAfter * 100);
      const say = accepted
        ? `Learned ${msg.skillKey} from ${msg.nExamples} examples. On frames I hadn't seen, ${before} percent right before, ${after} after.`
        : `I tried to learn ${msg.skillKey} from ${msg.nExamples} examples and it didn't beat what I had, so I kept the old one.`;
      this.toWatchers({
        type: "assistant",
        heard: "",
        say,
        ui: { focusSkill: msg.skillKey, banner: say, tone: "calm" },
      });
    }

    if (msg.type === "proposal") {
      const was = this.rows<{ label: string }>(
        "SELECT label FROM skills WHERE key = ?",
        msg.skillKey,
      )[0]?.label;
      if (was === undefined) return;

      // Worse or barely better is not worth asking about. The ratio is
      // separation over spread on recorded frames, so a tie means the two
      // labels describe the same frames equally well - and a prompt to
      // approve a change that measures the same is noise that teaches
      // people to approve without reading.
      if (msg.ratioAfter <= msg.ratioBefore * 1.15) {
        this.log.info("probe.refit", {
          skill: msg.skillKey,
          detail: "label proposal declined, no real improvement",
          holdout_before: msg.ratioBefore,
          holdout_after: msg.ratioAfter,
          accepted: false,
        });
        return;
      }

      this.sql(
        `INSERT OR REPLACE INTO proposals
           (skill_key, label, was, ratio_after, ratio_before, runners_up, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        msg.skillKey,
        msg.label,
        was,
        msg.ratioAfter,
        msg.ratioBefore,
        JSON.stringify(msg.runnersUp ?? []),
        Date.now(),
      );
      this.log.info("probe.refit", {
        skill: msg.skillKey,
        detail: `label proposal: "${msg.label}" over "${was}"`,
        holdout_before: msg.ratioBefore,
        holdout_after: msg.ratioAfter,
        accepted: false,
      });

      // Said out loud, with the ratio in plain words. The person who
      // complained is owed an answer in the same breath, and "I think I
      // know what I was missing" is a far better answer than silence while
      // forty labels accumulate.
      const times = (msg.ratioAfter / Math.max(msg.ratioBefore, 0.01)).toFixed(1);
      const say =
        `I think ${msg.skillKey} should be looking for "${msg.label}" instead. ` +
        `On the frames you just showed me that separates ${times} times better ` +
        `than what it has now. Want me to change it?`;
      this.toWatchers({
        type: "assistant",
        heard: "",
        say,
        ui: { focusSkill: msg.skillKey, banner: say, tone: "curious" },
      });
      this.broadcastWatchers();
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.onGone(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.onGone(ws);
  }

  private onGone(ws: WebSocket): void {
    const meta = this.metaOf(ws);
    if (meta?.role === "perception") {
      this.log.warn("service.error", { detail: "perception disconnected", room: meta.room });
    }
  }

  // ------------------------------------------------------------ frame relay

  /**
   * A browser posts one JPEG; it is handed to whichever perception workers
   * are listening and then forgotten.
   *
   * Nothing is stored. A frame is worth something for a few hundred
   * milliseconds and is a liability forever, so the Engine is a pipe here
   * rather than a buffer. The response says how many workers received it,
   * which is what lets the publisher stop sampling when nobody is listening
   * instead of uploading into a void.
   */
  private async relayFrame(room: string, request: Request): Promise<Response> {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) {
      return Response.json({ error: "empty frame" }, { status: 400 });
    }

    const seq = Number(request.headers.get("X-Frame-Seq") ?? "0");
    // The publisher knows whether this is a camera or a shared screen and
    // nothing downstream can tell from the pixels, so it says so in a header.
    // An older publisher that sends nothing means "camera", which is what
    // every publisher was before screens were a thing.
    const surface = asSurface(request.headers.get("X-Frame-Surface"), "camera");
    this.lastFrameAt.set(room, Date.now());
    const targets = this.perceptionSockets(room);
    if (targets.length > 0) {
      const jpegBase64 = base64(bytes);
      const msg: EngineMessage = { type: "frame", room, surface, seq, ts: Date.now(), jpegBase64 };
      for (const ws of targets) this.send(ws, msg);
    }

    // The rate goes back in the response rather than being pushed, because
    // the browser owns its own clock and is already making this request. A
    // counter needs 8 fps to see a rep at all and a gate is fine at 0.5, so
    // without this round trip the publisher sends at its idle rate forever
    // and fast skills are not merely inaccurate, they are blind.
    return Response.json({
      delivered: targets.length,
      bytes: bytes.byteLength,
      hz: this.rates.get(room) ?? null,
    });
  }

  // --------------------------------------------------------------- the rows

  private createSkill = async (request: Request): Promise<Response> => {
    const body = (await request.json()) as Partial<Skill> & { key: string; label: string };
    if (!body.key || !body.label) {
      return Response.json({ error: "key and label are required" }, { status: 400 });
    }
    const now = Date.now();
    // Only a changed label invalidates the vector — the label IS the detector.
    const prior = this.rows<Record<string, unknown>>(
      "SELECT * FROM skills WHERE key = ?",
      asKey(body.key),
    )[0];
    const keep = prior && String(prior.label) === body.label ? prior : undefined;

    // Hoisted because the timing defaults depend on it: a screen action wants
    // a long exit and no cooldown, a camera action the opposite.
    const surface = asSurface(body.surface ?? null, "any");

    // A view is only ever a view of a screen. Averaging a room away destroys
    // the person the question was about, so `layout` on a camera is not a
    // tuning choice that happens to be poor — it is a detector with its
    // subject removed, and it would calibrate quite happily against the
    // mush. Clamped here rather than refused: the planner already knows the
    // rule, and the console has no widget for it at all.
    //
    // A body that says nothing inherits what the row already had, which the
    // other columns do not do — and has to, because this route is an INSERT
    // OR REPLACE and is how a skill is edited as well as created. Every
    // client that writes a threshold would otherwise reset a screen gate to
    // `full` on the way past, losing the one setting nothing in the console
    // displays. `prior` rather than `keep`: a view outlives a relabelling,
    // since it says which picture to look at and not what to look for.
    const view =
      surface === "screen" ? asView(body.view ?? null, asView(prior?.view)) : "full";

    // The vector and the fit are carried separately because they depend on
    // different things. A vector is the embedded label and nothing else. A
    // fit is solved for one enter/exit pair, so a moved band leaves it
    // describing a threshold that is no longer there — perception refits
    // from fresh background instead.
    //
    // A changed view ends the fit the same way, for a different reason: bias
    // and temperature are quantiles of the cosines one view produced, and a
    // blurred frame's cosines are not a sharp frame's. Perception notices
    // this itself by comparing registry snapshots, but only while it has a
    // previous snapshot to compare — restart it after a view change and it
    // would adopt whatever this row still claimed. The row is where the
    // staleness has to be cleared.
    const enterConf = body.enterConf ?? 0.75;
    const exitConf = body.exitConf ?? 0.45;
    const sameFit =
      keep !== undefined &&
      Number(keep.enter_conf) === enterConf &&
      Number(keep.exit_conf) === exitConf &&
      asView(keep.view) === view;
    const fit = sameFit ? keep : undefined;

    this.sql(
      `INSERT OR REPLACE INTO skills
        (key, kind, label, room, surface, view, depends_on, enter_conf, exit_conf, dwell_s,
         exit_s, cooldown_s, escalate_after_s, min_cycle_s, classes, margin, sample_hz,
         w, encoder_id, dim, bias, temperature, weight_state, n_labels, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      asKey(body.key),
      body.kind ?? "object",
      body.label,
      body.room ?? null,
      surface,
      view,
      body.dependsOn ?? null,
      enterConf,
      exitConf,
      body.dwellS ?? defaultDwellS(body.kind ?? "object"),
      body.exitS ?? defaultExitS(body.kind ?? "object", surface),
      body.cooldownS ?? defaultCooldownS(body.kind ?? "object", surface),
      body.escalateAfterS ?? 60.0,
      body.minCycleS ?? defaultMinCycleS(body.kind ?? "object"),
      body.classes ? JSON.stringify(body.classes) : null,
      body.margin ?? null,
      body.sampleHz ?? defaultHz(body.kind ?? "object"),
      // Carried over when the label is unchanged. Editing a threshold used to
      // wipe the weight vector and the fitted calibration, so perception
      // re-embedded and re-fitted on whatever happened to be in frame at that
      // second — which is how a squat counter ended up calibrated against a
      // static scene and firing on 40% of all frames.
      keep?.w ?? null,
      keep?.encoder_id ?? null,
      keep?.dim ?? null,
      fit?.bias ?? 0.0,
      fit?.temperature ?? 1.0,
      fit ? String(fit.weight_state) : keep?.w ? "zeroshot" : "pending",
      keep?.n_labels ?? 0,
      now,
    );
    // Push the registry so perception embeds the label without waiting for a
    // poll. This is what makes a new goal start working in seconds.
    this.pushRegistry();
    this.broadcastWatchers();
    return Response.json({ ok: true, skill: this.skill(body.key) });
  };

  private createGoal = async (request: Request): Promise<Response> => {
    const body = (await request.json()) as Partial<Goal> & {
      key: string;
      description: string;
      uses?: Array<Partial<GoalSkill> & { skillKey: string; role: GoalSkill["role"] }>;
    };
    if (!body.key || !body.description) {
      return Response.json({ error: "key and description are required" }, { status: 400 });
    }

    // evaluate() skips gates on purpose - a gate is a precondition, not a
    // thing to achieve - so a goal with nothing else has no sub-goals, and a
    // goal with no sub-goals can never be met. It would sit on the console
    // looking ordinary and never advance, and nothing would say why. Refused
    // here rather than discovered a week later.
    const doing = (body.uses ?? []).filter((u) => u.role !== "gate");

    // A gate watching a different surface from the thing beneath it does not
    // fail cleanly. A camera gate over a screen goal fires on the people
    // INSIDE whatever video is playing, so the goal reports the content of
    // the media instead of the fact of it and appears to work intermittently
    // - which is worse than broken, because nobody debugs something that
    // sometimes gives the right answer. The planner is told this plainly and
    // still does it, so it is checked here too. `any` means the skill was
    // written with no opinion and matches either.
    // Through asKey, because the insert below stores the normalised form and
    // a lookup on the raw one silently finds nothing - which here meant
    // "no opinion" and skipped the whole check. The normalisation and this
    // have to agree about what a key is or the guard never fires.
    const surfaceOf = (key: string): string => {
      const row = this.rows<{ surface: string }>(
        "SELECT surface FROM skills WHERE key = ?",
        asKey(key),
      )[0];
      return row?.surface ?? "any";
    };
    for (const gate of (body.uses ?? []).filter((u) => u.role === "gate")) {
      const gateSurface = surfaceOf(gate.skillKey);
      if (gateSurface === "any") continue;
      const wrong = doing.find((u) => {
        const s = surfaceOf(u.skillKey);
        return s !== "any" && s !== gateSurface;
      });
      if (wrong !== undefined) {
        this.log.warn("skill.rejected", {
          goal: body.key,
          skill: gate.skillKey,
          detail: `gate watches ${gateSurface}, ${wrong.skillKey} watches ${surfaceOf(wrong.skillKey)}`,
        });
        return Response.json(
          {
            error:
              `the gate "${gate.skillKey}" watches a ${gateSurface} and ` +
              `"${wrong.skillKey}" watches a ${surfaceOf(wrong.skillKey)}. A gate ` +
              "has to watch the same surface as the thing it gates, or it can " +
              "never open for it - and a camera gate over a screen goal fires " +
              "on the people inside whatever video is playing.",
          },
          { status: 400 },
        );
      }
    }
    if ((body.uses ?? []).length > 0 && doing.length === 0) {
      return Response.json(
        {
          error:
            "a goal needs at least one non-gate skill. A gate says where to " +
            "look; something beneath it has to be the thing being measured, " +
            "or the goal can never settle.",
        },
        { status: 400 },
      );
    }

    this.sql(
      `INSERT OR REPLACE INTO goals
        (key, description, type, cadence, done_min, done_max, window_start, window_end,
         tz, sequence_window_s, step_value, step_period, step_on, source_url, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      asKey(body.key),
      body.description,
      body.type ?? "target",
      body.cadence ?? "daily",
      body.doneMin ?? null,
      body.doneMax ?? null,
      body.windowStart ?? null,
      body.windowEnd ?? null,
      body.tz ?? "UTC",
      body.sequenceWindowS ?? 600,
      body.stepValue ?? null,
      body.stepPeriod ?? null,
      body.stepOn ?? null,
      body.sourceUrl ?? null,
      Date.now(),
    );

    this.sql("DELETE FROM goal_skills WHERE goal_key = ?", body.key);
    for (const use of body.uses ?? []) {
      this.sql(
        `INSERT OR REPLACE INTO goal_skills
          (goal_key, skill_key, role, class_key, min_count, accumulate, sequence_index)
         VALUES (?,?,?,?,?,?,?)`,
        asKey(body.key),
        asKey(use.skillKey),
        use.role,
        use.classKey ?? null,
        use.minCount ?? null,
        use.accumulate ? 1 : 0,
        use.sequenceIndex ?? null,
      );
    }

    const goal = this.goal(body.key);
    if (goal) this.ensureInstance(goal);
    this.broadcastWatchers();
    return Response.json({ ok: true, goal });
  };

  // ------------------------------------------------------------ transitions

  /**
   * Record one transition and re-evaluate whatever goals care about it.
   *
   * Rejections are written as loudly as acceptances. A ledger that only
   * records successes cannot answer "why didn't that count?", which is the
   * question anyone actually asks, and the peak score plus how long it was
   * held is what separates a near-miss from a non-event.
   */
  private recordTransition(t: Transition): void {
    this.sql(
      `INSERT INTO transitions
        (skill_key, kind, at, room, trace_id, score, reason, dwell_ms, duration_ms,
         held_ms, needed_ms, needed_conf, peak, count, class_key, p1, p2, margin, verdict_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      t.skillKey,
      t.kind,
      t.at,
      t.room,
      t.traceId,
      t.score,
      t.reason,
      t.dwellMs ?? null,
      t.durationMs ?? null,
      t.heldMs ?? null,
      t.neededMs ?? null,
      t.neededConf ?? null,
      t.peak ?? null,
      t.count ?? null,
      t.classKey ?? null,
      t.p1 ?? null,
      t.p2 ?? null,
      t.margin ?? null,
      t.verdictBy ?? null,
    );

    const log = this.log.span(t.traceId);
    if (t.kind === "rejected") {
      log.info("skill.rejected", {
        skill: t.skillKey,
        peak: t.peak,
        held_ms: t.heldMs,
        needed_ms: t.neededMs,
        needed_conf: t.neededConf,
        reason: t.reason,
      });
    } else {
      log.info("skill.transition", {
        skill: t.skillKey,
        from: t.kind === "entered" ? "candidate" : "active",
        to: t.kind === "entered" ? "active" : "cooldown",
        reason: t.reason,
        score: t.score,
        dwell_ms: t.dwellMs ?? t.durationMs,
      });
    }
    if (t.margin !== undefined) {
      log.info("discriminator.margin", {
        skill: t.skillKey,
        top: t.classKey,
        p1: t.p1,
        runner_up: null,
        p2: t.p2,
        margin: t.margin,
        ok: t.margin >= 0.15,
      });
    }

    // Only a completed or classified thing can change a verdict; a rejection
    // is recorded for the explanation and then stops here.
    if (t.kind === "rejected" || t.kind === "escalate") {
      this.broadcastWatchers();
      return;
    }

    for (const goal of this.goalsUsing(t.skillKey)) this.settleIfDue(goal, log);
    this.missedChance(t, log);
    this.broadcastWatchers();
  }

  /**
   * A gate closing is an opportunity closing.
   *
   * evaluate() skips gates on purpose - a gate is a precondition, not a
   * sub-goal - which means an unmet goal reads as "not yet" forever and
   * nothing can tell "you haven't done it" apart from "you were standing
   * right there and didn't". The difference is the whole product: a tracker
   * that notices what you did NOT do is a different thing from one that logs
   * what you did.
   *
   * One gate is usually shared by several goals, which is the useful part.
   * Walking out of the bathroom closes the chance at moisturiser and floss
   * and brushing together, so they are collected and spoken as one sentence
   * rather than three.
   */
  private missedChance(t: Transition, log: Logger): void {
    if (t.kind !== "exited") return;

    const behind = this.rows<Record<string, unknown>>(
      `SELECT g.* FROM goals g
       JOIN goal_skills gs ON gs.goal_key = g.key
       WHERE gs.skill_key = ? AND gs.role = 'gate'`,
      t.skillKey,
    ).map(toGoal);
    if (behind.length === 0) return;

    const missed: Array<{ goal: Goal; instance: Instance }> = [];
    for (const goal of behind) {
      // A limit is not an opportunity. Leaving the room without breaking it
      // is the goal, and congratulating someone for that is noise.
      if (goal.type === "limit") continue;
      const instance = this.ensureInstance(goal);
      if (instance.state === "done" || instance.nudgedAt !== null) continue;
      if (!this.insideWindow(goal, Date.now())) continue;
      missed.push({ goal, instance });
    }
    if (missed.length === 0) return;

    // Marked before speaking, not after. The model call takes a second and
    // another transition can arrive inside it, and saying it twice is worse
    // than not saying it at all.
    for (const m of missed) {
      this.sql("UPDATE instances SET nudged_at = ? WHERE id = ?", Date.now(), m.instance.id);
    }
    log.info("goal.evaluate", {
      goal: missed.map((m) => m.goal.key).join(","),
      detail: `chance closed: ${t.skillKey} ended`,
    });

    const list = missed
      .map((m) => `"${m.goal.description}" (${m.instance.observed} of ${m.goal.doneMin ?? 1})`)
      .join(", ");
    this.sayUnprompted(
      `The person has just finished being where ${t.skillKey} applies, and left ` +
        `without completing: ${list}. Tell them, in ONE short sentence, warmly ` +
        `and without nagging. Mention every one of them in that sentence. Do ` +
        `not offer to set a reminder unless they ask.`,
      { focusGoal: missed[0].goal.key, tone: "nudge" },
      log,
    );
  }

  /**
   * Say something nobody asked for.
   *
   * The same turn a microphone would produce, with the ledger standing in
   * for the question. It goes out on the watcher socket with an empty
   * `heard`, which is how every console knows to speak it rather than only
   * show it.
   */
  private sayUnprompted(prompt: string, ui: UiIntent, log: Logger): void {
    const key = this.env.NEBIUS_API_KEY;
    if (!key) return;
    const goals = this.goals();
    const work = (async () => {
      try {
        const turn = await converse(key, ASSISTANT_MODEL, prompt, {
          now: Date.now(),
          tz: goals[0]?.tz ?? "UTC",
          goals: goals.map((goal) => ({
            goal,
            instance: this.instances(goal.key)[0] ?? null,
            uses: this.links(goal.key).map((l) => l.skillKey),
          })),
          skills: this.skills(),
          recent: this.transitionsSince(
            this.skills().map((s) => s.key),
            Date.now() - 60 * 60 * 1000,
          ),
          questions: this.openQuestions().map((q) => ({
            id: q.id,
            skillKey: q.skillKey,
            prompt: q.prompt,
          })),
          proposals: this.pendingProposals(),
          room: [...this.lastFrameAt.keys()][0] ?? null,
        });
        log.info("question.asked", { detail: "unprompted", prompt: turn.say });
        this.toWatchers({
          type: "assistant",
          heard: "",
          say: turn.say,
          ui: { ...ui, ...turn.ui },
        });
      } catch (err) {
        log.error("service.error", { detail: `unprompted: ${String(err).slice(0, 160)}` });
      }
    })();
    this.ctx.waitUntil(work);
  }

  private settleIfDue(goal: Goal, log: Logger): void {
    const instance = this.ensureInstance(goal);

    // A settled instance stops being re-settled, but it does NOT stop
    // counting. Returning here was why a goal that wanted five reps froze at
    // five while the camera went on recording the sixth through the ninth:
    // the tally is a record of what happened, and what happened kept
    // happening after the threshold was crossed.
    const alreadySettled = instance.state === "done" || instance.state === "violated";

    const links = this.links(goal.key);
    const since = Date.now() - WINDOW_LOOKBACK_MS;
    const keys = links.map((l) => l.skillKey);
    const transitions = this.transitionsSince(keys, since).filter((t) =>
      this.insideWindow(goal, t.at),
    );
    const answers = this.metricAnswers(instance.id);

    const verdict = evaluate(goal, links, transitions, answers);
    log.info("goal.evaluate", {
      goal: goal.key,
      subgoal_results: verdict.subgoals.map((s) => `${s.skillKey}=${s.met ? "met" : s.why}`),
      ...(verdict.sequence
        ? {
            passes: verdict.sequence.completions,
            waiting_on: verdict.sequence.cursor,
            resets: verdict.sequence.resets,
          }
        : {}),
    });

    // Out of order is the sequenced answer to "why is my count low", and it
    // is only an answer if it is said out loud. Silently crediting nothing
    // is what sends someone looking at the detector for three days.
    for (const skipped of verdict.sequence?.outOfOrder ?? []) {
      log.warn("skill.rejected", {
        goal: goal.key,
        skill: skipped.skillKey,
        detail: `step ${skipped.step} observed while waiting on step ${skipped.waitingOn}`,
        at: skipped.at,
      });
    }

    this.sql("UPDATE instances SET observed = ? WHERE id = ?", verdict.observed, instance.id);
    if (alreadySettled) return;

    if (!verdict.settled) {
      // A metric nobody has answered leaves the instance unsure, never
      // failed. One question, pre-filled, after the fact.
      for (const key of verdict.awaiting) this.askOnce(instance, key, goal);
      return;
    }

    const state = goal.type === "limit" ? "violated" : "done";
    const settledBy = transitions.some((t) => t.verdictBy === "vlm") ? "vlm" : "camera";
    this.sql(
      "UPDATE instances SET state = ?, settled_at = ?, settled_by = ?, observed = ? WHERE id = ?",
      state,
      Date.now(),
      settledBy,
      verdict.observed,
      instance.id,
    );
    if (state === "violated" && instance.nudgedAt === null) {
      // A limit is the one goal where the interesting moment is the failure,
      // and it was only ever turning a chip red.
      this.sql("UPDATE instances SET nudged_at = ? WHERE id = ?", Date.now(), instance.id);
      this.sayUnprompted(
        `The limit "${goal.description}" has just been broken, right now. Say ` +
          `so in ONE short sentence. Be direct, not scolding.`,
        { focusGoal: goal.key, tone: "alert" },
        log,
      );
    }

    log.info("goal.settle", {
      goal: goal.key,
      state,
      settled_by: settledBy,
      observed: verdict.observed,
    });
  }

  /** One question per instance, maximum, and never blocking. */
  private askOnce(instance: Instance, skillKey: string, goal: Goal): void {
    const existing = this.rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM questions WHERE instance_id = ?",
      instance.id,
    )[0];
    if ((existing?.n ?? 0) > 0) return;

    const skill = this.skill(skillKey);
    if (!skill || skill.kind !== "metric") return;

    const proposed = instance.targetMin ?? goal.doneMin;
    const id = crypto.randomUUID();
    const prompt = `${goal.description} - ${skill.label}?`;
    this.sql(
      `INSERT INTO questions (id, instance_id, skill_key, prompt, proposed_value, asked_at)
       VALUES (?,?,?,?,?,?)`,
      id,
      instance.id,
      skillKey,
      prompt,
      proposed === null ? null : String(proposed),
      Date.now(),
    );
    this.log.info("question.asked", {
      instance: instance.id,
      skill: skillKey,
      prompt,
      proposed,
    });
  }

  private answerQuestion = async (id: string, request: Request): Promise<Response> => {
    const { answer } = (await request.json()) as { answer?: string };
    const q = this.rows<{ instance_id: string; skill_key: string; asked_at: number }>(
      "SELECT instance_id, skill_key, asked_at FROM questions WHERE id = ?",
      id,
    )[0];
    if (!q) return Response.json({ error: "unknown question" }, { status: 404 });

    const now = Date.now();
    this.sql("UPDATE questions SET answer = ?, answered_at = ? WHERE id = ?", answer ?? "", now, id);
    this.log.info("question.answered", {
      instance: q.instance_id,
      answer,
      latency_ms: now - q.asked_at,
    });

    // The answer settles the instance, and separately becomes a label. The
    // second half is the only reason anything improves over time.
    const instance = this.rows<Record<string, unknown>>(
      "SELECT * FROM instances WHERE id = ?",
      q.instance_id,
    )[0];
    if (instance) {
      const goal = this.goal(String(instance.goal_key));
      if (goal) this.settleIfDue(goal, this.log.span(newTraceId()));
    }

    this.broadcastWatchers();
    return Response.json({ ok: true });
  };

  /**
   * Where an ordered goal's open pass has got to, for the console.
   *
   * Recomputed rather than stored, for the same reason the cursor itself is
   * derived: a saved cursor is a second copy of something the ledger already
   * says, and two copies eventually disagree. An unordered goal returns
   * nothing at all, so the payload only grows for goals that have an order.
   */
  private sequenceView(goal: Goal): { waitingOn?: number | null; passes?: number } {
    const links = this.links(goal.key);
    if (stepsOf(links).length === 0) return {};
    const transitions = this.transitionsSince(
      links.map((l) => l.skillKey),
      Date.now() - WINDOW_LOOKBACK_MS,
    ).filter((t) => this.insideWindow(goal, t.at));
    const out = sequence(links, transitions, goal.sequenceWindowS);
    return { waitingOn: out.cursor, passes: out.completions };
  }

  // ------------------------------------------------------------- assistant

  /**
   * One spoken turn.
   *
   * Everything it is allowed to change it changes through here, never
   * itself: the model returns tool calls and this applies them. A turn that
   * could write to the ledger directly would be a turn nobody could replay,
   * and replaying the ledger is the only reason any of this is trustworthy.
   */
  private assistant = async (request: Request): Promise<Response> => {
    const body = (await request.json().catch(() => ({}))) as {
      text?: string;
      room?: string;
    };
    const text = (body.text ?? "").trim();
    if (!text) return Response.json({ error: "nothing said" }, { status: 400 });

    const key = this.env.NEBIUS_API_KEY;
    if (!key) {
      return Response.json(
        { say: "I have no key to think with. Set NEBIUS_API_KEY and I will be back." },
        { status: 200 },
      );
    }

    const log = this.log.span(newTraceId());
    const since = Date.now() - 60 * 60 * 1000;
    const goals = this.goals();
    const recent = this.transitionsSince(
      this.skills().map((s) => s.key),
      since,
    );

    log.info("question.asked", { detail: "heard", text });

    let turn;
    try {
      turn = await converse(key, ASSISTANT_MODEL, text, {
        now: Date.now(),
        tz: goals[0]?.tz ?? "UTC",
        goals: goals.map((goal) => ({
          goal,
          instance: this.instances(goal.key)[0] ?? null,
          uses: this.links(goal.key).map((l) => l.skillKey),
        })),
        skills: this.skills(),
        recent,
        questions: this.openQuestions().map((q) => ({
          id: q.id,
          skillKey: q.skillKey,
          prompt: q.prompt,
        })),
        proposals: this.pendingProposals(),
        room: [...this.lastFrameAt.keys()][0] ?? null,
      });
    } catch (err) {
      log.error("service.error", { detail: `assistant: ${String(err).slice(0, 200)}` });
      return Response.json({ say: "I could not reach my own head just then." });
    }

    const applied = await this.applyActions(turn.actions, log);
    log.info("question.answered", {
      detail: "said",
      say: turn.say,
      actions: applied.join(",") || "none",
      tokens: turn.usage.prompt + turn.usage.completion,
    });

    // Every watching console follows the same turn, so the UI rearranges
    // around what was said rather than around what was clicked.
    this.toWatchers({ type: "assistant", heard: text, say: turn.say, ui: turn.ui });
    return Response.json({ say: turn.say, ui: turn.ui, applied });
  };

  /**
   * Skills no surviving goal names.
   *
   * NOT EXISTS rather than NOT IN: a single NULL in the subquery makes
   * NOT IN match nothing at all, silently, which is a strange way for a
   * cleanup to fail. The join to goals is the other half - a join row whose
   * goal is gone still names a skill, and those leftovers kept every skill
   * looking used, so nothing was swept again after the first deletion that
   * left one behind.
   */
  private unreferencedSkills(): string[] {
    this.sql(
      `DELETE FROM goal_skills
       WHERE NOT EXISTS (SELECT 1 FROM goals g WHERE g.key = goal_skills.goal_key)`,
    );
    return this.rows<{ key: string }>(
      `SELECT key FROM skills s
       WHERE NOT EXISTS (
         SELECT 1 FROM goal_skills gs
         JOIN goals g ON g.key = gs.goal_key
         WHERE gs.skill_key = s.key
       )`,
    ).map((r) => r.key);
  }

  /** What the model asked for, done by the only thing allowed to do it. */
  private async applyActions(actions: ToolCall[], log: Logger): Promise<string[]> {
    const done: string[] = [];
    for (const call of actions) {
      const a = call.args;
      if (call.name === "label_frame") {
        const skillKey = String(a.skill_key ?? "");
        if (!skillKey) continue;
        // "That one" means the last thing that happened, and the model is
        // being asked to recall an epoch millisecond to say so. It gets it
        // wrong, and a label pinned to the wrong second teaches the skill a
        // picture of something else - so the moment is resolved here, from
        // the ledger, and the model's guess is only a fallback.
        const last = this.rows<{ at: number }>(
          "SELECT at FROM transitions WHERE skill_key = ? ORDER BY at DESC LIMIT 1",
          skillKey,
        )[0]?.at;
        const guess = Number(a.at ?? 0);
        const plausible = guess > Date.now() - WINDOW_LOOKBACK_MS && guess <= Date.now();

        // A correction about something that was MISSED cannot be anchored to
        // the last transition, because the complaint is precisely that there
        // was no transition. Clamped rather than trusted: a model that reads
        // "all morning" as 6000 minutes would otherwise relabel days of
        // frames from one sentence.
        const minutes = Math.min(Math.max(Number(a.minutes_back ?? 0), 0), MAX_CORRECTION_MIN);
        const window = minutes > 0;
        const to = window ? Date.now() : (last ?? (plausible ? guess : Date.now()));
        const from = window ? to - minutes * 60_000 : to;

        // Down to perception, which holds the embeddings the label
        // describes. Labels with nothing to attach to are dropped there
        // rather than pinned to whatever frames happened to be nearest.
        const room = [...this.lastFrameAt.keys()][0] ?? "";
        for (const ws of this.perceptionSockets(room)) {
          this.send(ws, {
            type: "label",
            room,
            skillKey,
            at: to,
            from,
            to,
            label: a.happened === true ? 1 : 0,
            source: "human",
          });
        }
        log.info("question.answered", {
          skill: skillKey,
          detail: window
            ? `corrected ${a.happened === true ? 1 : 0} over ${minutes}m by voice`
            : `labelled ${a.happened === true ? 1 : 0} by voice`,
        });

        // "That IS happening and you missed it" is the one complaint worth
        // acting on twice. The label is evidence toward a refit, which
        // needs around forty of them before it beats the sentence it
        // started from - weeks of complaints for a detector that is wrong
        // today. So the same breath also asks what the label SHOULD have
        // said, which is answerable from this one window alone.
        //
        // Only for a miss. Someone saying a skill fired when it should not
        // have is not describing what to look for, and re-reading the label
        // off frames that are explicitly the wrong thing would propose a
        // detector for them.
        // The same window the label was pinned to. The frames that prove
        // the complaint are the ones the complaint is about, and they stop
        // being in front of the camera the moment someone turns to speak.
        if (a.happened === true) this.askRelabel(skillKey, from, to);
        done.push(`label_frame ${skillKey}`);
      } else if (call.name === "create_goal") {
        const sentence = String(a.sentence ?? "").trim();
        if (!sentence) continue;
        try {
          const made = await this.planAndCreate(sentence, this.goals()[0]?.tz);
          if (made) done.push(`create_goal ${made}`);
          this.pushRegistry();
          this.broadcastWatchers();
        } catch (err) {
          // Reported rather than swallowed: a goal someone asked for out
          // loud and did not get is the one failure they will definitely
          // notice, and silence here reads as the assistant ignoring them.
          log.error("service.error", {
            detail: `could not create a goal from "${sentence}": ${String(err).slice(0, 140)}`,
          });
        }
      } else if (call.name === "apply_label") {
        // The same method the button calls, so a spoken yes and a clicked
        // one cannot diverge. A model that invents a skill key changes
        // nothing, which is the right outcome: there is nothing to apply
        // unless something measured it.
        const key = asKey(String(a.skill_key ?? ""));
        if (this.decide(key, a.accept !== false) === null) {
          log.warn("skill.rejected", {
            skill: key,
            detail: "apply_label with no proposal waiting",
          });
          continue;
        }
        done.push(`apply_label ${key}`);
      } else if (call.name === "answer_question") {
        const id = String(a.id ?? "");
        const value = String(a.value ?? "");
        if (!id) continue;
        // A model will invent an id rather than admit there is no question,
        // and an UPDATE on one that does not exist succeeds at changing
        // nothing - so it would be reported as done and nobody would know.
        const real = this.rows<{ id: string }>(
          "SELECT id FROM questions WHERE id = ? AND answered_at IS NULL",
          id,
        )[0];
        if (real === undefined) {
          log.warn("question.answered", {
            detail: `no open question "${id}"; answer discarded`,
          });
          continue;
        }
        this.sql(
          "UPDATE questions SET answer = ?, answered_at = ? WHERE id = ?",
          value,
          Date.now(),
          id,
        );
        log.info("question.answered", { detail: `by voice: ${value}`, instance: id });
        done.push(`answer_question ${id}`);
      } else if (call.name === "remind") {
        const at = Date.now() + Math.max(Number(a.in_minutes ?? 0), 0) * 60_000;
        this.sql(
          "INSERT OR REPLACE INTO reminders (id, at, text, goal_key, done) VALUES (?,?,?,?,0)",
          crypto.randomUUID(),
          at,
          String(a.text ?? ""),
          a.goal_key === undefined ? null : String(a.goal_key),
        );
        void this.ctx.storage.setAlarm(at);
        done.push(`remind +${Number(a.in_minutes ?? 0)}m`);
      } else if (call.name === "propose_adjustment") {
        // Proposed, never applied. The one tool that can quietly make the
        // system wrong does not get to do it without being told yes.
        log.warn("skill.rejected", {
          skill: String(a.skill_key ?? ""),
          detail: `proposed: ${String(a.why ?? "")}`.slice(0, 160),
        });
        done.push(`proposed ${String(a.skill_key ?? "")}`);
      }
    }
    if (done.length > 0) this.broadcastWatchers();
    return done;
  }

  // --------------------------------------------------------------- reading

  /** Everything the UI needs, in one request. */
  /**
   * Ask perception to reconsider a skill's label.
   *
   * Returns how many workers were asked, because the honest answer to
   * "why has nothing come back" is usually that nothing was listening.
   * The room is left to perception: it knows which surface the skill
   * scores and which of its rooms has frames.
   */
  private askRelabel(skillKey: string, from?: number, to?: number): number {
    const room = [...this.lastFrameAt.keys()][0] ?? "";
    let asked = 0;
    for (const ws of this.perceptionSockets(room)) {
      this.send(ws, { type: "relabel", room, skillKey, from, to });
      asked += 1;
    }
    if (asked === 0) {
      this.log.warn("skill.rejected", {
        skill: skillKey,
        detail: "relabel asked with no perception worker listening",
      });
    }
    return asked;
  }

  /**
   * Apply or discard a proposed label.
   *
   * Applying one throws the fitted vector away. That looks wasteful and is
   * the only correct thing to do: a probe is a logistic regression anchored
   * to the zero-shot vector of the label it was fitted against, so keeping
   * a fit across a label change leaves a detector anchored to a sentence
   * nobody can read any more. Better to start again from a sentence that
   * measured better than to carry forward a fit for the wrong question.
   */
  private async decideProposal(skillKey: string, request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { accept?: boolean; label?: string };
    const label = this.decide(skillKey, body.accept !== false, body.label);
    if (label === null) return Response.json({ error: "no proposal" }, { status: 404 });
    return Response.json({ ok: true, label });
  }

  /**
   * The decision itself, reachable from a click or from a spoken yes.
   *
   * One method rather than two because the two must not diverge: a label
   * applied by voice and a label applied by button have to leave the same
   * row, the same log line and the same recalibration behind. Returns the
   * label now in force, or null if there was nothing to decide.
   */
  private decide(skillKey: string, accept: boolean, chosen?: string): string | null {
    const row = this.rows<{ label: string; was: string; ratio_after: number }>(
      "SELECT label, was, ratio_after FROM proposals WHERE skill_key = ?",
      skillKey,
    )[0];
    if (row === undefined) return null;
    this.sql("DELETE FROM proposals WHERE skill_key = ?", skillKey);

    if (!accept) {
      // Logged as loudly as an acceptance. A rejected proposal is evidence
      // about what this person actually means, and the only place it can be
      // read later is here.
      this.log.info("probe.refit", {
        skill: skillKey,
        detail: `label proposal rejected, kept "${row.was}"`,
        accepted: false,
      });
      this.broadcastWatchers();
      return row.was;
    }

    // A runner-up may be chosen instead of the winner, because the person
    // reading the candidates knows things no cosine does.
    const label = (chosen ?? row.label).trim() || row.label;
    this.sql(
      `UPDATE skills SET label = ?, w = NULL, encoder_id = NULL,
       weight_state = 'pending', n_labels = 0, bias = 0.0, temperature = 1.0
       WHERE key = ?`,
      label,
      skillKey,
    );
    this.log.info("probe.refit", {
      skill: skillKey,
      detail: `label replaced: "${row.was}" -> "${label}"`,
      holdout_after: row.ratio_after,
      accepted: true,
    });
    // Perception embeds a skill with no vector on the next registry push,
    // and recalibrates it from background frames because the calibration
    // went with the vector.
    this.pushRegistry();
    this.broadcastWatchers();

    const say = `Changed ${skillKey} to look for "${label}". It needs a minute of ordinary frames to recalibrate.`;
    this.toWatchers({
      type: "assistant",
      heard: "",
      say,
      ui: { focusSkill: skillKey, banner: say, tone: "calm" },
    });
    return label;
  }

  /**
   * Label changes measured and waiting on a yes, for the assistant.
   *
   * The times figure is computed here rather than carried, because the
   * ratio is only meaningful against the label it would replace and the
   * model should never be handed two numbers to divide out loud.
   */
  private pendingProposals() {
    return this.rows<{
      skill_key: string;
      label: string;
      was: string;
      ratio_after: number;
      ratio_before: number;
    }>("SELECT * FROM proposals ORDER BY at DESC").map((r) => ({
      skillKey: r.skill_key,
      label: r.label,
      was: r.was,
      times: r.ratio_after / Math.max(r.ratio_before, 0.01),
    }));
  }

  /**
   * How long nothing may want the encoder before its machine is stopped.
   *
   * Ten minutes is a compromise with a cold start, not a guess. Bringing the
   * encoder back costs about a minute of a person watching a blank console,
   * so stopping eagerly to save a few cents of compute spends the one thing
   * the product cannot afford to waste. Ten minutes covers a tab refresh, a
   * walk to the other room, and a phone that locked itself.
   */
  private static readonly IDLE_GRACE_MS = 10 * 60_000;

  /** Built lazily, because most deploys have no compute token at all. */
  private tokens: Tokens | null = null;

  private computeConfig() {
    return {
      instanceId: this.env.NEBIUS_INSTANCE_ID,
      token: this.env.NEBIUS_COMPUTE_TOKEN,
    };
  }

  /**
   * Record the live publisher count and act on it.
   *
   * The count is written before anything is decided, so a cloud call that
   * fails still leaves the Engine knowing the truth - the alarm will act on
   * it a minute later. Deciding first and recording after would mean a
   * failed start also forgot why it wanted to start.
   */
  private async onPublishers(publishers: number): Promise<Response> {
    const now = Date.now();
    const was = this.computeRow();
    // Only stamped on the transition to nothing-live. Re-stamping on every
    // notification would push the deadline forward for ever and the machine
    // would never stop.
    const idleSince = publishers > 0 ? 0 : was.idle_since || now;
    this.sql(
      `INSERT INTO compute (id, publishers, idle_since, state, changed_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET publishers = ?, idle_since = ?, changed_at = ?`,
      publishers,
      idleSince,
      was.state,
      now,
      publishers,
      idleSince,
      now,
    );
    await this.tickCompute();
    return Response.json({ ok: true, publishers, state: this.computeRow().state });
  }

  private computeRow(): {
    publishers: number;
    idle_since: number;
    state: ComputeState;
    changed_at: number;
  } {
    const row = this.rows<{
      publishers: number;
      idle_since: number;
      state: string;
      changed_at: number;
    }>("SELECT publishers, idle_since, state, changed_at FROM compute WHERE id = 1")[0];
    return {
      publishers: row?.publishers ?? 0,
      idle_since: row?.idle_since ?? 0,
      state: (row?.state ?? "unknown") as ComputeState,
      changed_at: row?.changed_at ?? 0,
    };
  }

  /**
   * Ask the cloud what the machine is doing, and start or stop it if needed.
   *
   * Called from the publisher notification and from the alarm, because the
   * two cover different failures. The notification is how a camera gets a
   * machine quickly; the alarm is how a stop still happens when the last
   * publisher left and then nothing else ever arrived to ask.
   */
  private async tickCompute(): Promise<void> {
    const cfg = this.computeConfig();
    if (!cfg.instanceId || !cfg.token) return;
    this.tokens ??= new Tokens(cfg.token);

    const row = this.computeRow();
    let state: ComputeState;
    try {
      state = await statusOf(cfg, this.tokens);
    } catch (err) {
      // Reported, not swallowed, and nothing is attempted on top of it. A
      // status read that failed means the next decision would be made on a
      // belief rather than a fact, and the expensive mistakes here are all
      // made confidently.
      this.log.warn("service.error", {
        detail: `could not read encoder instance: ${String(err).slice(0, 120)}`,
      });
      return;
    }

    if (state !== row.state) {
      this.sql("UPDATE compute SET state = ?, changed_at = ? WHERE id = 1", state, Date.now());
      this.log.info("service.start", {
        detail: `encoder machine ${state}`,
        publishers: row.publishers,
      });
      this.broadcastWatchers();
    }

    const action = decide(state, row.publishers, row.idle_since, Date.now(), Engine.IDLE_GRACE_MS);
    if (action === "wait") return;

    try {
      if (action === "start") {
        await startInstance(cfg, this.tokens);
        this.sql("UPDATE compute SET state = 'starting', changed_at = ? WHERE id = 1", Date.now());
        // Said out loud, because the alternative is a minute of silence that
        // reads exactly like the thing being broken. The console has no other
        // way to know the difference between "warming up" and "dead".
        const say = "Bringing the encoder up - about a minute before it can score anything.";
        this.log.info("service.start", { detail: "encoder machine start requested" });
        this.toWatchers({ type: "assistant", heard: "", say, ui: { banner: say, tone: "calm" } });
      } else {
        await stopInstance(cfg, this.tokens);
        this.sql("UPDATE compute SET state = 'stopping', changed_at = ? WHERE id = 1", Date.now());
        this.log.info("service.start", {
          detail: "encoder machine stopped, nothing publishing",
          idle_ms: Date.now() - row.idle_since,
        });
      }
      this.broadcastWatchers();
    } catch (err) {
      this.log.error("service.error", {
        detail: `encoder machine ${action} failed: ${String(err).slice(0, 120)}`,
      });
    }
  }

  /**
   * Everything the planner sees besides the sentence.
   *
   * One method because there are two ways in - the dialog and the voice -
   * and a goal written by speaking has to be the same goal as one written
   * by typing. Two copies of this would drift the first time either grew a
   * field.
   */
  private planContext(
    tz: string | undefined,
    live: string[],
    fired: Map<string, number>,
    guidance: Awaited<ReturnType<typeof ground>> | undefined,
  ) {
    return {
      tz: tz ?? "UTC",
      now: Date.now(),
      catalogue: this.skills(),
      fired,
      goals: this.goals().map((g) => ({
        key: g.key,
        description: g.description,
        type: g.type,
        uses: this.links(g.key).map((l) => `${l.role}:${l.skillKey}`),
      })),
      // What the console can see publishing. The Engine does not hold the
      // device list - the Hub does - so this comes from the page that is
      // already looking at it rather than through another round trip.
      live,
      guidance: guidance ?? undefined,
    };
  }

  /** Transitions per skill, so the planner can tell "exists" from "works". */
  private firedCounts(): Map<string, number> {
    return new Map<string, number>(
      this.rows<{ skill_key: string; n: number }>(
        "SELECT skill_key, COUNT(*) AS n FROM transitions WHERE kind = 'entered' GROUP BY skill_key",
      ).map((r) => [r.skill_key, Number(r.n)]),
    );
  }

  /**
   * Compile a sentence into a goal and write it.
   *
   * Spoken goals go through the Engine's own create routes rather than
   * straight to SQL, so the voice path inherits every check the dialog
   * already passes - key normalisation, the gate/surface backstop, the
   * refusal to write a child before its parent. A second write path would
   * be a second set of bugs.
   *
   * Returns what was made, for the assistant to read back. A goal nobody
   * described is a goal nobody can tell is wrong.
   */
  private async planAndCreate(sentence: string, tz: string | undefined): Promise<string> {
    const key = this.env.NEBIUS_API_KEY;
    if (!key) return "";
    const tavily = this.env.TAVILY_API_KEY;
    const guidance =
      tavily && needsGrounding(sentence) ? ((await ground(tavily, sentence)) ?? undefined) : undefined;

    const draft = await plan(key, sentence, this.planContext(tz, [], this.firedCounts(), guidance));

    // Gates before the skills that depend on them: dependsOn is a foreign
    // key into this same table, so a child written first is a child whose
    // gate chain is broken from birth.
    const named = new Set(draft.uses.map((u) => u.key));
    const ordered = [...draft.uses].sort(
      (a, b) => (a.kind === "gate" ? -1 : 0) - (b.kind === "gate" ? -1 : 0),
    );
    for (const u of ordered) {
      if (!u.isNew) continue;
      await this.fetch(
        new Request("https://pact/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: u.key,
            kind: u.kind,
            label: u.label,
            surface: u.surface,
            view: u.view,
            dependsOn: u.dependsOn && named.has(u.dependsOn) ? u.dependsOn : null,
          }),
        }),
      );
    }

    await this.fetch(
      new Request("https://pact/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: draft.key,
          description: draft.description,
          type: draft.type,
          cadence: draft.cadence,
          doneMin: draft.doneMin,
          sourceUrl: draft.sourceUrl ?? null,
          windowStart: draft.windowStart,
          windowEnd: draft.windowEnd,
          tz: tz ?? "UTC",
          uses: draft.uses.map((u) => ({
            skillKey: u.key,
            role: u.role,
            classKey: u.classKey,
            minCount: u.minCount,
            accumulate: u.accumulate,
            sequenceIndex: u.sequenceIndex,
          })),
        }),
      }),
    );

    this.log.info("planner.call", {
      sentence,
      detail: `goal created by voice: ${draft.key}`,
      created: draft.created,
      reused: draft.reused,
    });
    const watches = draft.uses.map((u) => u.label).join("; ");
    return `${draft.description} — watching for ${watches}`;
  }

  private state() {
    return {
      skills: this.skills(),
      goals: this.goals().map((goal) => ({
        ...goal,
        uses: this.links(goal.key),
        instances: this.instances(goal.key),
        ...this.sequenceView(goal),
      })),
      questions: this.openQuestions(),
      // What the encoder's machine is doing, so a cold start can be shown as
      // a cold start. Only present when the feature is configured at all.
      encoder: this.env.NEBIUS_INSTANCE_ID ? this.computeRow().state : null,
      // When it last changed, so a wait can be shown as a wait of a known
      // length rather than a spinner that might mean anything.
      encoderSince: this.env.NEBIUS_INSTANCE_ID ? this.computeRow().changed_at : null,
      proposals: this.rows<Record<string, unknown>>("SELECT * FROM proposals ORDER BY at DESC").map(
        (r) => ({ ...r, runners_up: JSON.parse(String(r.runners_up ?? "[]")) }),
      ),
      rooms: [...this.lastFrameAt].map(([room, at]) => ({ room, secondsAgo: (Date.now() - at) / 1000 })),
      // Which rooms something is actually scoring, as opposed to which are
      // merely publishing. The difference is the whole of "why is nothing
      // happening".
      watching: [...this.lastScoreAt].map(([room, at]) => ({
        room,
        secondsAgo: (Date.now() - at) / 1000,
      })),
      perception: this.ctx
        .getWebSockets()
        .map((ws) => this.metaOf(ws))
        .filter((m): m is Extract<SocketMeta, { role: "perception" }> => m?.role === "perception")
        .map((m) => ({ room: m.room, encoderId: m.encoderId, dim: m.dim })),
    };
  }

  /**
   * Every line that shares a trace id, oldest first.
   *
   * This is the answer to "show me why it counted". One grep's worth of
   * story: the frames, the near-misses, the escalation, the settlement.
   */
  private explain(traceId: string) {
    return {
      traceId,
      transitions: this.rows<Record<string, unknown>>(
        "SELECT * FROM transitions WHERE trace_id = ? ORDER BY at ASC",
        traceId,
      ),
    };
  }

  private skills(): Skill[] {
    return this.rows<Record<string, unknown>>("SELECT * FROM skills ORDER BY key").map(toSkill);
  }

  private skill(key: string): Skill | null {
    const row = this.rows<Record<string, unknown>>("SELECT * FROM skills WHERE key = ?", key)[0];
    return row ? toSkill(row) : null;
  }

  private goals(): Goal[] {
    return this.rows<Record<string, unknown>>("SELECT * FROM goals ORDER BY key").map(toGoal);
  }

  private goal(key: string): Goal | null {
    const row = this.rows<Record<string, unknown>>("SELECT * FROM goals WHERE key = ?", key)[0];
    return row ? toGoal(row) : null;
  }

  private goalsUsing(skillKey: string): Goal[] {
    return this.rows<Record<string, unknown>>(
      `SELECT g.* FROM goals g
       JOIN goal_skills gs ON gs.goal_key = g.key
       WHERE gs.skill_key = ?`,
      skillKey,
    ).map(toGoal);
  }

  private links(goalKey: string): GoalSkill[] {
    return this.rows<Record<string, unknown>>(
      "SELECT * FROM goal_skills WHERE goal_key = ? ORDER BY sequence_index, skill_key",
      goalKey,
    ).map((r) => ({
      goalKey: String(r.goal_key),
      skillKey: String(r.skill_key),
      role: r.role as GoalSkill["role"],
      classKey: r.class_key === null ? null : String(r.class_key),
      minCount: r.min_count === null ? null : Number(r.min_count),
      accumulate: Number(r.accumulate) === 1,
      sequenceIndex: r.sequence_index === null ? null : Number(r.sequence_index),
    }));
  }

  private instances(goalKey: string): Instance[] {
    return this.rows<Record<string, unknown>>(
      "SELECT * FROM instances WHERE goal_key = ? ORDER BY occurrence_on DESC LIMIT 14",
      goalKey,
    ).map(toInstance);
  }

  private openQuestions() {
    return this.rows<Record<string, unknown>>(
      "SELECT * FROM questions WHERE answered_at IS NULL ORDER BY asked_at DESC LIMIT 20",
    ).map((r) => ({
      id: String(r.id),
      instanceId: String(r.instance_id),
      skillKey: String(r.skill_key),
      prompt: String(r.prompt),
      proposedValue: r.proposed_value === null ? null : String(r.proposed_value),
      askedAt: Number(r.asked_at),
    }));
  }

  private transitionsSince(skillKeys: string[], since: number): Transition[] {
    if (skillKeys.length === 0) return [];
    const holes = skillKeys.map(() => "?").join(",");
    return this.rows<Record<string, unknown>>(
      `SELECT * FROM transitions WHERE at >= ? AND skill_key IN (${holes}) ORDER BY at ASC`,
      since,
      ...skillKeys,
    ).map((r) => ({
      skillKey: String(r.skill_key),
      kind: r.kind as Transition["kind"],
      at: Number(r.at),
      room: String(r.room),
      traceId: String(r.trace_id),
      score: Number(r.score),
      reason: String(r.reason),
      durationMs: r.duration_ms === null ? undefined : Number(r.duration_ms),
      dwellMs: r.dwell_ms === null ? undefined : Number(r.dwell_ms),
      peak: r.peak === null ? undefined : Number(r.peak),
      count: r.count === null ? undefined : Number(r.count),
      classKey: r.class_key === null ? undefined : String(r.class_key),
      margin: r.margin === null ? undefined : Number(r.margin),
      verdictBy: r.verdict_by === null ? undefined : (r.verdict_by as Transition["verdictBy"]),
    }));
  }

  private metricAnswers(instanceId: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.rows<{ skill_key: string; answer: string | null }>(
      "SELECT skill_key, answer FROM questions WHERE instance_id = ? AND answered_at IS NOT NULL",
      instanceId,
    )) {
      // "Yes" on a pre-filled question means "the proposed value", so a
      // non-numeric answer still has to resolve to a number.
      const n = Number(r.answer);
      if (!Number.isNaN(n)) out.set(r.skill_key, n);
      else if ((r.answer ?? "").toLowerCase().startsWith("y")) out.set(r.skill_key, Infinity);
    }
    return out;
  }

  // ------------------------------------------------------------- instances

  /**
   * The row for this goal's current occurrence, created if missing.
   *
   * `target_min` is copied in here and never read from the goal again, which
   * is what makes a progression behave: a week where you bench but miss the
   * weight leaves next week's target where it was rather than marching on.
   */
  private ensureInstance(goal: Goal): Instance {
    const on = localDate(goal.tz);
    const existing = this.rows<Record<string, unknown>>(
      "SELECT * FROM instances WHERE goal_key = ? AND occurrence_on = ?",
      goal.key,
      on,
    )[0];
    if (existing) return toInstance(existing);

    const wins = this.rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM instances WHERE goal_key = ? AND state = 'done'",
      goal.key,
    )[0];
    const target = progressedTarget(goal, wins?.n ?? 0);

    const id = crypto.randomUUID();
    this.sql(
      `INSERT INTO instances (id, goal_key, occurrence_on, state, observed, target_min, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      id,
      goal.key,
      on,
      "pending",
      0,
      target,
      Date.now(),
    );
    return toInstance(
      this.rows<Record<string, unknown>>("SELECT * FROM instances WHERE id = ?", id)[0],
    );
  }

  private insideWindow(goal: Goal, at: number): boolean {
    if (!goal.windowStart || !goal.windowEnd) return true;
    return inWindow(goal.windowStart, goal.windowEnd, localMinutes(at, goal.tz));
  }

  // --------------------------------------------------------------- plumbing

  private sql(query: string, ...bindings: unknown[]): void {
    this.ctx.storage.sql.exec(query, ...(bindings as never[]));
  }

  private rows<T>(query: string, ...bindings: unknown[]): T[] {
    return this.ctx.storage.sql.exec(query, ...(bindings as never[])).toArray() as T[];
  }

  private metaOf(ws: WebSocket): SocketMeta | null {
    try {
      return (ws.deserializeAttachment() as SocketMeta) ?? null;
    } catch {
      return null;
    }
  }

  private perceptionSockets(room: string): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      const meta = this.metaOf(ws);
      return meta?.role === "perception" && (meta.room === room || meta.room === "*");
    });
  }

  private send(ws: WebSocket, msg: EngineMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket raced us and closed. The close handler cleans up.
    }
  }

  private pushRegistry(): void {
    const skills = this.skills();
    for (const ws of this.ctx.getWebSockets()) {
      const meta = this.metaOf(ws);
      if (meta?.role === "perception") {
        this.send(ws, { type: "registry", skills, encoderId: meta.encoderId });
      }
    }
  }

  /** Nudge every watching browser to re-read /state, with today's events. */
  private broadcastWatchers(): void {
    this.toWatchers({ type: "changed", events: this.recentTransitions() });
  }

  private toWatchers(payload: unknown): void {
    const json = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (this.metaOf(ws)?.role === "watcher") {
        try {
          ws.send(json);
        } catch {
          // Socket raced us and closed; the close handler cleans up.
        }
      }
    }
  }

  /**
   * Today's transitions, newest first.
   *
   * Bounded rather than paged: this feeds a live column, and a console that
   * can scroll into last week is answering a question nobody asked while
   * watching.
   */
  private recentTransitions() {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    return this.rows<Record<string, unknown>>(
      "SELECT * FROM transitions WHERE at >= ? ORDER BY at DESC LIMIT 60",
      since,
    ).map((r) => ({
      skillKey: String(r.skill_key),
      kind: String(r.kind),
      at: Number(r.at),
      room: String(r.room),
      traceId: String(r.trace_id),
      score: Number(r.score),
      reason: String(r.reason),
      peak: r.peak === null ? null : Number(r.peak),
      heldMs: r.held_ms === null ? null : Number(r.held_ms),
      neededMs: r.needed_ms === null ? null : Number(r.needed_ms),
      neededConf: r.needed_conf === null ? null : Number(r.needed_conf),
      durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
      count: r.count === null ? null : Number(r.count),
      verdictBy: r.verdict_by === null ? null : String(r.verdict_by),
    }));
  }
}

// ------------------------------------------------------------------ mapping

/**
 * Narrow anything to a surface, with the caller's default for absent.
 *
 * The default differs by caller and that is deliberate rather than sloppy. A
 * frame with no header came from a publisher built before screens existed, so
 * it is a camera. A skill with no surface was written without an opinion, so
 * it is `any` and keeps scoring everything exactly as it used to.
 */
function asSurface(value: unknown, fallback: Surface): Surface {
  return value === "camera" || value === "screen" || value === "any" ? value : fallback;
}

/**
 * Narrow anything to a view, defaulting to the frame as it arrived.
 *
 * One fallback rather than a per-caller one, unlike `asSurface`: there is no
 * caller for which an absent view means anything but "the ordinary path".
 * Every skill written before views existed asks about the whole frame, and a
 * row that says nothing is one of those.
 */
function asView(value: unknown, fallback: View = "full"): View {
  return value === "full" || value === "layout" ? value : fallback;
}

function toSkill(r: Record<string, unknown>): Skill {
  return {
    key: String(r.key),
    kind: r.kind as Skill["kind"],
    label: String(r.label),
    room: r.room === null ? null : String(r.room),
    surface: asSurface(r.surface, "any"),
    view: asView(r.view),
    dependsOn: r.depends_on === null ? null : String(r.depends_on),
    enterConf: Number(r.enter_conf),
    exitConf: Number(r.exit_conf),
    dwellS: Number(r.dwell_s),
    exitS: Number(r.exit_s),
    cooldownS: Number(r.cooldown_s),
    escalateAfterS: Number(r.escalate_after_s),
    minCycleS: Number(r.min_cycle_s ?? 0),
    classes: r.classes === null ? null : (JSON.parse(String(r.classes)) as string[]),
    margin: r.margin === null ? null : Number(r.margin),
    bias: Number(r.bias),
    temperature: Number(r.temperature),
    encoderId: r.encoder_id === null ? null : String(r.encoder_id),
    dim: r.dim === null ? null : Number(r.dim),
    weightState: r.weight_state as Skill["weightState"],
    nLabels: Number(r.n_labels),
    sampleHz: Number(r.sample_hz),
    createdAt: Number(r.created_at),
  };
}

function toGoal(r: Record<string, unknown>): Goal {
  return {
    key: String(r.key),
    description: String(r.description),
    type: r.type as Goal["type"],
    cadence: String(r.cadence),
    doneMin: r.done_min === null ? null : Number(r.done_min),
    doneMax: r.done_max === null ? null : Number(r.done_max),
    windowStart: r.window_start === null ? null : String(r.window_start),
    windowEnd: r.window_end === null ? null : String(r.window_end),
    tz: String(r.tz),
    sequenceWindowS: Number(r.sequence_window_s ?? 600),
    stepValue: r.step_value === null ? null : Number(r.step_value),
    stepPeriod: r.step_period === null ? null : (r.step_period as Goal["stepPeriod"]),
    stepOn: r.step_on === null ? null : (r.step_on as Goal["stepOn"]),
    // Nullish rather than null-checked: the column is an ALTER, so a row
    // written before it existed reads as undefined rather than null.
    sourceUrl: r.source_url == null ? null : String(r.source_url),
    createdAt: Number(r.created_at),
  };
}

function toInstance(r: Record<string, unknown>): Instance {
  return {
    id: String(r.id),
    goalKey: String(r.goal_key),
    occurrenceOn: String(r.occurrence_on),
    state: r.state as Instance["state"],
    observed: Number(r.observed),
    targetMin: r.target_min === null ? null : Number(r.target_min),
    settledAt: r.settled_at === null ? null : Number(r.settled_at),
    settledBy: r.settled_by === null ? null : (r.settled_by as Instance["settledBy"]),
    nudgedAt: r.nudged_at === null || r.nudged_at === undefined ? null : Number(r.nudged_at),
    createdAt: Number(r.created_at),
  };
}

/**
 * Sampling rate a kind needs by default.
 *
 * A gate asking "is anyone in this room" is fine twice a minute. A counter is
 * not: a bench press rep lasts two to four seconds, so below about 4 Hz reps
 * are not miscounted, they are invisible. One frame every two seconds, as the
 * design proposes globally, cannot count anything.
 */
function defaultHz(kind: Skill["kind"]): number {
  switch (kind) {
    case "counter":
      return 8;
    case "action":
      return 2;
    case "discriminator":
      return 2;
    case "metric":
      return 0;
    default:
      return 0.5;
  }
}

/**
 * Timings a kind needs, which is the only thing separating a rep counter
 * from a two-minute routine.
 *
 * A counter must promote in well under a second and release immediately, or
 * reps merge into one event; an action wants seconds of dwell so a passing
 * glance is not a session, and minutes of cooldown so one routine is not
 * counted twice. Getting these from the generic defaults is why a squat
 * counter created by the planner could only ever record one rep per ten
 * seconds.
 *
 * A counter's numbers are set by the shape of the state machine rather than
 * by taste. Promotion always costs two frames - one to open candidacy, one
 * to clear dwell - so any dwell below a single sample interval means exactly
 * that floor, and that floor is already the shortest honest debounce there
 * is. Anything longer asks a rep to hold its bottom position: measured at
 * 4.6 Hz, half of all real squats cleared enter for one frame only, and were
 * rejected at 178ms and 215ms against a 400ms dwell.
 */
function defaultDwellS(kind: Skill["kind"]): number {
  if (kind === "counter") return 0.05;
  if (kind === "gate") return 3;
  return 2;
}

/**
 * How long a skill must stay below `exit_conf` before its session ends.
 *
 * Two seconds suits a camera, where dropping out of view really does mean
 * the thing stopped. It is much too twitchy for a screen, where glancing at
 * a message or flicking to another tab for a moment is normal inside an hour
 * of work and should not end the session. Twenty seconds is long enough to
 * ride out an interruption and short enough that walking away still closes
 * the session within a sample or two of a slow screen heartbeat.
 */
function defaultExitS(kind: Skill["kind"], surface: Surface): number {
  if (kind === "counter") return 0.3;
  if (surface === "screen" && (kind === "action" || kind === "object")) return 20;
  return 2;
}

/**
 * How long after a session ends before another may start.
 *
 * A minute is right for a camera action: it stops one trip to the bathroom
 * being recorded as three. It is actively harmful for an accumulating screen
 * goal, where sessions are summed rather than counted - every interruption
 * would then cost a minute of credit that the person was in fact working
 * through, and a choppy hour would score as half of one.
 */
function defaultCooldownS(kind: Skill["kind"], surface: Surface): number {
  if (kind === "counter") return 0;
  if (kind === "action") return surface === "screen" ? 0 : 60;
  return 10;
}

/**
 * The floor on how fast a kind can legitimately repeat.
 *
 * Only a counter has one. A squat is well over a second bottom-to-bottom, and
 * a counter without this floor counts every entry into the pose — sitting
 * down, bending over, pausing mid-set — because a pose detector has no notion
 * of having to come back up.
 */
function defaultMinCycleS(kind: Skill["kind"]): number {
  return kind === "counter" ? 0.7 : 0;
}

/** Target for the n-th occurrence of a progression. */
function progressedTarget(goal: Goal, wins: number): number | null {
  if (goal.doneMin === null) return null;
  if (goal.stepValue === null) return goal.doneMin;
  return goal.doneMin + goal.stepValue * wins;
}

/** YYYY-MM-DD in the goal's own zone, which is the only date that matters. */
function localDate(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function localMinutes(at: number, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(at));
    const [h, m] = parts.split(":").map((n) => Number.parseInt(n, 10));
    return h * 60 + m;
  } catch {
    const d = new Date(at);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
