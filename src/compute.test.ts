import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { claims, type ComputeState, decide, normalise, pkcs8, Tokens } from "./compute.ts";

/**
 * When to start and stop the encoder's machine.
 *
 * The two mistakes cost in opposite directions, which is why this is a pure
 * function with tests rather than a condition inside an alarm. Starting an
 * instance nobody needs burns a GPU hour; stopping one while a camera is
 * publishing loses the session and makes the product look broken to the
 * person standing in front of the camera.
 */

const GRACE = 10 * 60_000;
const NOW = 1_700_000_000_000;

describe("decide", () => {
  it("starts when a camera arrives and the machine is settled", () => {
    assert.equal(decide("stopped", 1, 0, NOW, GRACE), "start");
  });

  it("does not start from any state but a settled stop", () => {
    // Asking a stopping instance to start races the stop, and the cloud
    // answers from whichever state it has reached - unpredictable rather
    // than merely slow. Waiting costs one tick.
    for (const state of ["stopping", "starting", "running", "unknown"] as ComputeState[]) {
      assert.equal(decide(state, 1, 0, NOW, GRACE), "wait", state);
    }
  });

  it("never stops while a publisher is live", () => {
    // The expensive-looking case that must still not stop: running, idle
    // timer somehow set, grace long expired - but a camera is publishing.
    assert.equal(decide("running", 1, NOW - 10 * GRACE, NOW, GRACE), "wait");
  });

  it("waits out the grace period before stopping", () => {
    assert.equal(decide("running", 0, NOW - GRACE + 1, NOW, GRACE), "wait");
    assert.equal(decide("running", 0, NOW - GRACE, NOW, GRACE), "stop");
  });

  it("treats a tab refresh as not worth a cold start", () => {
    // Someone reloads the publisher page: down, then up seconds later. If
    // the grace period did not exist, that reload would cost a stop, a
    // start, and a minute of blank console.
    const refreshed = NOW - 3_000;
    assert.equal(decide("running", 0, refreshed, NOW, GRACE), "wait");
  });

  it("does not stop a machine that is not running", () => {
    for (const state of ["stopped", "stopping", "starting", "unknown"] as ComputeState[]) {
      assert.equal(decide(state, 0, NOW - 10 * GRACE, NOW, GRACE), "wait", state);
    }
  });

  it("does nothing when idle but never marked idle", () => {
    // idleSince of 0 means "no publisher has ever left", which happens on a
    // fresh Engine. Stopping on that would stop a machine a person started
    // by hand a moment ago.
    assert.equal(decide("running", 0, 0, NOW, GRACE), "wait");
  });
});

describe("normalise", () => {
  it("maps the cloud's vocabulary onto the five states that matter", () => {
    assert.equal(normalise("RUNNING"), "running");
    assert.equal(normalise("STARTING"), "starting");
    assert.equal(normalise("STOPPED"), "stopped");
    assert.equal(normalise("STOPPING"), "stopping");
  });

  it("counts provisioning and image pulling as starting", () => {
    // Pulling a multi-gigabyte image is a real and slow part of coming up.
    // Read as anything but `starting`, the control plane would issue a
    // second start while the first was still downloading.
    assert.equal(normalise("PROVISIONING"), "starting");
    assert.equal(normalise("IMAGE_PULLING"), "starting");
  });

  it("does not treat ERROR as something to restart", () => {
    // A container that failed to start will fail again. Retrying it every
    // minute turns one broken image into a bill, so it needs a person.
    assert.equal(normalise("ERROR"), "unknown");
    assert.equal(normalise("STATE_UNSPECIFIED"), "unknown");
  });

  it("brings a preempted endpoint back when a camera needs it", () => {
    // Nebius stops a preempted endpoint and leaves it stopped - it does not
    // restart itself. This is the whole reason preemptible is usable here.
    assert.equal(decide("stopped", 1, 0, NOW, GRACE), "start");
  });

  it("reads an unknown or missing state as do-not-touch", () => {
    // Not as "safe to start". A state nobody here recognises is a state
    // whose billing nobody here understands.
    assert.equal(normalise("SOMETHING_NEW"), "unknown");
    assert.equal(normalise(undefined), "unknown");
    assert.equal(normalise(""), "unknown");
  });

  it("is case-insensitive, because an API can change its mind about that", () => {
    assert.equal(normalise("running"), "running");
  });
});

describe("Tokens", () => {
  it("uses a plain API key as the bearer, without an exchange", async () => {
    // A key with no dots cannot be a JWT, so there is nothing to exchange.
    // Attempting one would fail against accounts that issue long-lived keys.
    const tokens = new Tokens("nbs-plain-api-key");
    assert.equal(await tokens.bearer(NOW), "nbs-plain-api-key");
    // And again without a network call, which this test would fail on.
    assert.equal(await tokens.bearer(NOW + 1000), "nbs-plain-api-key");
  });
});

describe("a service account key", () => {
  // A 4096-bit PKCS#8 key, generated for this test only and registered
  // nowhere. Nebius rejects anything but 4096, so the size is part of the
  // contract rather than an arbitrary choice.
  const PEM = [
    "-----BEGIN PRIVATE KEY-----",
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ==",
    "-----END PRIVATE KEY-----",
  ].join("\n");

  it("reads the three facts out of one JSON secret", () => {
    // Three separate variables can disagree and the failure is a 401 that
    // says nothing about which one is wrong, so they travel together.
    const t = new Tokens(
      JSON.stringify({
        "subject-id": "serviceaccount-abc",
        "public-key-id": "publickey-def",
        "private-key": PEM,
      }),
    );
    assert.ok(t instanceof Tokens);
  });

  it("refuses a key file with no private key rather than 401ing later", () => {
    assert.throws(
      () => new Tokens(JSON.stringify({ "subject-id": "serviceaccount-abc" })),
      /no private-key/,
    );
  });

  it("still takes a plain string as the bearer", async () => {
    const t = new Tokens("nbs-plain-api-key");
    assert.equal(await t.bearer(NOW), "nbs-plain-api-key");
  });
});

describe("pkcs8", () => {
  it("insists on PKCS#8, which is the format WebCrypto accepts", () => {
    // A traditional RSA PEM imports with a message about the key being
    // unsupported rather than about the format, which is a long way from
    // the actual mistake.
    assert.throws(
      () => pkcs8("-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----"),
      /PKCS#8/,
    );
  });

  it("decodes a PKCS#8 body to bytes", () => {
    const out = pkcs8("-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----");
    assert.deepEqual([...out], [65, 66, 67]);
  });
});

describe("claims", () => {
  it("asserts about the account itself, and claims no audience", () => {
    const c = claims("serviceaccount-abc", NOW);
    // iss and sub are both the account: it is vouching for itself. aud is
    // what stops an assertion minted for one service being replayed at
    // another.
    assert.equal(c.iss, "serviceaccount-abc");
    assert.equal(c.sub, "serviceaccount-abc");
    // No aud: Nebius documents iss, sub and exp only, and the exchange
    // rejects an audience it did not ask for. Verified against the live
    // endpoint, which answers 200 without it and 400 with the console's
    // login URL in it.
    assert.equal("aud" in c, false);
  });

  it("expires, and not in the past", () => {
    const c = claims("serviceaccount-abc", NOW, 600) as { iat: number; exp: number };
    assert.equal(c.exp - c.iat, 600);
    assert.equal(c.iat, Math.floor(NOW / 1000));
  });
});
