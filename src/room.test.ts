/**
 * The room slug, which exists in two languages and must mean one thing.
 *
 * The Hub stamps it and perception keeps the same rule as a fallback for an
 * older hub. If the two ever disagree, a camera's scores land on another
 * camera's chart and nothing says so - the quietest possible failure. The
 * case table is shared with the Python side so both are held to it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readFileSync } from "node:fs";

import { roomOf } from "./room.ts";

// Read rather than imported: an import attribute would need the whole
// project moved to a different module setting for one test file. Read by
// plain path rather than through a URL, because @types/node and
// @cloudflare/workers-types disagree about what a URL is and only the test
// config has both loaded. npm scripts run from the package root.
const cases = JSON.parse(readFileSync("src/room-cases.json", "utf8")) as [
  string,
  string,
  string,
][];

for (const [name, id, want] of cases) {
  test(`roomOf(${JSON.stringify(name)}, ${id}) -> ${want}`, () => {
    assert.equal(roomOf({ name, id }), want);
  });
}
