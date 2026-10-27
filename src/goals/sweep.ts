/**
 * Which skills go when a goal goes.
 *
 * A skill no goal names any more is not merely clutter: perception embeds it,
 * scores it against every frame and reports it, and the console draws it a
 * series. So deleting a goal sweeps up whatever was only ever its, and keeps
 * anything another goal still shares.
 *
 * That much was already true. What this module exists for is the half that
 * was not, and which turned deleting a goal into a 500 and a half-finished
 * deletion: `skills.depends_on` is a foreign key into `skills` itself, so the
 * gate tree constrains the ORDER the sweep may happen in, and it had none.
 * The sweep deleted in whatever order the table returned - which is creation
 * order, and gates are always created before the skills beneath them - so it
 * deleted a gate while a child still pointed at it, SQLite refused, and the
 * route threw after the goal row had already gone.
 *
 * Two separate things follow from one foreign key and they are worth keeping
 * apart:
 *
 * A survivor's parent is not an orphan. A child kept because a second goal
 * still uses it needs its gate, even if nothing names that gate directly -
 * and the alternative, cutting the child loose, is worse than keeping one
 * row. An ungated screen skill scores every frame of every camera, which is
 * the failure the gate was there to prevent.
 *
 * Among the doomed, the order stops mattering once the references between
 * them are gone. `orphanedSkills` returns the set; the caller clears
 * `depends_on` across it before deleting, which is one statement and holds
 * however tangled the tree is - a cycle included, and a cycle is reachable,
 * because creating a skill is an upsert and nothing stops B being re-created
 * pointing at A after A was pointed at B.
 */

/** Just enough of a skill row to work out what depends on what. */
export interface SkillLink {
  key: string;
  dependsOn: string | null;
}

/**
 * The skills that should go, given which ones a live goal still names.
 *
 * `referenced` is the set a goal currently points at. Everything else is a
 * candidate, and a candidate is spared only if something that survives
 * depends on it - which has to be worked out to a fixed point rather than in
 * one pass, because sparing a gate can itself spare the gate above it.
 *
 * Returns keys in no particular order on purpose. An order that mattered
 * would be an order a caller could get wrong; clearing `depends_on` across
 * the whole set first is what makes any order safe.
 */
export function orphanedSkills(skills: SkillLink[], referenced: Set<string>): string[] {
  const doomed = new Set(skills.map((s) => s.key).filter((key) => !referenced.has(key)));

  // A parent of a survivor survives, and so does ITS parent. Bounded by the
  // number of skills rather than by a trusted depth: the loop only repeats
  // when it spared something, so a tree this deep is the only thing that
  // could need this many passes, and a cycle cannot spin it.
  for (let pass = 0; pass < skills.length; pass++) {
    let spared = false;
    for (const skill of skills) {
      if (doomed.has(skill.key)) continue;
      if (skill.dependsOn === null) continue;
      if (!doomed.has(skill.dependsOn)) continue;
      doomed.delete(skill.dependsOn);
      spared = true;
    }
    if (!spared) break;
  }

  return [...doomed];
}
