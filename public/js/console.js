/* ===========================================================================
   The console.

   One surface. The camera and the goal are the same fact — the camera is the
   proof — so splitting them across two pages meant a full reload tore down
   every feed and neither page ever contained the product.

   Three live inputs, each failing independently:

     /api/hub/ws      what is publishing right now  -> subscribe to the video
     /api/engine/ws   the ledger changed            -> re-read state
                      live scores                   -> draw the signal

   Scores arrive over that socket but are never stored anywhere. The ledger
   keeping only transitions is the whole "7,200 scores an hour becomes one
   event" property; a live view of a number is not the same thing as a record
   of it, so the plot is fed and then forgotten.
   =========================================================================== */

import { subscribe } from "./sfu-client.js";

const $ = (id) => document.getElementById(id);

/** How many score samples the plot holds. ~25 s at 8 Hz. */
const TRACE = 200;

/**
 * How long the scores have to stop before the chart says anything about it.
 *
 * A still room is the designed state, not a fault - it is the whole reason
 * an empty room costs nothing - so the bar for calling it out has to sit
 * above a normal pause. Four seconds is the gap between two squats.
 */
const QUIET_MS = 20000;

let state = { skills: [], goals: [], questions: [], perception: [], rooms: [] };
let devices = [];
let current = null; // { device, pc }

/** skillKey -> [{ score, phase }], one series per skill scoring this camera. */
const traces = new Map();
/** null shows every series; a key narrows the chart to it and draws its band. */
let focusSkill = null;
/** Which camera's scores the chart is showing. Every camera reports its own. */
let activeRoom = null;
let lastFrameAt = 0;
let lastScoreAt = 0;
/** Which goal the hero count is following, or null for whatever leads. */
let focusGoal = null;
/**
 * Transitions already announced, by arrival time.
 *
 * Seeded to now on first paint, because a console opening on a day that
 * already happened must not replay forty of them at once.
 */
let announcedUntil = Date.now();
/** goalKey -> last seen instance state, to notice the moment one settles. */
const goalWas = new Map();

/**
 * A stable colour per skill.
 *
 * Hashed from the key rather than assigned by position, so a skill keeps its
 * colour when another is added and the chart does not reshuffle under you.
 * This is the one place hue does not carry state - a series needs identity,
 * and state stays on the chip's text and border where it always was.
 */
const SERIES = 8;
function hueOf(key) {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return "var(--s" + (h % SERIES) + ")";
}

function seriesFor(skillKey) {
  let s = traces.get(skillKey);
  if (s === undefined) traces.set(skillKey, (s = []));
  return s;
}

// ------------------------------------------------------------------ clock --

setInterval(() => {
  $("m-clock").textContent = new Date().toTimeString().slice(0, 8);
  // The live pip is a reading, not decoration: it reflects whether frames
  // actually arrived recently, not whether a socket happens to be open.
  $("pip").classList.toggle("on", Date.now() - lastFrameAt < 6000);
  // Only once the quiet has lasted long enough to be worth remarking on.
  // Four seconds was the gap between two squats, so the chart announced
  // itself broken every time someone stood up straight.
  if (Date.now() - lastScoreAt > QUIET_MS) {
    drawPlot();
    renderNotices();
  }
}, 2000);

// ------------------------------------------------------------------ toast --

/** How long a reaction stays up. Long enough to read mid-rep, not longer. */
const TOAST_MS = 4200;

/**
 * Say what just happened, where it happened.
 *
 * The count in the corner is a total, and a total cannot tell you the
 * moment. Watching your own rep land is the thing the product is for, and
 * a number quietly incrementing in the corner of a video is not that.
 */
function toast({ kind = "", lead, line, sub = "" }) {
  const host = $("toasts");
  if (host === null) return;

  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML =
    (lead ? `<b class="lead">${esc(lead)}</b>` : "") +
    `<span class="body"><span class="line">${esc(line)}</span>` +
    (sub ? `<span class="sub">${esc(sub)}</span>` : "") +
    "</span>";

  // Oldest falls off rather than letting a burst of reps bury the page.
  host.prepend(el);
  while (host.children.length > 4) host.lastElementChild?.remove();

  requestAnimationFrame(() => el.classList.add("in"));
  const go = () => {
    el.classList.remove("in");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
    // A removed transition still has to clear if the viewer is reduced-motion.
    setTimeout(() => el.remove(), 400);
  };
  const timer = setTimeout(go, TOAST_MS);
  el.addEventListener("click", () => {
    clearTimeout(timer);
    go();
  });
}

/** The goal a skill belongs to, for naming a count in human terms. */
function goalFor(skillKey) {
  return (state.goals ?? []).find((g) =>
    (g.uses ?? []).some((u) => u.skillKey === skillKey),
  );
}

function announce(list) {
  let newest = announcedUntil;
  // Oldest first, so a burst reads in the order it happened.
  for (const tr of [...list].sort((a, b) => a.at - b.at)) {
    if (tr.at <= announcedUntil) continue;
    newest = Math.max(newest, tr.at);

    const goal = goalFor(tr.skillKey);
    const inst = (goal?.instances ?? [])[0];
    const progress =
      inst && inst.targetMin ? `${fmt(inst.observed)} of ${fmt(inst.targetMin)}` : "";
    // The reaction sits on the camera being watched, so one from a different
    // camera has to say so or it reads as this camera's.
    const elsewhere =
      tr.room && activeRoom && tr.room !== activeRoom ? `${tr.room} · ` : "";

    if (tr.kind === "entered") {
      toast({
        kind: "good",
        lead: "+1",
        line: goal ? goal.description : tr.skillKey,
        sub: elsewhere + (progress || tr.skillKey),
      });
    } else if (tr.kind === "rejected") {
      // A near-miss is the most useful toast there is: it is the only one
      // that tells you to change something.
      const why =
        tr.neededConf > 0
          ? `peak ${num(tr.peak)}, needed ${num(tr.neededConf)}`
          : `held ${ms(tr.heldMs)}, needed ${ms(tr.neededMs)}`;
      toast({ kind: "near", lead: "—", line: `${tr.skillKey} nearly counted`, sub: elsewhere + why });
    } else if (tr.kind === "escalate") {
      toast({ kind: "ask", lead: "?", line: `${tr.skillKey} asked for a second opinion`, sub: elsewhere + (tr.reason ?? "") });
    }
  }
  announcedUntil = newest;
}

/** A goal crossing into done is the one moment worth more than a line. */
function announceGoals() {
  for (const g of state.goals ?? []) {
    const now = (g.instances ?? [])[0]?.state ?? "pending";
    const before = goalWas.get(g.key);
    goalWas.set(g.key, now);
    if (before === undefined || before === now) continue;
    if (now === "done") {
      toast({ kind: "done", lead: "✓", line: g.description, sub: "settled by camera" });
    } else if (now === "violated") {
      toast({ kind: "bad", lead: "!", line: g.description, sub: "limit broken" });
    }
  }
}

// ------------------------------------------------------------------ state --

/** Set once a read has actually succeeded, so [] can be trusted as empty. */
let loaded = false;

async function load() {
  const res = await fetch("/api/engine/state");
  if (!res.ok) return;
  state = await res.json();
  loaded = true;
  renderAll();
}

function renderAll() {
  pruneTraces();
  announceGoals();
  renderGoals();
  renderSkills();
  renderQuestions();
  renderMeta();
  renderNotices();
  renderTally();
}

/**
 * Drop the series of skills that no longer exist.
 *
 * Deleting a goal takes its unshared skills with it, and perception stops
 * reporting them - but a series already in hand would keep drawing its last
 * few seconds forever, because nothing arriving is not the same as something
 * saying stop.
 */
function pruneTraces() {
  // Only once a read has succeeded. An empty list before the first one is
  // the module's own initial value and means nothing; after one it means
  // the registry is empty, and refusing to act on that is what left deleted
  // skills drawing curves of their own. A failed read never reaches here -
  // load() returns before it assigns - so there is no third case.
  if (!loaded) return;
  const live = new Set((state.skills ?? []).map((s) => s.key));
  for (const key of [...traces.keys()]) if (!live.has(key)) traces.delete(key);
  if (focusSkill !== null && !live.has(focusSkill)) focusSkill = null;
  drawPlot();
}

let scoresSeen = 0;
let eventsSeen = 0;

/**
 * The ratio in the chrome.
 *
 * Thousands of scores becoming a handful of events is the whole argument
 * for the architecture, and until now it was a number only the logs knew.
 */
function renderMeta() {
  const p = state.perception?.[0];
  $("m-encoder").textContent = p ? p.encoderId : "no watcher";
  $("m-cameras").textContent = String(devices.length);
  $("m-scores").textContent = scoresSeen.toLocaleString();
  $("m-events").textContent = String(eventsSeen);
}

/**
 * Only the two failures that look healthy from everywhere else.
 *
 * A camera publishes over its own socket, so it stays on the wall whether or
 * not anything is scoring its frames — which means every other indicator can
 * read fine while nothing at all is happening.
 */
let noticeShown = false;

function renderNotices() {
  const box = $("notices");
  box.replaceChildren();
  noticeShown = false;

  // Liveness comes from scores arriving, not from the last snapshot. The
  // watcher's socket drops and reconnects in under two seconds on any
  // deploy, and a banner driven by a snapshot latches on that blip and then
  // sits there calling a working watcher offline.
  const scoring = Date.now() - lastScoreAt < 15000;
  if (scoring || (state.perception ?? []).length > 0) return;

  noticeShown = true;
  box.append(
    notice(
      "bad",
      "The watcher is offline",
      "Cameras can still publish, but nothing is scoring their frames, so no goal can advance.",
    ),
  );
}

function notice(kind, title, body) {
  const el = document.createElement("div");
  el.className = `notice ${kind}`;
  el.innerHTML = `<div><b>${esc(title)}</b><span>${esc(body)}</span></div>`;
  return el;
}

// ------------------------------------------------------------------ goals --

function renderGoals() {
  const goals = state.goals ?? [];
  const host = $("goals");
  if (goals.length === 0) {
    host.replaceChildren(
      Object.assign(document.createElement("div"), {
        className: "empty",
        textContent:
          "No goals yet. A goal is a sentence plus the things a camera would have to see for it to be true.",
      }),
    );
    return;
  }

  host.replaceChildren(
    ...goals.map((g) => {
      const today = (g.instances ?? [])[0];
      const el = document.createElement("div");
      el.className = `goal is-${today?.state ?? "pending"}${focusGoal === g.key ? " on" : ""}`;

      const pct =
        today && today.targetMin
          ? Math.min(100, (today.observed / today.targetMin) * 100)
          : today?.state === "done"
            ? 100
            : 0;

      const win = g.windowStart ? `${g.windowStart}–${g.windowEnd}` : "any time";
      const obs = today ? `${fmt(today.observed)}${today.targetMin ? ` / ${fmt(today.targetMin)}` : ""}` : "—";

      el.innerHTML = `
        <div class="goal-top">
          <span class="name">${esc(g.description)}</span>
          <span class="chip ${chipFor(g, today)}">${esc(stateLabel(g, today))}</span>
          <button class="kill" type="button" title="Delete this goal">×</button>
        </div>
        <div class="goal-meta">${esc(g.cadence)} · ${esc(win)} · <span class="mono">${esc(obs)}</span></div>
        <div class="prog"><i style="width:${pct}%"></i></div>
        <div class="uses"></div>
        <div class="streak"></div>`;

      const uses = el.querySelector(".uses");
      for (const u of g.uses ?? []) {
        const c = document.createElement("span");
        c.className = "chip";
        const step = u.sequenceIndex == null ? "" : `${stepOrder(g, u.sequenceIndex)}. `;
        c.textContent =
          `${step}${u.role}: ${u.skillKey}${u.minCount ? ` ≥${u.minCount}` : ""}`;
        // A step the goal is waiting on is the single most useful thing on
        // this card: it says what to do next rather than that nothing
        // happened.
        if (u.sequenceIndex != null && u.sequenceIndex === g.waitingOn) {
          c.classList.add("waiting");
          c.title = "waiting on this step";
        }
        const s = state.skills.find((x) => x.key === u.skillKey);
        if (s) c.title = s.label;
        uses.append(c);
      }

      // Two presses, not a modal. Deleting a goal takes its history with
      // it, so it should not happen on one stray click - but a dialog for
      // every small destructive act trains people to dismiss dialogs.
      const kill = el.querySelector(".kill");
      kill.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (kill.dataset.armed !== "1") {
          kill.dataset.armed = "1";
          kill.textContent = "delete?";
          kill.classList.add("armed");
          setTimeout(() => {
            kill.dataset.armed = "";
            kill.textContent = "×";
            kill.classList.remove("armed");
          }, 3000);
          return;
        }
        kill.textContent = "…";
        // Each segment encoded, the slashes left alone: a key is namespaced
        // and the separators are part of the path, but anything else in it
        // is data and has to survive the trip.
        const addr = g.key.split("/").map(encodeURIComponent).join("/");
        const res = await fetch(`/api/engine/goals/${addr}`, { method: "DELETE" });
        if (!res.ok) {
          // It used to report success whatever came back, so a goal with a
          // key no route could match simply stayed, silently.
          kill.textContent = "×";
          kill.dataset.armed = "";
          kill.classList.remove("armed");
          toast({
            kind: "bad",
            lead: "!",
            line: `Could not delete ${g.description}`,
            sub: `the engine answered ${res.status}`,
          });
          return;
        }
        const { removedSkills = [] } = await res.json().catch(() => ({}));
        if (focusGoal === g.key) focusGoal = null;
        goalWas.delete(g.key);
        // Say what else went. A skill vanishing from the list with no
        // explanation reads as a bug rather than as the tidy-up it is.
        toast({
          kind: "bad",
          lead: "×",
          line: `Deleted ${g.description}`,
          sub: removedSkills.length
            ? `with ${removedSkills.length} skill${removedSkills.length > 1 ? "s" : ""} nothing else used`
            : "its skills are still used elsewhere",
        });
        void load();
      });

      // Fourteen days. A faint cell for a day with nothing, never an empty
      // hole: absence should read as texture rather than a broken chain.
      const streak = el.querySelector(".streak");
      for (const i of [...(g.instances ?? [])].reverse().slice(-14)) {
        const d = document.createElement("i");
        d.className = i.state;
        d.title = `${i.occurrenceOn}: ${i.state}${i.settledBy ? ` · settled by ${i.settledBy}` : ""}`;
        streak.append(d);
      }

      // Clicking a goal focuses its counter skill, which swaps what the hero
      // and the plot are showing rather than navigating anywhere.
      el.addEventListener("click", () => {
        const counter = (g.uses ?? []).find((u) => {
          const s = state.skills.find((x) => x.key === u.skillKey);
          return s && (s.kind === "counter" || s.kind === "action");
        });
        focusSkill = counter?.skillKey ?? null;
        focusGoal = focusGoal === g.key ? null : g.key;
        drawPlot();
        renderGoals();
        renderTally();
      });

      return el;
    }),
  );
}

function stateLabel(goal, instance) {
  if (!instance) return "no occurrence";
  if (goal.type === "limit" && instance.state === "pending") return "holding";
  return instance.state;
}

function chipFor(goal, instance) {
  if (!instance) return "";
  if (instance.state === "done") return "proved";
  if (instance.state === "violated") return "bad";
  if (instance.state === "active") return "watching";
  return "";
}

// ----------------------------------------------------------------- skills --

/**
 * Order the skills into the tree they actually form.
 *
 * `depends_on` is a real gate chain in the Engine - a skill is eligible only
 * while its parent is open - and drawing the column flat hid the one
 * structural fact worth seeing: which skills are cheap because they spend
 * most of their life asleep.
 *
 * Two things this has to survive, because the column renders whatever the
 * Engine sent rather than a shape anything validated:
 *
 *   A parent that is not in the list. A room filter can orphan a child, and a
 *   child that silently vanished would read as a missing skill. Orphans are
 *   drawn at the root instead.
 *
 *   A cycle. `depends_on` is self-referencing, so one bad row could point at
 *   an ancestor and spin this forever. The seen-set costs nothing and turns a
 *   hung tab into a flat list.
 */
function skillTree(skills) {
  const byKey = new Map(skills.map((s) => [s.key, s]));
  const kids = new Map();
  const roots = [];

  for (const s of skills) {
    const parent = s.dependsOn && byKey.has(s.dependsOn) ? s.dependsOn : null;
    if (parent === null) roots.push(s);
    else kids.set(parent, [...(kids.get(parent) ?? []), s]);
  }

  const out = [];
  const seen = new Set();
  const walk = (s, depth) => {
    if (seen.has(s.key)) return;
    seen.add(s.key);
    out.push({ skill: s, depth });
    for (const k of kids.get(s.key) ?? []) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  for (const s of skills) if (!seen.has(s.key)) out.push({ skill: s, depth: 0 });
  return out;
}

function renderSkills() {
  const host = $("skills");
  if ((state.skills ?? []).length === 0) {
    host.replaceChildren(
      Object.assign(document.createElement("div"), {
        className: "empty",
        textContent: "No skills. Skills arrive with the goals that need them.",
      }),
    );
    return;
  }
  host.replaceChildren(
    ...skillTree(state.skills ?? []).map(({ skill: s, depth }) => {
      const el = document.createElement("div");
      el.className = "skill";
      el.style.setProperty("--depth", String(depth));
      if (depth > 0) el.dataset.child = "1";
      // `pending` is not broken — it means perception has not embedded the
      // label yet, and conflating the two sends people debugging a wait.
      const w =
        s.weightState === "fitted" ? "proved" : s.weightState === "zeroshot" ? "" : "pending";
      el.innerHTML = `
        <span class="kind">${esc(s.kind)}</span>
        <span style="min-width:0">
          <span class="key">${esc(s.key)}</span><br>
          <span class="label">${esc(s.label)}</span>
        </span>
        <span style="display:flex; gap:6px; align-items:center">
          <span class="chip ${w}">${esc(s.weightState)}</span>
          <span class="chip">${s.sampleHz} Hz</span>
        </span>`;
      return el;
    }),
  );
}

// -------------------------------------------------------------- questions --

function renderQuestions() {
  const qs = state.questions ?? [];
  $("q-card").hidden = qs.length === 0;
  $("questions").replaceChildren(
    ...qs.map((q) => {
      const el = document.createElement("div");
      el.className = "q-item";
      el.innerHTML = `<div class="q-prompt">${esc(q.prompt)}</div><div class="q-acts"></div>`;
      const acts = el.querySelector(".q-acts");
      if (q.proposedValue !== null) {
        acts.append(btn(`Yes — ${q.proposedValue}`, "primary", () => answer(q.id, q.proposedValue)));
      }
      acts.append(btn("No", "ghost", () => answer(q.id, "0")));
      return el;
    }),
  );
}

async function answer(id, value) {
  await fetch(`/api/engine/questions/${encodeURIComponent(id)}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer: String(value) }),
  });
  void load();
}

// ------------------------------------------------------------------ tally --

function renderTally() {
  const goals = state.goals ?? [];
  // Show whatever is furthest along today; a page opening on zeroes shows
  // nothing about what the product does.
  // Whichever goal you last pressed, else whatever is furthest along. The
  // hero used to always pick the leader, which made one goal look like the
  // only one there was however many you had.
  const rows = goals.map((g) => ({ g, i: (g.instances ?? [])[0] })).filter((x) => x.i);
  const best =
    rows.find((x) => x.g.key === focusGoal) ??
    rows.sort((a, b) => (b.i.observed ?? 0) - (a.i.observed ?? 0))[0] ??
    null;

  if (!best) return;
  const { g, i } = best;
  // The count reacting to its own change, so an increment is something you
  // see happen rather than something you notice later.
  const n = $("tally-n");
  const next = fmt(i.observed);
  if (n.textContent !== next && n.textContent !== "0" && n.textContent !== "") {
    n.classList.remove("bump");
    void n.offsetWidth;
    n.classList.add("bump");
  }
  n.textContent = next;
  $("tally-sub").textContent = i.targetMin
    ? `of ${fmt(i.targetMin)}${i.settledBy ? ` · proved by ${i.settledBy}` : ""}`
    : i.state;
  $("tally-what").textContent = g.description;
  $("r-count").textContent = fmt(i.observed);
}

// ----------------------------------------------------------------- events --

function renderEvents(list) {
  const host = $("events");
  eventsSeen = list.length;
  renderMeta();
  announce(list);
  if (list.length === 0) return;
  host.replaceChildren(
    ...list.slice(0, 40).map((t) => {
      const el = document.createElement("div");
      const missed = t.kind === "rejected";
      el.className = `ev${missed ? " miss" : ""}`;

      let body;
      if (missed) {
        // The failing term, named. Which number fell short decides whether
        // you shorten the dwell or lower the threshold, and they are
        // opposite fixes.
        const term =
          t.neededConf > 0
            ? `peak ${num(t.peak)} · needed ${num(t.neededConf)} at dwell`
            : `held ${ms(t.heldMs)} · needed ${ms(t.neededMs)}`;
        body = `<span class="chip pending">near-miss</span> ${esc(t.skillKey)}
                <span class="q">${esc(term)} — ${esc(t.reason)}</span>`;
      } else if (t.kind === "entered") {
        body = `<span class="chip proved">counted</span> ${esc(t.skillKey)}
                <span class="q">score ${num(t.score)}${t.peak ? ` · peak ${num(t.peak)}` : ""}${t.verdictBy === "vlm" ? " · confirmed by Nemotron VL" : ""}</span>`;
      } else if (t.kind === "exited") {
        body = `<span class="chip">session closed</span> ${esc(t.skillKey)}
                <span class="q">${ms(t.durationMs)}</span>`;
      } else {
        body = `<span class="chip watching">escalated</span> ${esc(t.skillKey)}
                <span class="q">${esc(t.reason)}</span>`;
      }

      el.innerHTML = `<span class="t">${time(t.at)}</span><span class="b">${body}</span>`;
      return el;
    }),
  );
  $("ev-note").textContent = `${list.length} today`;
}

// ----------------------------------------------------------------- signal --

/**
 * The score curve with both thresholds drawn.
 *
 * Two lines rather than one is the entire reason a two-minute action
 * produces one event and not forty, so the band between them is drawn as a
 * fill: it is the part of the picture that explains the behaviour.
 */
/*
 * The chart is built once and then only moved.
 *
 * It used to rebuild its own innerHTML on every scores message: four times a
 * second, five series, two hundred points each - four thousand coordinates
 * formatted into a string, parsed, and laid out, per second, on the same
 * main thread that is decoding the video next to it. That is the delay that
 * grows the longer it runs, because it competes with everything else for a
 * budget that gets smaller as the machine warms up.
 *
 * Structure changes only when the SET of series changes. A new sample moves
 * the points of a polyline that is already there.
 */

/** What is currently in the DOM, so a redraw can tell if it still fits. */
let plotShape = "";
const plotNodes = new Map();
const SVG_NS = "http://www.w3.org/2000/svg";

const W = 600;
const H = 150;
const yOf = (v) => H - 12 - v * (H - 26);

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function shownSeries() {
  return [...traces.entries()].filter(
    ([key, pts]) => pts.length > 1 && (focusSkill === null || key === focusSkill),
  );
}

function rebuildPlot(shown) {
  const host = $("plot");
  host.replaceChildren();
  plotNodes.clear();

  if (shown.length === 0) {
    host.append(
      Object.assign(
        svg("text", { class: "plot-wait", x: W / 2, y: H / 2, "text-anchor": "middle" }),
        { textContent: quietBecause() },
      ),
    );
    return;
  }

  // An enter/exit band belongs to one skill. Six of them stacked would be six
  // overlapping rectangles and no readable threshold, so it appears only once
  // the chart has been narrowed to a single series.
  const focus = focusSkill ? state.skills.find((s) => s.key === focusSkill) : null;
  if (focus) {
    const enter = focus.enterConf ?? 0.75;
    const exit = focus.exitConf ?? 0.45;
    host.append(
      svg("rect", {
        class: "plot-band",
        x: 42,
        y: yOf(enter),
        width: W - 50,
        height: Math.max(0, yOf(exit) - yOf(enter)),
      }),
      svg("line", { class: "plot-enter", x1: 42, y1: yOf(enter), x2: W - 8, y2: yOf(enter), "stroke-width": 1, "stroke-dasharray": "3 3" }),
      svg("line", { class: "plot-exit", x1: 42, y1: yOf(exit), x2: W - 8, y2: yOf(exit), "stroke-width": 1, "stroke-dasharray": "3 3" }),
      Object.assign(svg("text", { class: "plot-lbl enter", x: 0, y: yOf(enter) + 3 }), {
        textContent: num(enter),
      }),
      Object.assign(svg("text", { class: "plot-lbl", x: 0, y: yOf(exit) + 3 }), {
        textContent: num(exit),
      }),
    );
  }

  for (const [key] of shown) {
    const stroke = hueOf(key);
    const curve = svg("polyline", {
      class: `plot-curve${focusSkill === key ? " lead" : ""}`,
      points: "",
      style: `stroke:${stroke}`,
    });
    const head = svg("circle", { class: "plot-head", r: 3, cx: 0, cy: 0, style: `fill:${stroke}` });
    host.append(curve, head);
    plotNodes.set(key, { curve, head });
  }
}

function drawPlot() {
  const shown = shownSeries();
  const shape = `${focusSkill}|${shown.map(([k]) => k).join(",")}`;
  if (shape !== plotShape) {
    plotShape = shape;
    rebuildPlot(shown);
  }
  if (shown.length === 0) {
    // The reason can change while the shape does not - a gate shutting does
    // not add or remove a series.
    const label = $("plot").firstElementChild;
    if (label) label.textContent = quietBecause();
    return;
  }

  const step = (W - 50) / Math.max(TRACE - 1, 1);
  for (const [key, pts] of shown) {
    const node = plotNodes.get(key);
    if (node === undefined) continue;
    let d = "";
    for (let i = 0; i < pts.length; i += 1) d += `${42 + i * step},${yOf(pts[i].score)} `;
    node.curve.setAttribute("points", d);
    const last = pts[pts.length - 1];
    node.head.setAttribute("cx", String(42 + (pts.length - 1) * step));
    node.head.setAttribute("cy", String(yOf(last.score)));
  }
}

/**
 * One redraw per frame, however many samples arrive.
 *
 * Drawing straight from the socket handler puts layout work in the middle of
 * whatever the browser was doing; a frame callback lands it on a boundary,
 * and a burst of messages collapses into one.
 */
let plotQueued = false;
function requestPlot() {
  if (plotQueued) return;
  plotQueued = true;
  requestAnimationFrame(() => {
    plotQueued = false;
    drawPlot();
  });
}

/**
 * Why the chart is empty, said accurately.
 *
 * It used to say "waiting for a watcher to report scores" for every empty
 * state, including the commonest one by far: a working watcher, a publishing
 * camera, and a room with nobody in it. The motion gate returns before the
 * encoder when nothing has moved, so a still room produces no scores at all
 * - that is the whole reason an empty room costs nothing. Reporting it as a
 * missing watcher sends you to check the one thing that was never wrong.
 */
function quietBecause() {
  if ((state.perception ?? []).length === 0) return "no watcher is connected";
  if (devices.length === 0) return "no camera is publishing";
  if (lastScoreAt === 0) return "waiting for the first frame";
  if (Date.now() - lastScoreAt <= QUIET_MS) return "warming up";

  // A watcher that has never reported on this room is not watching it, which
  // looks exactly like a still room from here and wants the opposite fix.
  // Saying "nothing is moving" when a subscription is delivering nothing
  // sends you to stand in front of a camera that was never being read.
  const seen = (state.watching ?? []).find((w) => w.room === activeRoom);
  if (activeRoom !== null && seen === undefined) {
    return "the watcher is not receiving this camera — it may still be connecting";
  }
  if (seen !== undefined && seen.secondsAgo > 30) {
    return `nothing from this camera for ${Math.round(seen.secondsAgo)}s — check it is still sharing`;
  }
  const idle = Math.round((Date.now() - lastScoreAt) / 1000);
  // The motion gate does not apply to a screen - perception exempts it,
  // because a desktop is legitimately motionless for minutes at a time and
  // a still screen is still worth reading. So on a screen this cannot be
  // the gate, and saying it is sends you looking for movement that was
  // never the requirement.
  if (current?.device?.kind === "screen") {
    return `no scores for ${idle}s — a screen is never gated, so this is the feed, not stillness`;
  }
  return `still for ${idle}s — the gate skips a motionless room, so it costs nothing`;
}


function pushScore(skillKey, score, phase) {
  // Refuse to start a series for something the registry no longer lists,
  // or a deletion grows a fresh curve from the next frame in flight.
  if (loaded && !(state.skills ?? []).some((s) => s.key === skillKey)) return;
  const s = seriesFor(skillKey);
  s.push({ score, phase });
  if (s.length > TRACE) s.shift();

  // The readout follows the focused series, or the loudest one when the
  // chart is showing everything - a readout averaging six skills is a
  // number describing nothing.
  const lead = focusSkill ?? loudest();
  if (skillKey !== lead) return;
  const pts = traces.get(lead) ?? [];
  $("r-score").textContent = num(score);
  $("r-peak").textContent = num(Math.max(...pts.map((pt) => pt.score)));
}

/** The series currently reading highest, so the readout tracks the action. */
function loudest() {
  let best = null;
  let top = -1;
  for (const [key, pts] of traces) {
    const v = pts.length ? pts[pts.length - 1].score : -1;
    if (v > top) {
      top = v;
      best = key;
    }
  }
  return best;
}

// ----------------------------------------------------------------- probes --

/**
 * The legend, which is also the filter.
 *
 * These used to float over the camera, where four of them covered the lower
 * third of the frame and the thing being measured sat behind the
 * measurements. Down here each carries its series colour, so reading the
 * chart needs no key, and clicking narrows the chart to that one skill.
 */
/** Live legend entries, so a value change does not rebuild the control. */
const legendNodes = new Map();
let legendShape = "";

/**
 * The legend, which is also the filter.
 *
 * These used to float over the camera, where four of them covered the lower
 * third of the frame and the thing being measured sat behind the
 * measurements. Down here each carries its series colour, so reading the
 * chart needs no key, and clicking narrows the chart to that one skill.
 *
 * Rebuilt only when the set of skills changes. Recreating five buttons and
 * five closures four times a second was twenty nodes a second thrown away,
 * and it made clicking one a race against its own replacement.
 */
function renderLegend(scores) {
  const host = $("legend");
  if (host === null) return;
  // A deleted skill can still arrive in one last scores message, because
  // perception is told by a registry push that races the frame it is
  // already scoring. The registry is the authority on what exists.
  const live = loaded ? new Set((state.skills ?? []).map((s) => s.key)) : null;
  const keys = Object.keys(scores)
    .filter((k) => live === null || live.has(k))
    .sort();

  const shape = keys.join(",");
  if (shape !== legendShape) {
    legendShape = shape;
    legendNodes.clear();
    host.replaceChildren(
      ...keys.map((key) => {
        const el = document.createElement("button");
        el.type = "button";
        el.title = state.skills.find((x) => x.key === key)?.label ?? key;
        const dot = document.createElement("i");
        dot.style.background = hueOf(key);
        const name = document.createElement("span");
        name.className = "k";
        name.textContent = key;
        const value = document.createElement("span");
        value.className = "v";
        el.append(dot, name, value);
        // Clicking the focused one clears the filter, so there is always a
        // way back to the whole picture without hunting for a reset control.
        el.addEventListener("click", () => {
          focusSkill = focusSkill === key ? null : key;
          syncLegend(scores);
          drawPlot();
        });
        legendNodes.set(key, { el, value });
        return el;
      }),
    );
  }
  syncLegend(scores);

  const hit = keys.some((k) => scores[k].phase === "active");
  const box = document.querySelector(".bbox");
  if (box) box.classList.toggle("hit", hit);
}

/** Text and state only. Touching nothing that holds a listener. */
function syncLegend(scores) {
  for (const [key, node] of legendNodes) {
    const s = scores[key];
    if (s === undefined) continue;
    const next = num(s.score);
    if (node.value.textContent !== next) node.value.textContent = next;
    const cls = `sig is-${s.phase ?? "idle"}${focusSkill === key ? " on" : ""}`;
    if (node.el.className !== cls) {
      node.el.className = cls;
      node.el.setAttribute("aria-pressed", String(focusSkill === key));
    }
  }
}

// ------------------------------------------------------------------ video --

/**
 * One pill per camera on the wall, plus a way to add another.
 *
 * Every camera runs the whole skill set against its own frames, with its own
 * motion gate and its own calibration fitted from its own background - so
 * this strip chooses what to look at, not what is running. Hidden entirely
 * when there is nothing to choose between.
 */
function renderCams() {
  const host = $("cams");
  if (host === null) return;
  host.replaceChildren();
  host.hidden = devices.length === 0;
  if (devices.length === 0) return;

  for (const d of devices) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "cam" + (current?.device?.id === d.id ? " on" : "");
    el.setAttribute("aria-pressed", String(current?.device?.id === d.id));
    el.innerHTML = '<i></i><span>' + esc(d.name) + "</span>";
    el.addEventListener("click", () => void showCamera(d));
    host.append(el);
  }

  const add = document.createElement("button");
  add.type = "button";
  add.className = "cam add";
  add.textContent = "+ Add";
  add.addEventListener("click", () => $("add-camera").click());
  host.append(add);
}

async function showCamera(device) {
  if (current?.device?.id === device.id) return;
  teardown();
  try {
    const { pc, stream } = await subscribe(device);
    current = { device, pc };
    // Scores are per camera, so switching has to drop the old camera's
    // series rather than draw two rooms onto one pair of axes.
    activeRoom = device.room ?? null;
    traces.clear();
    focusSkill = null;
    $("feed").srcObject = stream;
    $("stage-empty").hidden = true;
    $("hud").hidden = false;
    $("cam-name").textContent = device.name;
    $("cam-meta").textContent = `${device.kind} · ${device.trackNames.length} track`;
    renderCams();
    drawPlot();
  } catch {
    // A feed that will not connect should not blank the page; the goal data
    // beside it is still true.
    $("stage-empty").hidden = false;
    renderCams();
  }
}

function teardown() {
  current?.pc?.close();
  current = null;
  $("feed").srcObject = null;
}

// --------------------------------------------------------------- speaking --

/**
 * Voice, in and out.
 *
 * Recognition runs in this browser and only the transcript travels, which is
 * the same bargain the motion gate and the encoder make: do the work where
 * the data already is, and send only what it meant. Audio never leaves the
 * device, which is also the only honest answer to what a microphone in your
 * front room is doing.
 */
const Speech = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition ?? null;
let listener = null;
/** The button's state: whether the user wants it listening at all. */
let listening = false;
/** Whether it is listening right now, which is false while it talks. */
let deaf = false;
/** What it last said, and when it stopped saying it. */
let lastSpoken = "";
let spokeUntil = 0;

/**
 * A room microphone hears the speaker in the same room.
 *
 * Left running, the assistant transcribes its own reply, treats it as a new
 * question, answers that, and hears itself again. The recogniser is stopped
 * for as long as it is thinking or talking - there is nothing worth hearing
 * in that window anyway, because the person is listening.
 */
function deafen() {
  deaf = true;
  try {
    listener?.stop();
  } catch {
    // Already stopped; the onend handler will not restart while deaf.
  }
}

function undeafen() {
  deaf = false;
  if (!listening || listener === null) return;
  try {
    listener.start();
  } catch {
    // Already running, which is the harmless half of this race.
  }
}

/**
 * Did we just say this?
 *
 * Belt and braces for the moment between the speaker finishing and the
 * recogniser being told to listen again, where a reverberant room can still
 * deliver the tail of our own sentence.
 */
function isOwnEcho(text) {
  if (Date.now() - spokeUntil > 1500) return false;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const said = norm(lastSpoken);
  const got = norm(text);
  return got.length > 0 && (said.includes(got) || got.includes(said.slice(0, 40)));
}

function setAiState(text, thinking = false) {
  $("ai-state").textContent = text;
  $("ai").classList.toggle("thinking", thinking);
}

function showExchange(heard, say, ui = {}) {
  const h = $("ai-heard");
  h.hidden = !heard;
  if (heard) h.textContent = heard;
  $("ai-said").textContent = say;
  $("ai").dataset.tone = ui.tone ?? "calm";
  applyUi(ui);
}

/**
 * The page rearranging itself around what was just said.
 *
 * Only ever moves attention - focus a goal, narrow the chart, hold a line.
 * Nothing the assistant says can change what the ledger recorded, so the
 * worst this can do is look at the wrong thing.
 */
function applyUi(ui) {
  if (ui.focusGoal) {
    focusGoal = ui.focusGoal;
    renderGoals();
    renderTally();
  }
  if (ui.focusSkill && traces.has(ui.focusSkill)) {
    focusSkill = ui.focusSkill;
    drawPlot();
  }
  if (ui.banner) $("ai-said").textContent = ui.banner;
}

function speak(text) {
  const synth = globalThis.speechSynthesis;
  if (!synth || !text) return;
  synth.cancel();
  lastSpoken = text;
  deafen();

  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.04;
  u.pitch = 1;

  const done = () => {
    spokeUntil = Date.now();
    // A short wait before listening again: a speaker does not stop dead, and
    // the first thing a mic hears after it is the end of our own sentence
    // coming back off the walls.
    setTimeout(undeafen, 450);
  };
  u.onend = done;
  u.onerror = done;
  // Some browsers never fire onend. Falling back on a length estimate is
  // worse than a real event and far better than staying deaf forever.
  setTimeout(done, 1200 + text.length * 70);

  synth.speak(u);
}

async function ask(text, { aloud = true } = {}) {
  if (!text.trim()) return;
  showExchange(text, "…");
  setAiState("thinking", true);
  try {
    const res = await fetch("/api/engine/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, room: activeRoom }),
    });
    const { say = "I lost that one.", ui = {} } = await res.json().catch(() => ({}));
    showExchange(text, say, ui);
    if (aloud && say) speak(say);
    else undeafen();
  } catch {
    showExchange(text, "I could not reach the engine.");
    undeafen();
  } finally {
    setAiState(listening ? "listening" : "idle", false);
  }
}

function startListening() {
  if (!Speech || listening) return;
  listener = new Speech();
  listener.lang = "en-US";
  listener.interimResults = true;
  listener.continuous = false;

  listener.onresult = (e) => {
    const last = e.results[e.results.length - 1];
    const text = last[0].transcript.trim();
    if (deaf || isOwnEcho(text)) return;
    // Interim results stream into the "you" line, so the band reacts while
    // you are still talking rather than after you stop.
    $("ai-heard").hidden = false;
    $("ai-heard").textContent = text;
    if (last.isFinal) {
      // Deaf from the moment there is something to answer: thinking and
      // speaking are both windows where the only voice is ours.
      deafen();
      void ask(text);
    }
  };
  listener.onerror = (e) => {
    // "no-speech" and "aborted" are what a quiet room and our own stop()
    // produce. Neither is a reason to turn the microphone off.
    if (e.error === "no-speech" || e.error === "aborted") return;
    stopListening();
  };
  listener.onend = () => {
    // Chrome ends a non-continuous session on every pause. Restart while the
    // button is still pressed, or one sentence is all you ever get - but not
    // while we are talking, which is the whole point.
    if (listening && !deaf) {
      try {
        listener.start();
      } catch {
        stopListening();
      }
    }
  };

  listening = true;
  $("mic").setAttribute("aria-pressed", "true");
  setAiState("listening");
  try {
    listener.start();
  } catch {
    stopListening();
  }
}

function stopListening() {
  listening = false;
  deaf = false;
  $("mic").setAttribute("aria-pressed", "false");
  setAiState("idle");
  try {
    listener?.stop();
  } catch {
    // Already stopped; nothing to undo.
  }
  listener = null;
}

if (Speech === null) {
  $("mic").disabled = true;
  $("mic").title = "This browser has no speech recognition. Chrome does.";
} else {
  $("mic").addEventListener("click", () => (listening ? stopListening() : startListening()));
}

// ---------------------------------------------------------------- sockets --

function hubSocket() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/hub/ws`);

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "state") devices = msg.devices;
    else if (msg.type === "up") devices = [...devices.filter((d) => d.id !== msg.device.id), msg.device];
    else if (msg.type === "down") devices = devices.filter((d) => d.id !== msg.id);
    else return;

    renderMeta();
    if (devices.length === 0) {
      teardown();
      $("stage-empty").hidden = false;
      $("hud").hidden = true;
      renderCams();
    } else if (!current || !devices.some((d) => d.id === current.device.id)) {
      void showCamera(devices[0]);
    } else {
      renderCams();
    }
  };
  ws.onclose = () => setTimeout(hubSocket, 2500);
}

function engineSocket() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/engine/ws`);

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "changed") {
      void load();
      if (msg.events) renderEvents(msg.events);
    } else if (msg.type === "scores") {
      lastFrameAt = Date.now();
      lastScoreAt = Date.now();
      scoresSeen += Object.keys(msg.scores ?? {}).length;
      renderMeta();
      // Every camera reports its own scores on this one socket, so a frame
      // from the camera you are not watching must not move this chart.
      if (activeRoom !== null && msg.room !== activeRoom) return;
      $("r-rate").textContent = msg.hz ? `${msg.hz} Hz` : "—";
      $("r-rate").title = "frames per second this camera is being sampled at";
      for (const [key, s] of Object.entries(msg.scores ?? {})) pushScore(key, s.score, s.phase);
      requestPlot();
      renderLegend(msg.scores ?? {});
      // Notices answer "is anything scoring", which a score arriving already
      // settled. Rebuilding that four times a second said nothing new.
      if (noticeShown) renderNotices();
    } else if (msg.type === "assistant") {
      // Another surface spoke - the phone in the room, or a reminder firing
      // on the alarm. Every console shows the same exchange, but only the
      // one that asked says it out loud, or a turn is spoken twice.
      showExchange(msg.heard ?? "", msg.say ?? "", msg.ui ?? {});
      // Unprompted, and a camera is publishing: that device is in the room
      // and says it. A nudge about the bathroom is no use on a laptop in
      // another room, and two surfaces saying it is worse than one.
      if (!msg.heard && devices.length === 0) speak(msg.say ?? "");
    } else if (msg.type === "events") {
      renderEvents(msg.events ?? []);
    }
  };
  ws.onclose = () => setTimeout(engineSocket, 2500);
}

// ------------------------------------------------------------- pairing --

const claim = $("claim-dialog");

$("add-camera").addEventListener("click", async () => {
  const url = $("claim-url");
  url.value = "minting a code…";
  $("claim-qr").replaceChildren();
  claim.showModal();

  let code;
  try {
    const res = await fetch("/api/hub/claim", { method: "POST" });
    if (!res.ok) throw new Error(String(res.status));
    ({ code } = await res.json());
  } catch {
    url.value = "Could not reach the hub. Close this and try again.";
    return;
  }

  const link = `${location.origin}/join?c=${code}`;
  url.value = link;
  // The QR library is the only external script on the page, and if the CDN
  // is blocked the link alone still pairs a device.
  if (typeof QRCode === "function") {
    new QRCode($("claim-qr"), { text: link, width: 168, height: 168, correctLevel: QRCode.CorrectLevel.M });
  } else {
    $("claim-qr").textContent = "Open the link below on the device instead.";
  }
});

$("claim-copy").addEventListener("click", async (e) => {
  try {
    await navigator.clipboard.writeText($("claim-url").value);
    e.target.textContent = "Copied";
    setTimeout(() => (e.target.textContent = "Copy link"), 1400);
  } catch {
    // Clipboard is permission-gated; the field is selectable regardless.
    $("claim-url").select();
  }
});

// ------------------------------------------------------------- new goal --

const dialog = $("goal-dialog");
const rows = $("g-skills");

$("new-goal").addEventListener("click", () => {
  if (rows.children.length === 0) addRow();
  dialog.showModal();
});
$("g-add").addEventListener("click", () => addRow());

function addRow(preset = {}) {
  const el = document.createElement("div");
  el.className = "row";
  if (preset.sequenceIndex != null) el.dataset.step = String(preset.sequenceIndex);

  // Not every drafted field deserves a widget. `dependsOn` is the gate tree
  // and `accumulate` is "sum this across the day": the planner reasons about
  // both and a person almost never retypes either, but dropping them on the
  // floor here flattens every drafted parent/child pair into two unrelated
  // skills, and lets thirty seconds settle a goal that asked for an hour.
  el.dataset.dependsOn = preset.dependsOn ?? "";
  el.dataset.accumulate = preset.accumulate ? "1" : "";

  el.append(
    select(["gate", "object", "action", "counter", "discriminator", "metric"], preset.kind ?? "action"),
    select(["any", "camera", "screen"], preset.surface ?? "any"),
    input(preset.key ?? "", "person_at_desk"),
    input(preset.label ?? "", "what would literally be seen"),
    select(["gate", "required", "discriminating"], preset.role ?? "required"),
    btn("×", "ghost sm", () => el.remove()),
  );
  rows.append(el);
}

$("g-plan").addEventListener("click", async () => {
  const sentence = $("g-sentence").value.trim();
  if (!sentence) return;
  const status = $("g-status");
  status.className = "status";
  status.textContent = "Drafting…";

  const res = await fetch("/api/engine/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sentence, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  });

  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: `planner failed (${res.status})` }));
    status.className = "status err";
    status.textContent = `${error} — fill the fields in below instead.`;
    return;
  }

  const plan = await res.json();
  $("g-key").value = plan.key ?? "";
  $("g-desc").value = plan.description ?? "";
  $("g-cadence").value = plan.cadence ?? "daily";
  $("g-type").value = plan.type ?? "target";
  if (plan.doneMin != null) $("g-donemin").value = plan.doneMin;
  if (plan.windowStart) $("g-start").value = plan.windowStart;
  if (plan.windowEnd) $("g-end").value = plan.windowEnd;
  rows.replaceChildren();
  for (const u of plan.uses ?? []) addRow(u);

  status.className = "status ok";
  status.textContent = `${plan.created} new, ${plan.reused} reused. Check the labels, then create.`;
});

$("goal-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "save") return;

  const defined = [...rows.children].map((el) => {
    const [kind, surface, key, label, role] = el.querySelectorAll("select, input");
    return {
      kind: kind.value,
      surface: surface.value,
      key: key.value.trim(),
      label: label.value.trim(),
      role: role.value,
      dependsOn: el.dataset.dependsOn || null,
      accumulate: el.dataset.accumulate === "1",
      sequenceIndex: el.dataset.step === undefined ? null : Number(el.dataset.step),
    };
  });

  // Skills first: the join row carries a foreign key, and a goal pointing at
  // nothing is a goal that can never settle.
  //
  // Gates before the rest for the same reason one level down: depends_on is
  // itself a foreign key into this table, so a child written before its
  // parent is a child whose gate chain is broken from birth.
  const writing = defined.filter((r) => r.key && r.label);
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
        // Only when the parent is actually among the skills being written.
        // A dangling key leaves the child permanently ineligible, which
        // looks exactly like a detector that does not work.
        dependsOn: r.dependsOn && named.has(r.dependsOn) ? r.dependsOn : null,
      }),
    });
  }

  await fetch("/api/engine/goals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: $("g-key").value.trim(),
      description: $("g-desc").value.trim(),
      type: $("g-type").value,
      cadence: $("g-cadence").value,
      doneMin: Number($("g-donemin").value),
      windowStart: $("g-start").value || null,
      windowEnd: $("g-end").value || null,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      uses: defined
        .filter((r) => r.key)
        .map((r) => ({
          skillKey: r.key,
          role: r.role,
          minCount: r.kind === "counter" ? Number($("g-donemin").value) || null : null,
          // Without this an action settles on its first session of any
          // length, so thirty seconds of the right thing on screen would
          // credit a whole hour.
          accumulate: r.accumulate,
          sequenceIndex: r.sequenceIndex,
        })),
    }),
  });

  void load();
});

// ---------------------------------------------------------------- helpers --

function btn(text, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn ${cls}`;
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

function input(value, placeholder) {
  const i = document.createElement("input");
  i.type = "text";
  i.value = value;
  i.placeholder = placeholder;
  return i;
}

function select(options, value) {
  const s = document.createElement("select");
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = opt.textContent = o;
    s.append(opt);
  }
  s.value = value;
  return s;
}

const num = (v) => (v == null ? "—" : Number(v).toFixed(2));
const ms = (v) => (v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
const time = (t) => new Date(t).toTimeString().slice(0, 8);
const fmt = (v) => (v == null ? "—" : v >= 3600 ? `${(v / 3600).toFixed(1)} h` : String(Math.round(v)));

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// ------------------------------------------------------------------- boot --

drawPlot();
void load();
hubSocket();
engineSocket();

/**
 * Where a sequence index sits in the running order.
 *
 * The planner may well emit 10 and 20, which are labels rather than
 * positions. Showing "10." beside the first step of two reads as a bug.
 */
function stepOrder(goal, index) {
  const indices = [
    ...new Set(
      (goal.uses ?? [])
        .filter((u) => u.sequenceIndex != null && u.role !== "gate")
        .map((u) => u.sequenceIndex),
    ),
  ].sort((a, b) => a - b);
  return indices.indexOf(index) + 1;
}
