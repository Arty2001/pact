/**
 * Which skills a goal takes with it.
 *
 * The case that mattered, and the one that was broken in production: a goal
 * with a gate and a child beneath it. Both become unreferenced, and
 * `skills.depends_on` is a foreign key into `skills`, so deleting them in the
 * order the table happened to return - creation order, gates first - made
 * SQLite refuse. The route threw a 500 after the goal row had already gone,
 * which is why deleting a goal left its skills behind and the console looked
 * frozen.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { orphanedSkills, type SkillLink } from "./sweep.ts";

const tree: SkillLink[] = [
  { key: "editor", dependsOn: null },
  { key: "writing", dependsOn: "editor" },
  { key: "sink", dependsOn: null },
  { key: "brushing", dependsOn: "sink" },
];

function swept(skills: SkillLink[], referenced: string[]): string[] {
  return orphanedSkills(skills, new Set(referenced)).sort();
}

test("a gate and its child both go when nothing names either", () => {
  assert.deepEqual(swept(tree, ["sink", "brushing"]), ["editor", "writing"]);
});

test("a skill another goal still names is kept", () => {
  assert.deepEqual(swept(tree, ["editor", "writing", "sink", "brushing"]), []);
});

test("everything goes when the last goal does", () => {
  assert.deepEqual(swept(tree, []), ["brushing", "editor", "sink", "writing"]);
});

// ------------------------------------------------- a survivor's parent stays

test("a gate nothing names is kept while a child still needs it", () => {
  // The second goal reused the child without the gate. Cutting the child
  // loose instead would leave an ungated screen skill scoring every frame of
  // every camera, which is the failure the gate existed to prevent.
  assert.deepEqual(swept(tree, ["writing"]), ["brushing", "sink"]);
});

test("sparing a gate spares the gate above it", () => {
  // Needs a fixed point, not one pass: `desk` is only reachable as a parent
  // once `editor` has itself been spared.
  const deep: SkillLink[] = [
    { key: "desk", dependsOn: null },
    { key: "editor", dependsOn: "desk" },
    { key: "writing", dependsOn: "editor" },
  ];
  assert.deepEqual(swept(deep, ["writing"]), []);
});

test("a chain is swept whole when its tip is unreferenced too", () => {
  const deep: SkillLink[] = [
    { key: "desk", dependsOn: null },
    { key: "editor", dependsOn: "desk" },
    { key: "writing", dependsOn: "editor" },
    { key: "kept", dependsOn: null },
  ];
  assert.deepEqual(swept(deep, ["kept"]), ["desk", "editor", "writing"]);
});

// ----------------------------------------------------------- malformed data

test("a parent that does not exist is not a reason to keep anything", () => {
  // depends_on is a foreign key, so this should be impossible - and a
  // registry is data, and this returning nothing would silently stop the
  // sweep working at all.
  const broken: SkillLink[] = [{ key: "orphan", dependsOn: "never_existed" }];
  assert.deepEqual(swept(broken, []), ["orphan"]);
});

test("a cycle among the doomed does not spin, and is still swept", () => {
  // Reachable, because creating a skill is an upsert: nothing stops `b`
  // being re-created pointing at `a` after `a` was pointed at `b`. The
  // caller clears depends_on across the set before deleting, so a cycle
  // costs nothing beyond terminating here.
  const looped: SkillLink[] = [
    { key: "a", dependsOn: "b" },
    { key: "b", dependsOn: "a" },
  ];
  assert.deepEqual(swept(looped, []), ["a", "b"]);
});

test("a cycle hanging off a survivor is kept whole", () => {
  const looped: SkillLink[] = [
    { key: "a", dependsOn: "b" },
    { key: "b", dependsOn: "a" },
    { key: "child", dependsOn: "a" },
  ];
  assert.deepEqual(swept(looped, ["child"]), []);
});

test("no skills at all is not an error", () => {
  assert.deepEqual(swept([], []), []);
});
