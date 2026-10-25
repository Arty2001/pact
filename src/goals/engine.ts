import { Logger, newTraceId } from "../log";
import { evaluate, inWindow } from "./evaluate";
import { plan } from "./planner";
import { SCHEMA } from "./schema";
import type {
  EngineMessage,
  Goal,
  GoalSkill,
  Instance,
  PerceptionMessage,
  Skill,
  Transition,
} from "./types";

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

export class Engine implements DurableObject {
  private log: Logger;

  constructor(
    private ctx: DurableObjectState,
    private env: { NEBIUS_API_KEY?: string },
  ) {
    this.ctx.storage.sql.exec(SCHEMA);
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

    if (path === "/plan" && request.method === "POST") return this.plan(request);

    if (path === "/skills") {
      if (request.method === "GET") return Response.json({ skills: this.skills() });
      if (request.method === "POST") return this.createSkill(request);
    }

    if (path === "/goals") {
      if (request.method === "GET") return Response.json({ goals: this.goals() });
      if (request.method === "POST") return this.createGoal(request);
    }

    const goalMatch = path.match(/^\/goals\/([A-Za-z0-9_\-/]+)$/);
    if (goalMatch && request.method === "DELETE") {
      this.sql("DELETE FROM goals WHERE key = ?", goalMatch[1]);
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
    for (const goal of this.goals()) {
      this.ensureInstance(goal);
    }
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
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
    const { sentence, tz } = (await request.json()) as { sentence?: string; tz?: string };
    if (!sentence) return Response.json({ error: "sentence is required" }, { status: 400 });

    const started = Date.now();
    try {
      const draft = await plan(this.env.NEBIUS_API_KEY, sentence, this.skills(), tz ?? "UTC");
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
      this.sql("UPDATE skills SET weight_state = 'fitted' WHERE key = ?", msg.skillKey);
      this.log.info("probe.refit", {
        skill: msg.skillKey,
        n_examples: msg.nExamples,
        holdout_before: msg.holdoutBefore,
        holdout_after: msg.holdoutAfter,
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
    const targets = this.perceptionSockets(room);
    if (targets.length > 0) {
      const jpegBase64 = base64(bytes);
      const msg: EngineMessage = { type: "frame", room, seq, ts: Date.now(), jpegBase64 };
      for (const ws of targets) this.send(ws, msg);
    }

    return Response.json({ delivered: targets.length, bytes: bytes.byteLength });
  }

  // --------------------------------------------------------------- the rows

  private createSkill = async (request: Request): Promise<Response> => {
    const body = (await request.json()) as Partial<Skill> & { key: string; label: string };
    if (!body.key || !body.label) {
      return Response.json({ error: "key and label are required" }, { status: 400 });
    }
    const now = Date.now();
    this.sql(
      `INSERT OR REPLACE INTO skills
        (key, kind, label, room, depends_on, enter_conf, exit_conf, dwell_s, exit_s,
         cooldown_s, escalate_after_s, classes, margin, sample_hz, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      body.key,
      body.kind ?? "object",
      body.label,
      body.room ?? null,
      body.dependsOn ?? null,
      body.enterConf ?? 0.75,
      body.exitConf ?? 0.45,
      body.dwellS ?? 2.0,
      body.exitS ?? 2.0,
      body.cooldownS ?? 10.0,
      body.escalateAfterS ?? 60.0,
      body.classes ? JSON.stringify(body.classes) : null,
      body.margin ?? null,
      body.sampleHz ?? defaultHz(body.kind ?? "object"),
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

    this.sql(
      `INSERT OR REPLACE INTO goals
        (key, description, type, cadence, done_min, done_max, window_start, window_end,
         tz, step_value, step_period, step_on, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      body.key,
      body.description,
      body.type ?? "target",
      body.cadence ?? "daily",
      body.doneMin ?? null,
      body.doneMax ?? null,
      body.windowStart ?? null,
      body.windowEnd ?? null,
      body.tz ?? "UTC",
      body.stepValue ?? null,
      body.stepPeriod ?? null,
      body.stepOn ?? null,
      Date.now(),
    );

    this.sql("DELETE FROM goal_skills WHERE goal_key = ?", body.key);
    for (const use of body.uses ?? []) {
      this.sql(
        `INSERT OR REPLACE INTO goal_skills
          (goal_key, skill_key, role, class_key, min_count, accumulate, sequence_index)
         VALUES (?,?,?,?,?,?,?)`,
        body.key,
        use.skillKey,
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
         held_ms, needed_ms, peak, count, class_key, p1, p2, margin, verdict_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
    this.broadcastWatchers();
  }

  private settleIfDue(goal: Goal, log: Logger): void {
    const instance = this.ensureInstance(goal);
    if (instance.state === "done" || instance.state === "violated") return;

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
    });

    this.sql("UPDATE instances SET observed = ? WHERE id = ?", verdict.observed, instance.id);

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

  // --------------------------------------------------------------- reading

  /** Everything the UI needs, in one request. */
  private state() {
    return {
      skills: this.skills(),
      goals: this.goals().map((goal) => ({
        ...goal,
        uses: this.links(goal.key),
        instances: this.instances(goal.key),
      })),
      questions: this.openQuestions(),
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

  /** Nudge every watching browser to re-read /state. */
  private broadcastWatchers(): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.metaOf(ws)?.role === "watcher") {
        try {
          ws.send(JSON.stringify({ type: "changed" }));
        } catch {
          // Same race as above.
        }
      }
    }
  }
}

// ------------------------------------------------------------------ mapping

function toSkill(r: Record<string, unknown>): Skill {
  return {
    key: String(r.key),
    kind: r.kind as Skill["kind"],
    label: String(r.label),
    room: r.room === null ? null : String(r.room),
    dependsOn: r.depends_on === null ? null : String(r.depends_on),
    enterConf: Number(r.enter_conf),
    exitConf: Number(r.exit_conf),
    dwellS: Number(r.dwell_s),
    exitS: Number(r.exit_s),
    cooldownS: Number(r.cooldown_s),
    escalateAfterS: Number(r.escalate_after_s),
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
    stepValue: r.step_value === null ? null : Number(r.step_value),
    stepPeriod: r.step_period === null ? null : (r.step_period as Goal["stepPeriod"]),
    stepOn: r.step_on === null ? null : (r.step_on as Goal["stepOn"]),
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
