/* ===========================================================================
   The goals page.

   Reads one endpoint, /api/engine/state, and re-reads it when the Engine says
   something changed. There is no client-side model: a goal's state lives in
   the ledger, and keeping a second copy here would only let the two disagree
   about whether you did your workout.

   The page is ordered by who is waiting. Questions first, because they are
   the only thing on the page waiting on the person reading it; everything
   below is a record.
   =========================================================================== */

const el = (id) => document.getElementById(id);

const qlist = el("qlist");
const glist = el("glist");
const slist = el("slist");

let state = { skills: [], goals: [], questions: [], perception: [] };

// --------------------------------------------------------------- clock --

setInterval(() => {
  el("stat-clock").textContent = new Date().toISOString().slice(11, 19);
}, 1000);

// ---------------------------------------------------------------- load --

async function load() {
  const res = await fetch("/api/engine/state");
  if (!res.ok) return;
  state = await res.json();
  render();
}

/**
 * The Engine pushes a bare "changed" rather than the new state.
 *
 * Sending the payload would mean two ways for the page to learn the same
 * fact, and the pushed one would be the one that goes stale after a missed
 * message. A nudge plus a re-read has exactly one path.
 */
function listen() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/engine/ws`);
  ws.onmessage = () => void load();
  ws.onclose = () => setTimeout(listen, 2000);
}

// -------------------------------------------------------------- render --

function render() {
  renderQuestions();
  renderGoals();
  renderSkills();
  renderPerception();
}

function renderQuestions() {
  const qs = state.questions ?? [];
  el("questions-section").hidden = qs.length === 0;
  qlist.replaceChildren(
    ...qs.map((q) => {
      const li = document.createElement("li");
      li.className = "qitem";

      const p = document.createElement("div");
      p.className = "qprompt";
      p.textContent = q.prompt;

      const actions = document.createElement("div");
      actions.className = "qactions";

      // Pre-filled, so the common case is one tap. A question that needs
      // typing is a form, and a form after a workout does not get answered.
      if (q.proposedValue !== null) {
        actions.append(
          button(`Yes — ${q.proposedValue}`, "btn-primary", () => answer(q.id, q.proposedValue)),
        );
      }
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "or a different value";
      input.className = "qinput";
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && input.value.trim()) answer(q.id, input.value.trim());
      });
      actions.append(input, button("No", "btn-ghost", () => answer(q.id, "0")));

      li.append(p, actions);
      return li;
    }),
  );
}

function renderGoals() {
  const goals = state.goals ?? [];
  el("glist-empty").hidden = goals.length > 0;

  glist.replaceChildren(
    ...goals.map((g) => {
      const li = document.createElement("li");
      li.className = "gitem";

      const today = (g.instances ?? [])[0];
      const head = document.createElement("div");
      head.className = "ghead";

      const title = document.createElement("div");
      title.innerHTML = `<b>${esc(g.description)}</b><span class="gkey">${esc(g.key)}</span>`;

      head.append(title, stateChip(g, today));

      const meta = document.createElement("div");
      meta.className = "gmeta";
      const win = g.windowStart ? `${g.windowStart}–${g.windowEnd}` : "any time";
      meta.textContent = `${g.cadence} · ${win} · ${g.tz}`;

      const uses = document.createElement("ul");
      uses.className = "guses";
      for (const u of g.uses ?? []) {
        const s = state.skills.find((x) => x.key === u.skillKey);
        const chip = document.createElement("li");
        chip.className = `use use-${u.role}`;
        const need = u.minCount ? ` ≥${u.minCount}` : "";
        chip.textContent = `${u.role}: ${u.skillKey}${need}`;
        chip.title = s ? s.label : "unknown skill";
        uses.append(chip);
      }

      // Fourteen days of occurrences. A streak is the only view of a goal
      // that shows whether it is actually working.
      const strip = document.createElement("div");
      strip.className = "strip";
      for (const i of [...(g.instances ?? [])].reverse()) {
        const d = document.createElement("i");
        d.className = `dot dot-${i.state}`;
        d.title = `${i.occurrenceOn}: ${i.state}${i.settledBy ? ` (${i.settledBy})` : ""}`;
        strip.append(d);
      }

      const del = button("Remove", "btn-ghost btn-sm", async () => {
        await fetch(`/api/engine/goals/${encodeURIComponent(g.key)}`, { method: "DELETE" });
        void load();
      });
      del.classList.add("gdel");

      li.append(head, meta, uses, strip, del);
      return li;
    }),
  );
}

function stateChip(goal, instance) {
  const chip = document.createElement("span");
  if (!instance) {
    chip.className = "chip chip-pending";
    chip.textContent = "no occurrence";
    return chip;
  }
  chip.className = `chip chip-${instance.state}`;
  const by = instance.settledBy ? ` · ${instance.settledBy}` : "";
  const target = instance.targetMin === null ? "" : ` ${instance.observed}/${instance.targetMin}`;
  chip.textContent =
    goal.type === "limit" && instance.state === "pending"
      ? "holding"
      : `${instance.state}${target}${by}`;
  return chip;
}

function renderSkills() {
  const skills = state.skills ?? [];
  el("slist-empty").hidden = skills.length > 0;
  slist.replaceChildren(
    ...skills.map((s) => {
      const li = document.createElement("li");
      li.className = "sitem";
      // weight_state is worth surfacing: "pending" is not broken, it means
      // perception has not embedded the label yet, and that distinction is
      // the difference between waiting and debugging.
      // The surface is shown only when it is an opinion. Marking every
      // legacy skill "any" would add a column of noise to say nothing; a
      // skill that watches screens is the one worth picking out, because a
      // screen skill paired with a camera publisher is the quiet way for a
      // goal to never advance.
      const surface =
        s.surface && s.surface !== "any"
          ? `<span class="kind kind-${esc(s.surface)}">${esc(s.surface)}</span>`
          : "";
      li.innerHTML =
        `<span class="kind kind-${esc(s.kind)}">${esc(s.kind)}</span>` +
        surface +
        `<b>${esc(s.key)}</b>` +
        `<span class="slabel">${esc(s.label)}</span>` +
        `<span class="wstate wstate-${esc(s.weightState)}">${esc(s.weightState)}</span>` +
        `<span class="shz">${s.sampleHz} Hz</span>`;
      return li;
    }),
  );
}

function renderPerception() {
  const workers = state.perception ?? [];
  el("stat-watching").textContent = String(workers.length);
  const box = el("perception");
  const banner = el("nowatch");

  if (workers.length === 0) {
    box.className = "pstatus pstatus-off";
    box.textContent = "Nothing connected.";

    // The failure this exists for: a camera publishing happily to the wall
    // while no worker is scoring its frames. Every goal stays pending, and
    // without this there is nothing on screen that says why.
    banner.hidden = false;
    banner.innerHTML =
      "<b>The watcher is offline.</b> Cameras on the wall are still publishing, " +
      "but nothing is scoring their frames, so no goal can advance. " +
      "This is a service that should be running continuously - if you are " +
      "seeing this, it needs restarting.";
    return;
  }

  banner.hidden = true;
  box.className = "pstatus pstatus-on";
  box.textContent = workers.map((w) => `${w.room} · ${w.encoderId} · ${w.dim}-d`).join("   ");

  // A room whose frames have dried up while its camera is still on the wall
  // is almost always a backgrounded publisher tab, and nothing else on this
  // page would ever say so.
  const stale = (state.rooms ?? []).filter((r) => r.secondsAgo > 20);
  if (stale.length > 0) {
    banner.hidden = false;
    banner.innerHTML =
      "<b>Frames have stopped arriving.</b> " +
      stale.map((r) => `${esc(r.room)} last sent ${Math.round(r.secondsAgo)}s ago`).join(", ") +
      ". A publisher tab that is hidden gets throttled by the browser and stops " +
      "sending, while its camera stays on the wall. Bring that tab to the front, " +
      "or publish from a phone and watch this page elsewhere.";
  }

  // A skill with no vector means perception has not embedded its label yet.
  // Brief and normal after creating a goal; permanent if the encoder failed
  // to load, which is worth distinguishing from "nothing is happening".
  const pending = (state.skills ?? []).filter((s) => s.weightState === "pending");
  if (pending.length > 0) {
    box.textContent += `   ·   embedding ${pending.length} new skill(s)`;
  }
}

// --------------------------------------------------------------- actions --

async function answer(id, value) {
  await fetch(`/api/engine/questions/${encodeURIComponent(id)}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer: String(value) }),
  });
  void load();
}

// -------------------------------------------------------------- new goal --

const dialog = el("goal-dialog");
const skillRows = el("g-skills");

el("new-goal").addEventListener("click", () => {
  if (skillRows.children.length === 0) addSkillRow();
  dialog.showModal();
});

el("g-add-skill").addEventListener("click", () => addSkillRow());

function addSkillRow(preset = {}) {
  const li = document.createElement("li");
  li.className = "skill-row";

  // Not every field the planner drafts deserves a widget. `dependsOn` is the
  // gate tree and `accumulate` is "sum this across the day", and both are
  // things the planner reasons about and a person almost never retypes - but
  // they were previously dropped on the floor here, which quietly flattened
  // every drafted parent/child pair into two unrelated skills.
  li.dataset.dependsOn = preset.dependsOn ?? "";
  li.dataset.accumulate = preset.accumulate ? "1" : "";

  const key = input("key", preset.key ?? "", "person_in_bathroom");
  const label = input("label", preset.label ?? "", "a person standing at a bathroom sink");
  const kind = select("kind", ["gate", "object", "action", "counter", "discriminator", "metric"], preset.kind ?? "object");
  const surface = select("surface", ["any", "camera", "screen"], preset.surface ?? "any");
  const role = select("role", ["gate", "required", "discriminating"], preset.role ?? "required");

  const drop = button("×", "btn-ghost btn-sm", () => li.remove());
  drop.classList.add("row-drop");

  li.append(kind, surface, key, label, role, drop);
  skillRows.append(li);
}

el("g-plan").addEventListener("click", async () => {
  const sentence = el("g-sentence").value.trim();
  const status = el("g-plan-status");
  if (!sentence) return;

  status.hidden = false;
  status.className = "status";
  status.textContent = "Planning…";

  const res = await fetch("/api/engine/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sentence, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  });

  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: `planner failed (${res.status})` }));
    status.className = "status err";
    status.textContent = `${error} — fill in the fields below instead.`;
    return;
  }

  const plan = await res.json();
  applyPlan(plan);
  status.className = "status live";
  status.textContent = `Drafted ${plan.uses.length} skills. Check them, then create.`;
});

/** Fill the manual form from a planner response, so it stays reviewable. */
function applyPlan(plan) {
  el("g-key").value = plan.key ?? "";
  el("g-desc").value = plan.description ?? "";
  el("g-cadence").value = plan.cadence ?? "daily";
  el("g-type").value = plan.type ?? "target";
  if (plan.doneMin != null) el("g-donemin").value = plan.doneMin;
  if (plan.windowStart) el("g-start").value = plan.windowStart;
  if (plan.windowEnd) el("g-end").value = plan.windowEnd;

  skillRows.replaceChildren();
  for (const u of plan.uses ?? []) addSkillRow(u);
}

el("goal-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "save") return;

  // Read by name rather than by position: the row has grown a field twice
  // now, and a positional destructure silently reassigns every value when it
  // does.
  const rows = [...skillRows.children].map((li) => {
    const at = (name) => li.querySelector(`[name="${name}"]`)?.value ?? "";
    return {
      kind: at("kind"),
      surface: at("surface"),
      key: at("key").trim(),
      label: at("label").trim(),
      role: at("role"),
      dependsOn: li.dataset.dependsOn || null,
      accumulate: li.dataset.accumulate === "1",
    };
  });

  // Skills are created before the goal that references them, because the
  // join row carries a foreign key and a goal pointing at nothing would be
  // a goal that can never settle.
  //
  // Gates go first for the same reason one level down: depends_on is itself
  // a foreign key into this table, so a child written before its parent is
  // a child whose gate chain is broken from birth.
  const writing = rows.filter((r) => r.key && r.label);
  const named = new Set(writing.map((r) => r.key));
  const ordered = [...writing].sort(
    (a, b) => (a.kind === "gate" ? -1 : 0) - (b.kind === "gate" ? -1 : 0),
  );

  for (const r of ordered) {
    await fetch("/api/engine/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: r.key,
        kind: r.kind,
        label: r.label,
        surface: r.surface,
        // Only if the parent is actually among the skills being written. A
        // dangling key would leave the child permanently ineligible, which
        // looks exactly like a detector that does not work.
        dependsOn: r.dependsOn && named.has(r.dependsOn) ? r.dependsOn : null,
      }),
    });
  }

  await fetch("/api/engine/goals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: el("g-key").value.trim(),
      description: el("g-desc").value.trim(),
      type: el("g-type").value,
      cadence: el("g-cadence").value,
      doneMin: Number(el("g-donemin").value),
      windowStart: el("g-start").value || null,
      windowEnd: el("g-end").value || null,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      uses: rows
        .filter((r) => r.key)
        .map((r) => ({
          skillKey: r.key,
          role: r.role,
          minCount: r.kind === "counter" ? 5 : null,
          // Without this an action goal settles on its first session of any
          // length, so thirty seconds of the right window being open would
          // credit a whole hour.
          accumulate: r.accumulate,
        })),
    }),
  });

  void load();
});

// -------------------------------------------------------------- helpers --

function button(text, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn ${cls}`;
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

function input(name, value, placeholder) {
  const i = document.createElement("input");
  i.type = "text";
  i.name = name;
  i.value = value;
  i.placeholder = placeholder;
  return i;
}

function select(name, options, value) {
  const s = document.createElement("select");
  s.name = name;
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = opt.textContent = o;
    s.append(opt);
  }
  s.value = value;
  return s;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

void load();
listen();
