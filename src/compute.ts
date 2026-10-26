/**
 * Starting and stopping the encoder's machine, from liveness.
 *
 * Nebius AI Cloud bills compute per second and stops billing it when an
 * instance is stopped, but it does not scale to zero on its own - Serverless
 * Endpoints keep running until something stops them. So the thing that knows
 * when an encoder is needed has to say so, and the only thing that knows is
 * the Hub: a publisher socket opening *is* a camera arriving.
 *
 * That makes this the missing half of a property the design already had.
 * Perception dials out, so the control plane never needed to know where it
 * runs. Here the control plane says *whether* it runs, which is a different
 * fact and the one that costs money.
 *
 * Deliberately not a general cloud client. Two verbs, one instance, and a
 * status read - anything more belongs in Terraform, where the instance is
 * defined in the first place.
 */

/** Where Nebius accepts instance verbs. */
const API = "https://api.nebius.cloud/compute/v1/instances";

/** Where a service account key is exchanged for a bearer token. */
const TOKEN_URL = "https://auth.nebius.com/oauth2/token";

/**
 * What the control plane believes about the encoder's machine.
 *
 * `starting` and `stopping` are held rather than inferred because the verbs
 * are not instant and a second call during the gap is the easiest way to
 * start two instances or to fight your own stop. Anything unrecognised maps
 * to `unknown`, which is treated as "do not touch" rather than as "safe to
 * start".
 */
export type ComputeState = "running" | "starting" | "stopped" | "stopping" | "unknown";

export interface ComputeConfig {
  /** The instance to drive. Absent means the whole feature is off. */
  instanceId: string | undefined;
  /**
   * A long-lived Nebius API key, or a service account key to exchange.
   *
   * Both are accepted because which one an account has is not knowable from
   * here, and a deploy that works in one Nebius project and silently does
   * nothing in another is worse than either.
   */
  token: string | undefined;
}

/**
 * Keep a bearer token, exchanging only when there isn't a usable one.
 *
 * Nebius IAM tokens are short-lived. Exchanging on every call would add a
 * round trip to a path that already has a cold start to apologise for, and
 * caching without an expiry would fail an hour later in a way that reads as
 * "the cloud is broken" rather than "the token aged out".
 */
export class Tokens {
  #value: string | null = null;
  #until = 0;
  // Written out rather than a constructor parameter property: the test
  // runner is Node's own strip-only mode, which cannot transform those.
  readonly #key: string;

  constructor(key: string) {
    this.#key = key;
  }

  async bearer(now: number = Date.now()): Promise<string> {
    // A minute of headroom: a token that expires between this check and the
    // request it authorises is the same outage as no token at all.
    if (this.#value !== null && now < this.#until - 60_000) return this.#value;

    // A key that is already a bearer token is used as one. Nebius API keys
    // and service account keys are both strings from here, and the only
    // honest way to tell them apart is to try the exchange and see.
    if (!this.#key.includes(".")) {
      this.#value = this.#key;
      this.#until = now + 3_600_000;
      return this.#value;
    }

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        subject_token: this.#key,
      }),
    });
    if (!res.ok) throw new Error(`token exchange ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("token exchange returned no token");
    this.#value = body.access_token;
    this.#until = now + (body.expires_in ?? 3600) * 1000;
    return this.#value;
  }
}

/**
 * Read what Nebius says the instance is doing.
 *
 * Asked rather than remembered on every decision, because the instance can
 * also be started and stopped by a person at a console, and a cached belief
 * that disagrees with the cloud spends real money.
 */
export async function statusOf(cfg: ComputeConfig, tokens: Tokens): Promise<ComputeState> {
  if (!cfg.instanceId) return "unknown";
  const res = await fetch(`${API}/${encodeURIComponent(cfg.instanceId)}`, {
    headers: { Authorization: `Bearer ${await tokens.bearer()}` },
  });
  if (!res.ok) throw new Error(`instance get ${res.status}`);
  const body = (await res.json()) as { status?: { state?: string } };
  return normalise(body.status?.state);
}

/** Nebius state strings, mapped onto the five this cares about. */
export function normalise(state: string | undefined): ComputeState {
  switch ((state ?? "").toUpperCase()) {
    case "RUNNING":
      return "running";
    case "STARTING":
    case "CREATING":
    case "UPDATING":
      return "starting";
    case "STOPPED":
    case "DELETED":
      return "stopped";
    case "STOPPING":
    case "DELETING":
      return "stopping";
    default:
      return "unknown";
  }
}

/** Start it. Safe to call when it is already starting or running. */
export async function start(cfg: ComputeConfig, tokens: Tokens): Promise<void> {
  await verb("start", cfg, tokens);
}

/** Stop it. Safe to call when it is already stopping or stopped. */
export async function stop(cfg: ComputeConfig, tokens: Tokens): Promise<void> {
  await verb("stop", cfg, tokens);
}

async function verb(which: "start" | "stop", cfg: ComputeConfig, tokens: Tokens): Promise<void> {
  if (!cfg.instanceId) throw new Error("no instance configured");
  const res = await fetch(`${API}/${which}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await tokens.bearer()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: cfg.instanceId }),
  });
  // 409 is "already in that state", which is the goal rather than a failure.
  if (!res.ok && res.status !== 409) throw new Error(`${which} ${res.status}`);
}

/**
 * Whether to act, given what the cloud says and whether anything is watching.
 *
 * Pure, and separate from the calls above, because this is the part with a
 * right answer and the part that costs money when it is wrong. Two mistakes
 * matter in opposite directions: starting an instance nobody needs burns a
 * GPU hour, and stopping one while a camera is publishing loses the session
 * and makes the product look broken.
 *
 * `idleSince` is when the last publisher went away, or 0 while one is live.
 */
export function decide(
  state: ComputeState,
  publishers: number,
  idleSince: number,
  now: number,
  graceMs: number,
): "start" | "stop" | "wait" {
  if (publishers > 0) {
    // Only from a settled stop. Asking a stopping instance to start races the
    // stop, and Nebius answers the second verb from whichever state it has
    // reached - so the result is genuinely unpredictable rather than merely
    // slow. Waiting costs one tick.
    return state === "stopped" ? "start" : "wait";
  }
  if (state !== "running") return "wait";
  // A grace period, because a tab refresh is not an empty house. Without it
  // every reload pays a cold start, and a cold start here is a minute of a
  // person watching a blank console.
  return idleSince > 0 && now - idleSince >= graceMs ? "stop" : "wait";
}
