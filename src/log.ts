/**
 * Structured logging for the Worker and the Engine.
 *
 * One JSON object per line. This file wraps `console.log` because that is how
 * Workers observability ingests logs, and it is the only place in the Worker
 * where `console.log` may appear — everywhere else calls through here, so that
 * the shape of a log line is defined once instead of re-invented per call site.
 *
 * `Event` is a literal union rather than free text. A typo becomes a type
 * error, which is what makes `grep '"ev":"goal.settle"'` trustworthy: it finds
 * every settlement rather than two of the three spellings someone used.
 *
 * `trace_id` is minted when a gate opens and travels with every line caused by
 * that span, including the ones raised in here long after perception emitted
 * the transition. That is what lets one grep reconstruct a whole story: first
 * frame, every near-miss, the escalation, the question, the settled instance.
 */

/** The closed vocabulary. Shared with perception's logger, same names. */
export type Event =
  | "skill.transition"
  | "discriminator.margin"
  | "question.asked"
  | "question.answered"
  | "goal.evaluate"
  | "goal.settle"
  | "probe.refit"
  | "planner.call"
  | "service.start"
  | "service.error";

export type Level = "trace" | "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

/** Workers have no log-level flag, so the floor is a constant we can move. */
const FLOOR: Level = "info";

export interface LogFields {
  [key: string]: unknown;
}

/**
 * A logger bound to one room and one span.
 *
 * Carrying the trace id on the instance rather than passing it per call is
 * deliberate: a line without a trace id is a line you cannot place, and the
 * only reliable way to prevent that is to make it impossible to omit.
 */
export class Logger {
  constructor(
    private room: string,
    private traceId: string = newTraceId(),
  ) {}

  /** A child for a different span, sharing the room. */
  span(traceId: string): Logger {
    return new Logger(this.room, traceId);
  }

  get trace_id(): string {
    return this.traceId;
  }

  emit(level: Level, ev: Event, fields: LogFields = {}): void {
    if (ORDER[level] < ORDER[FLOOR]) return;
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        ev,
        trace_id: this.traceId,
        room: this.room,
        ...fields,
      }),
    );
  }

  debug(ev: Event, fields?: LogFields): void {
    this.emit("debug", ev, fields);
  }
  info(ev: Event, fields?: LogFields): void {
    this.emit("info", ev, fields);
  }
  warn(ev: Event, fields?: LogFields): void {
    this.emit("warn", ev, fields);
  }
  error(ev: Event, fields?: LogFields): void {
    this.emit("error", ev, fields);
  }
}

/**
 * Short, unique, and time-prefixed so that sorting a day of lines puts a
 * session's spans in the order they actually happened.
 */
export function newTraceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return Date.now().toString(16) + hex;
}
