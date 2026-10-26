import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type ComputeState, decide, normalise, Tokens } from "./compute.ts";

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
