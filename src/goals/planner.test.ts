/**
 * Which picture of a frame a drafted skill ends up asking about.
 *
 * The planner's own output is a model's, so it is not tested here. What is
 * tested is the rule applied to it, and the reason that rule exists in code
 * at all: every way of getting a view wrong is invisible. A screen gate left
 * on "full" scores, calibrates and fires exactly as a working one does - it
 * simply follows whatever clip is playing inside the player rather than the
 * player, and the symptom arrives weeks later as a threshold that will not
 * hold.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { viewFor } from "./planner.ts";

// ------------------------------------------------------------ the default

test("a screen gate defaults to layout", () => {
  // The case the whole feature exists for. A gate names the KIND of screen,
  // and a kind of screen is a shape rather than a content.
  assert.equal(viewFor(undefined, "screen", "gate"), "layout");
});

test("what sits beneath a screen gate defaults to full", () => {
  // The child names the state that counts, and the state that counts is
  // usually in the content - which layout is there to destroy.
  for (const kind of ["action", "object", "counter", "discriminator"]) {
    assert.equal(viewFor(undefined, "screen", kind), "full", kind);
  }
});

test("a camera skill is full whatever the kind", () => {
  for (const kind of ["gate", "action", "object", "counter"]) {
    assert.equal(viewFor(undefined, "camera", kind), "full", kind);
  }
});

// ------------------------------------------------------------- the clamp

test("layout is refused on a camera", () => {
  // Not a poor choice of tuning. Averaging a room away removes the person
  // the question was about, and the detector would calibrate quite happily
  // against what is left.
  assert.equal(viewFor("layout", "camera", "gate"), "full");
  assert.equal(viewFor("layout", "camera", "action"), "full");
});

test("a skill with no opinion about its surface is full", () => {
  // `any` reaches here from a skill written before surfaces existed. It is
  // scored against camera frames too, so it inherits the camera rule.
  assert.equal(viewFor("layout", "any", "gate"), "full");
});

// --------------------------------------------------------- what it honours

test("a stated view wins on a screen", () => {
  // The prompt explains the trade, so a model that overrides the default has
  // been told what it is choosing between.
  assert.equal(viewFor("full", "screen", "gate"), "full");
  assert.equal(viewFor("layout", "screen", "action"), "layout");
});

test("nonsense falls back to the default rather than through", () => {
  // Tool arguments are a model's JSON and are allowed to be anything.
  for (const junk of [null, "", "sideways", 7, {}, []]) {
    assert.equal(viewFor(junk, "screen", "gate"), "layout", JSON.stringify(junk));
    assert.equal(viewFor(junk, "screen", "action"), "full", JSON.stringify(junk));
  }
});
