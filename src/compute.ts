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

/**
 * Where the verbs live, which depends on what is being driven.
 *
 * A Serverless Endpoint and a Compute instance take the same three verbs
 * with the same shape - a bearer token and an id in the body - but under
 * different services. Endpoints are the default because they are what the
 * hackathon's own definition of running on Nebius AI Cloud names, and
 * because an id that is not recognisably an instance is far more likely to
 * be one.
 */
function base(id: string): string {
  return id.startsWith("computeinstance")
    ? "https://api.nebius.cloud/compute/v1/instances"
    : "https://api.nebius.cloud/ai/v1/endpoints";
}

/**
 * Where a signed assertion is exchanged for a bearer token.
 *
 * Not auth.nebius.com/oauth2/token, which is the console's own login and
 * answers "Missing required parameter: client_id" to anything a service
 * account sends it. This one is documented for the REST API and is the
 * only one that takes a key-pair assertion.
 */
const TOKEN_URL = "https://auth.eu.nebius.com/oauth2/token/exchange";

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
/** Base64url, which JWT uses and btoa does not produce. */
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A PEM private key, as bytes WebCrypto will accept.
 *
 * PKCS#8 only - the header says which, and getting it wrong fails inside
 * importKey with a message about the key being unsupported rather than
 * about the format, which is a long way from the actual mistake.
 */
export function pkcs8(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
  if (!/^-----BEGIN PRIVATE KEY-----/.test(pem.trim())) {
    throw new Error("expected a PKCS#8 private key (-----BEGIN PRIVATE KEY-----)");
  }
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * The claims Nebius wants in a service account's assertion.
 *
 * Pure, so the shape can be checked without a key or a network. `sub` and
 * `iss` are both the service account: it is asserting about itself. `aud`
 * is the token endpoint, which is what stops an assertion minted for one
 * service being replayed against another.
 */
export function claims(
  serviceAccountId: string,
  now: number,
  ttlSeconds = 300,
): Record<string, unknown> {
  const iat = Math.floor(now / 1000);
  // No `aud`. Nebius documents iss, sub and exp only, and the exchange
  // rejects the assertion when an audience it did not ask for is present.
  // Five minutes because the assertion exists to be spent immediately: the
  // access token it buys lasts twelve hours, so a long-lived assertion is
  // all risk and no convenience.
  return { iss: serviceAccountId, sub: serviceAccountId, iat, exp: iat + ttlSeconds };
}

/**
 * Keep a bearer token, minting and exchanging only when there isn't one.
 *
 * Nebius service accounts do not hand out a bearer token. They give you a
 * key pair, you register the public half, and you prove who you are by
 * signing a short-lived assertion with the private half and trading it for
 * an IAM token. So this signs, exchanges, and caches.
 *
 * An earlier version passed the key straight through as the assertion,
 * which is only correct if the key already is a JWT. Against a PEM it
 * would have 401'd on the first camera - and the first anyone would know
 * is a machine that never wakes.
 */
export class Tokens {
  #value: string | null = null;
  #until = 0;
  #imported: CryptoKey | null = null;
  // Written out rather than a constructor parameter property: the test
  // runner is Node's own strip-only mode, which cannot transform those.
  readonly #key: string;
  readonly #sa: string;
  readonly #kid: string;

  /**
   * The secret, in whichever of the three shapes it arrives.
   *
   * A service account key is three facts that only work together - the
   * private key, whose public half is registered, and the id of the account
   * it belongs to. Three separate environment variables can disagree with
   * each other, and the failure is a 401 that says nothing about which one
   * is wrong. So they travel as one JSON secret, which is also the shape
   * Nebius hands you when it generates a key itself.
   *
   * A plain string is still accepted: a long-lived API key, or an assertion
   * minted elsewhere.
   */
  constructor(secret: string) {
    const s = secret.trim();
    if (s.startsWith("{")) {
      const j = JSON.parse(s) as Record<string, string>;
      this.#key = j["private-key"] ?? j.privateKey ?? "";
      this.#sa = j["subject-id"] ?? j.subjectId ?? j.serviceAccountId ?? "";
      this.#kid = j["public-key-id"] ?? j.publicKeyId ?? j.keyId ?? "";
      if (!this.#key) throw new Error("service account key has no private-key");
    } else {
      this.#key = s;
      this.#sa = "";
      this.#kid = "";
    }
  }

  async bearer(now: number = Date.now()): Promise<string> {
    // A minute of headroom: a token that expires between this check and the
    // request it authorises is the same outage as no token at all.
    if (this.#value !== null && now < this.#until - 60_000) return this.#value;

    const assertion = this.#key.includes("-----BEGIN")
      ? await this.#sign(now)
      : this.#key; // already a JWT, or a plain long-lived API key

    // A key with no dots and no PEM header cannot be an assertion, so it is
    // used as the bearer directly rather than offered to an exchange that
    // would only reject it.
    if (!assertion.includes(".")) {
      this.#value = assertion;
      this.#until = now + 3_600_000;
      return this.#value;
    }

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // Named explicitly. The auth host sits behind Cloudflare and so does
        // this Worker, and the request arrived at the origin as something it
        // would not answer: 522 from the edge, while the identical exchange
        // from a shell returned 200 three times out of three. A plain client
        // string is the difference between a bot rule firing and not.
        "User-Agent": "pact-control-plane/1.0",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        subject_token: assertion,
      }),
    });
    if (!res.ok) throw new Error(`token exchange ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("token exchange returned no token");
    this.#value = body.access_token;
    this.#until = now + (body.expires_in ?? 3600) * 1000;
    return this.#value;
  }

  /** RS256 over the claims, with the registered key's id in the header. */
  async #sign(now: number): Promise<string> {
    if (!this.#sa || !this.#kid) {
      throw new Error("a PEM key needs the service account id and the public key id");
    }
    // Imported once. The import is the expensive half and the key does not
    // change for the life of the object.
    this.#imported ??= await crypto.subtle.importKey(
      "pkcs8",
      pkcs8(this.#key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const enc = new TextEncoder();
    const head = b64url(enc.encode(JSON.stringify({ alg: "RS256", kid: this.#kid })));
    const body = b64url(enc.encode(JSON.stringify(claims(this.#sa, now))));
    const signed = `${head}.${body}`;
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      this.#imported,
      enc.encode(signed),
    );
    return `${signed}.${b64url(new Uint8Array(sig))}`;
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
  const res = await fetch(`${base(cfg.instanceId)}/${encodeURIComponent(cfg.instanceId)}`, {
    headers: { Authorization: `Bearer ${await tokens.bearer()}` },
  });
  if (!res.ok) throw new Error(`instance get ${res.status}`);
  const body = (await res.json()) as { status?: { state?: string } };
  return normalise(body.status?.state);
}

/**
 * Nebius state strings, mapped onto the five this cares about.
 *
 * The endpoint vocabulary is the documented one: PROVISIONING, STARTING,
 * IMAGE_PULLING, RUNNING, STOPPING, STOPPED, DELETING, ERROR and
 * STATE_UNSPECIFIED. Pulling a multi-gigabyte image is a real and slow part
 * of coming up, so IMAGE_PULLING is `starting` rather than something to act
 * on - treating it as anything else would have the control plane issue a
 * second start while the first is still downloading.
 */
export function normalise(state: string | undefined): ComputeState {
  switch ((state ?? "").toUpperCase()) {
    case "RUNNING":
      return "running";
    case "PROVISIONING":
    case "IMAGE_PULLING":
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
    // ERROR is deliberately not `stopped`. A container that failed to start
    // will fail again, and a control plane that retries it every minute
    // turns one broken image into a bill. It needs a person, so it reads as
    // do-not-touch and the caller logs it.
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
  const res = await fetch(`${base(cfg.instanceId)}/${which}`, {
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
 * Ask a GitHub runner to start the machine.
 *
 * The control plane knows the moment a camera arrives and cannot act on it.
 * Measured from inside this Worker: auth.eu.nebius.com 522,
 * api.nebius.cloud 522, api.github.com 200. Every Nebius host is behind
 * Cloudflare and so is this, and the edge times out on their origin - which
 * is not a configuration anybody here can change, it is where the code
 * lives.
 *
 * So the request goes to a runner, which is outside Cloudflare and can make
 * the call. It costs a runner spinning up, twenty or forty seconds, against
 * the ninety the machine then spends loading four gigabytes - so the whole
 * detour hides inside a wait that already existed.
 *
 * Fire and forget by the caller's choice. A camera arriving must not wait
 * on GitHub, and a dispatch that failed is reported rather than retried:
 * the next publisher, or the next alarm, asks again.
 */
export async function askRunnerToStart(
  token: string,
  repo: string,
  ref = "main",
): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/vm.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        // GitHub rejects a request with no User-Agent outright, with a
        // message about the agent rather than about the token.
        "User-Agent": "pact-control-plane",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref, inputs: { action: "start" } }),
    },
  );
  // 204 is the documented success. Anything else is worth the caller seeing.
  if (res.status !== 204) {
    throw new Error(`dispatch ${res.status} ${(await res.text()).slice(0, 120)}`);
  }
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
    // This is also what makes preemptible safe to use. A preempted endpoint
    // goes to STOPPED and Nebius does not bring it back - it stays down
    // until something starts it. Something does: the next camera to publish.
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
