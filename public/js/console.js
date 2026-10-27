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

let state = { skills: [], goals: [], questions: [], proposals: [], perception: [], rooms: [] };
let devices = [];
/** deviceId -> { device, pc, pane, toasts }. Several at once, on purpose. */
const feeds = new Map();
/** The pane the chart and the hero count follow. One of them, not all. */
let leadId = null;
/** Kept for the places that only ever cared about the followed camera. */
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
function toast({ kind = "", lead, line, sub = "", room = null }) {
  // On the pane that saw it. With two rooms on the wall, "a rep counted" is
  // only useful if you can tell which room counted it.
  const feed = room === null ? null : [...feeds.values()].find((f) => f.device.room === room);
  const host = feed?.toasts ?? $("toasts");
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
  // Fewer on a pane than on the page: a pane is a fraction of the height
  // and a stack of four would cover the thing being reported on.
  const cap = host === $("toasts") ? 4 : 2;
  while (host.children.length > cap) host.lastElementChild?.remove();

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
        room: tr.room ?? null,
      });
    } else if (tr.kind === "rejected") {
      // A near-miss is the most useful toast there is: it is the only one
      // that tells you to change something.
      const why =
        tr.neededConf > 0
          ? `peak ${num(tr.peak)}, needed ${num(tr.neededConf)}`
          : `held ${ms(tr.heldMs)}, needed ${ms(tr.neededMs)}`;
      toast({ kind: "near", lead: "—", line: `${tr.skillKey} nearly counted`, sub: elsewhere + why, room: tr.room ?? null });
    } else if (tr.kind === "escalate") {
      toast({ kind: "ask", lead: "?", line: `${tr.skillKey} asked for a second opinion`, sub: elsewhere + (tr.reason ?? ""), room: tr.room ?? null });
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

/**
 * Where you stand today, in one sentence.
 *
 * The screen's question is "am I on track", and until now the only thing
 * that answered it was a column of 13px rows in the right margin. A person
 * opening this should know before they read anything.
 *
 * It states what is missing as well as what is done. "Nothing is watching"
 * is the single most useful thing the page can say when it is true, and it
 * was previously only discoverable by noticing that a black rectangle had
 * replaced the video.
 */
function renderFinding() {
  const goals = state.goals ?? [];
  const live = (state.rooms ?? []).length;
  const el = $("today-line");
  const watch = $("bar-watch");
  if (el === null) return;

  watch.textContent = live > 0 ? `${live} camera${live === 1 ? "" : "s"} watching` : "nothing is watching";
  watch.classList.toggle("is-live", live > 0);

  if (goals.length === 0) {
    el.textContent = "No goals yet. Write one and Pact works out what a camera would have to see.";
    return;
  }

  const rows = goals.map((g) => ({ g, i: (g.instances ?? [])[0] }));
  const done = rows.filter((r) => r.i?.state === "done" || r.i?.settledBy).length;
  // A limit that has been broken is the thing you most need told, so it
  // outranks the tally even when everything else went well.
  const broken = rows.find((r) => r.g.type === "limit" && r.i?.state === "violated");

  let line;
  if (broken) {
    line = `<b>${esc(broken.g.description)}</b> — over the limit today.`;
  } else if (done === rows.length) {
    line = `All <b>${rows.length}</b> done today.`;
  } else {
    const next = rows
      .filter((r) => r.i && r.i.targetMin)
      .sort((a, b) => (a.i.observed ?? 0) / a.i.targetMin - (b.i.observed ?? 0) / b.i.targetMin)[0];
    const left = next ? Math.max(0, next.i.targetMin - (next.i.observed ?? 0)) : 0;
    // The description is the sentence the person typed, so it is quoted
    // rather than run into this one. "20 to go on i want to do 20 squats
    // every day" reads as a sentence that lost track of itself.
    line = next
      ? `<b>${esc(fmt(left))}</b> to go — “${esc(next.g.description)}”.`
      : `<b>${done}</b> of <b>${rows.length}</b> done today.`;
  }

  // The camera state is part of the finding, not a separate notice. A goal
  // that cannot advance because nothing is publishing is the most common
  // reason this page looks stuck, and saying so costs one clause.
  el.innerHTML = live > 0 ? line : `${line} Nothing is watching, so nothing can be proved yet.`;
}

/**
 * Getting ready, as four facts rather than a bar that fills on a timer.
 *
 * Every step below is something the control plane actually observes, so the
 * progress cannot lie: the machine is running or it is not, perception has
 * said hello or it has not, this camera has been scored or it has not. A
 * percentage invented from an elapsed clock would be smoother and would
 * mean nothing, and the one thing someone staring at a cold start needs is
 * to know which part is slow.
 *
 * Hidden entirely once the last step is done, because a progress bar that
 * stays on screen after it finishes is just furniture.
 */
function renderStartup() {
  const host = $("startup");
  if (host === null) return;

  const rooms = state.rooms ?? [];
  const room = activeRoom ?? rooms[0]?.room ?? null;
  const machine = state.encoder ?? null;
  const connected = (state.perception ?? []).length > 0;
  const scored = (state.watching ?? []).some((w) => w.room === room);

  // Nothing to report before a camera exists: the empty stage already says
  // what to do, and two messages about the same absence is one too many.
  if (rooms.length === 0 || scored) {
    host.hidden = true;
    return;
  }

  const steps = [
    { label: "Camera publishing", done: true },
    // Only when the sleep/wake feature is configured. Without it the
    // encoder is assumed to be running somewhere already, and a step for a
    // machine nobody is starting would be a step that never completes.
    ...(machine === null
      ? []
      : [{ label: "Encoder machine", done: machine === "running", note: machine }]),
    { label: "Encoder loaded", done: connected, note: connected ? "" : "about a minute" },
    { label: "Scoring this camera", done: false },
  ];

  const at = steps.findIndex((s) => !s.done);
  const pct = Math.round((steps.filter((s) => s.done).length / steps.length) * 100);
  const since = state.encoderSince ?? 0;
  const waited = since > 0 ? Math.round((Date.now() - since) / 1000) : 0;

  host.hidden = false;
  host.innerHTML =
    `<div class="startup-top">` +
    `<b>${esc(steps[at]?.label ?? "Ready")}</b>` +
    (steps[at]?.note ? `<span>${esc(steps[at].note)}</span>` : "") +
    (waited > 3 ? `<span class="mono">${waited}s</span>` : "") +
    `</div>` +
    `<div class="startup-bar"><i style="width:${pct}%"></i></div>` +
    `<div class="startup-steps">${steps
      .map((s) => `<span class="${s.done ? "done" : ""}">${esc(s.label)}</span>`)
      .join("")}</div>`;
}

function renderAll() {
  pruneTraces();
  announceGoals();
  renderGoals();
  renderSkills();
  renderWaiting();
  renderFinding();
  renderStartup();
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

      el.innerHTML = `
        <div class="goal-top">
          <span class="name">${esc(g.description)}</span>
          <span class="chip ${chipFor(g, today)}">${esc(stateLabel(g, today))}</span>
          <button class="kill" type="button" title="Delete this goal">×</button>
        </div>
        <div class="goal-fig"><b>${esc(fmt(today ? today.observed : 0))}</b><span>${
          today?.targetMin ? `of ${esc(fmt(today.targetMin))}` : esc(stateLabel(g, today))
        }</span></div>
        <div class="goal-meta">${esc(g.cadence)} · ${esc(win)}${
          // Only when the sentence named no number and a search found one.
          // Shown because a target you cannot trace is a number this system
          // invented and then held you to - and the whole promise here is
          // that nothing gets asserted without evidence.
          g.sourceUrl
            ? ` · <a class="src" href="${esc(g.sourceUrl)}" target="_blank" rel="noopener noreferrer">target from source</a>`
            : ""
        }</div>
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
      //
      // The padding is the whole point and it was missing, so a goal made
      // today drew one lone cell and a goal made yesterday drew two. On a
      // card that is otherwise full width, a stray eleven-pixel square reads
      // as a rendering fault rather than as a history that has not happened
      // yet. Days with no occurrence are hollow, so they stay distinct from
      // a day that exists and is still pending.
      const streak = el.querySelector(".streak");
      const days = [...(g.instances ?? [])].reverse().slice(-14);
      for (let k = days.length; k < 14; k++) {
        const d = document.createElement("i");
        d.className = "none";
        d.title = "no occurrence yet";
        streak.append(d);
      }
      for (const i of days) {
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
      // Shown only when it is `layout`, because `full` is what almost every
      // skill is and a chip on every row would be noise. Shown at all
      // because this is the one setting with no widget anywhere: the planner
      // chooses it, it changes which picture the detector sees, and without
      // this there is no way to tell from the outside which of the two a
      // gate is actually asking about.
      const view =
        s.view === "layout"
          ? `<span class="chip" title="Scores the shape of the screen with its content averaged away, so the score follows the player rather than the clip playing in it">layout</span>`
          : "";
      el.innerHTML = `
        <span class="kind">${esc(s.kind)}</span>
        <span style="min-width:0">
          <span class="key">${esc(s.key)}</span><br>
          <span class="label">${esc(s.label)}</span>
        </span>
        <span style="display:flex; gap:6px; align-items:center">
          <span class="chip ${w}">${esc(s.weightState)}</span>
          ${view}
          <span class="chip">${s.sampleHz} Hz</span>
          <button type="button" class="chip act" title="Work out what this should be looking for">rethink</button>
        </span>`;
      // Reachable without speaking. The voice path covers the complaint as
      // it is made, but someone scrolling a list of skills and seeing one
      // that has never fired is having the same thought, and asking them to
      // say it out loud to act on it is a worse product.
      el.querySelector(".act").addEventListener("click", () => rethink(s.key));
      return el;
    }),
  );
}

// -------------------------------------------------------------- questions --

/**
 * Everything that needs a person, in one place.
 *
 * Questions and label proposals share this card because they are the same
 * kind of thing from where you are sitting: the system has got as far as it
 * can on its own and the next step is yours. Splitting them into two cards
 * would mean the one you are not looking at goes unanswered.
 */
function renderWaiting() {
  const qs = state.questions ?? [];
  const props = state.proposals ?? [];
  $("q-card").hidden = qs.length === 0 && props.length === 0;
  $("questions").replaceChildren(
    ...props.map(proposalItem),
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

/**
 * A proposed label, with the measurement that argues for it.
 *
 * The number is shown rather than hidden behind "I think this is better",
 * because it is the only reason to believe the proposal at all - it is
 * separation over spread on frames already recorded, so a person can tell
 * a real improvement from a model being agreeable. The runners-up are
 * offered too: the ranking knows which phrase separates these frames, and
 * you know which one describes what you actually meant.
 */
function proposalItem(p) {
  const times = (p.ratio_after / Math.max(p.ratio_before, 0.01)).toFixed(1);
  const el = document.createElement("div");
  el.className = "q-item";
  el.innerHTML =
    `<div class="q-prompt">Should <b>${esc(p.skill_key)}</b> look for ` +
    `“${esc(p.label)}” instead of “${esc(p.was)}”?</div>` +
    `<div class="q-note">Separates ${times}x better on the frames you just showed me.</div>` +
    `<div class="q-acts"></div>`;
  const acts = el.querySelector(".q-acts");
  acts.append(btn("Use it", "primary", () => decide(p.skill_key, true, p.label)));
  for (const other of (p.runners_up ?? []).slice(0, 2)) {
    acts.append(btn(`“${other}”`, "ghost", () => decide(p.skill_key, true, other)));
  }
  acts.append(btn("Keep current", "ghost", () => decide(p.skill_key, false)));
  return el;
}

/**
 * Ask what a skill should have been looking for.
 *
 * Twenty minutes, because this is pressed about something that has already
 * been going on - nobody opens the skill list to report the present. The
 * answer comes back as a proposal in the waiting card, not as a change.
 */
async function rethink(skillKey) {
  const res = await fetch(`/api/engine/skills/${encodeURIComponent(skillKey)}/relabel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ minutesBack: 20 }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.asked) {
    // The usual reason is that nothing is listening, and saying "thinking"
    // over silence is the lie that costs the most trust.
    toast({ kind: "warn", lead: "Can't", line: "no perception worker connected" });
    return;
  }
  toast({ lead: "Looking", line: `at what ${skillKey} should match`, sub: "last 20 minutes" });
}

async function decide(skillKey, accept, label) {
  const res = await fetch(`/api/engine/proposals/${encodeURIComponent(skillKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accept, label }),
  });
  if (!res.ok) toast({ kind: "warn", lead: "Failed", line: `couldn’t change ${skillKey}` });
  else if (accept) toast({ lead: "Relabelled", line: skillKey, sub: label });
  void load();
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
  if (lastScoreAt === 0) {
    return devices.length > 0
      ? "connected, waiting for the first scored frame"
      : "waiting for a camera";
  }
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
 * One pill per camera, and the pills are a multi-select.
 *
 * Every camera runs the whole skill set against its own frames, with its own
 * motion gate and its own calibration fitted from its own background - so
 * this chooses what to LOOK at, not what is running. Turning two on shows
 * two, because the question a wall answers is which room something happened
 * in, and one pane at a time cannot answer it.
 */
function renderCams() {
  const host = $("cams");
  if (host === null) return;
  host.replaceChildren();
  host.hidden = devices.length === 0;
  if (devices.length === 0) return;

  for (const d of devices) {
    const on = feeds.has(d.id);
    const el = document.createElement("button");
    el.type = "button";
    el.className = "cam" + (on ? " on" : "");
    el.setAttribute("aria-pressed", String(on));
    el.innerHTML = "<i></i><span>" + esc(d.name) + "</span>";
    el.addEventListener("click", () => {
      // The last one on stays on. Turning every camera off leaves a stage
      // saying nothing is publishing while something is, which reads as a
      // fault rather than as a choice.
      if (on && feeds.size > 1) dropFeed(d.id);
      else if (!on) void addFeed(d);
      else setLead(d.id);
    });
    host.append(el);
  }

  const add = document.createElement("button");
  add.type = "button";
  add.className = "cam add";
  add.textContent = "+ Add";
  add.addEventListener("click", () => $("add-camera").click());
  host.append(add);
}

/** The pane the chart follows. Scores are per camera; a chart is not. */
function setLead(id) {
  const feed = feeds.get(id);
  if (feed === undefined || leadId === id) return;
  leadId = id;
  current = { device: feed.device, pc: feed.pc };
  activeRoom = feed.device.room ?? null;
  // The old camera's series would otherwise go on drawing beside the new
  // one's, two rooms on one pair of axes, agreeing about nothing.
  traces.clear();
  focusSkill = null;
  $("cam-name").textContent = feed.device.name;
  $("cam-meta").textContent = `${feed.device.kind} · ${feed.device.trackNames.length} track`;
  for (const [fid, f] of feeds) f.pane.classList.toggle("lead", fid === id);
  renderCams();
  drawPlot();
}

async function addFeed(device) {
  if (feeds.has(device.id)) return;

  const pane = document.createElement("div");
  pane.className = "feed";
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  const name = document.createElement("span");
  name.className = "feed-name";
  name.textContent = device.name;
  const toasts = document.createElement("div");
  toasts.className = "feed-toasts";
  pane.append(video, name, toasts);
  pane.addEventListener("click", () => setLead(device.id));

  try {
    const { pc, stream } = await subscribe(device);
    video.srcObject = stream;
    feeds.set(device.id, { device, pc, pane, toasts });
    $("wall").append(pane);
    $("stage-empty").hidden = true;
    $("hud").hidden = false;
    if (leadId === null) setLead(device.id);
    else renderCams();
  } catch {
    // A feed that will not connect should not blank the page; the goal data
    // beside it is still true.
    pane.remove();
    if (feeds.size === 0) $("stage-empty").hidden = false;
    renderCams();
  }
}

function dropFeed(id) {
  const feed = feeds.get(id);
  if (feed === undefined) return;
  try {
    feed.pc?.close();
  } catch {
    // Already closed.
  }
  feed.pane.remove();
  feeds.delete(id);
  if (leadId === id) {
    leadId = null;
    const next = [...feeds.keys()][0];
    if (next !== undefined) setLead(next);
    else {
      current = null;
      activeRoom = null;
      traces.clear();
      $("hud").hidden = true;
      $("stage-empty").hidden = false;
      drawPlot();
    }
  }
  renderCams();
}

/** Everything off, for a page that is losing its cameras altogether. */
function teardown() {
  for (const id of [...feeds.keys()]) dropFeed(id);
}

// ---------------------------------------------------------------- sockets --

/*
 * Both sockets recover from `onclose`, which assumes the browser is told.
 * A half-open socket is never told: the connection is gone and the event
 * never fires, so the page waits for a channel that is already dead. It
 * looks from here exactly like a quiet system, which is the whole problem.
 *
 * So each one is watched. Silence alone is not evidence - a wall changes
 * rarely and a still room scores nothing - but silence past the point where
 * something should have arrived is worth spending a reconnect on. Closing is
 * all that happens here; the existing onclose handler does the reopening, so
 * there is one path back up rather than two.
 */

/** Any message at all, per socket. Not scores - liveness, not activity. */
let engineSeenAt = Date.now();
let hubSeenAt = Date.now();
let engineWs = null;
let hubWs = null;

/**
 * Long enough that a genuinely idle minute does not cause churn, short
 * enough that nobody stands in front of a camera for a minute wondering.
 */
const ENGINE_SILENCE_MS = 35000;
/** The Hub speaks only when the wall changes, so it is allowed much longer. */
const HUB_SILENCE_MS = 150000;

setInterval(() => {
  // Only suspect the engine socket while something should be reporting on
  // it. With nothing publishing, silence is the correct and expected state
  // and reconnecting into it achieves nothing but churn.
  if (devices.length > 0 && Date.now() - engineSeenAt > ENGINE_SILENCE_MS) {
    engineSeenAt = Date.now();
    try {
      engineWs?.close();
    } catch {
      // Already closing; onclose still runs and reopens.
    }
  }
  if (Date.now() - hubSeenAt > HUB_SILENCE_MS) {
    hubSeenAt = Date.now();
    try {
      hubWs?.close();
    } catch {
      // Same.
    }
  }
}, 5000);

function hubSocket() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/hub/ws`);
  hubWs = ws;
  hubSeenAt = Date.now();

  ws.onmessage = (e) => {
    hubSeenAt = Date.now();
    const msg = JSON.parse(e.data);
    if (msg.type === "state") devices = msg.devices;
    else if (msg.type === "up") devices = [...devices.filter((d) => d.id !== msg.device.id), msg.device];
    else if (msg.type === "down") devices = devices.filter((d) => d.id !== msg.id);
    else return;

    renderMeta();
    // Anything that has gone off the wall takes its pane with it; anything
    // new waits to be turned on, except when nothing is on at all.
    for (const id of [...feeds.keys()]) {
      if (!devices.some((d) => d.id === id)) dropFeed(id);
    }
    if (devices.length === 0) {
      teardown();
      $("stage-empty").hidden = false;
      $("hud").hidden = true;
      renderCams();
    } else if (feeds.size === 0) {
      void addFeed(devices[0]);
    } else {
      renderCams();
    }
  };
  ws.onclose = () => setTimeout(hubSocket, 2500);
}

function engineSocket() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/engine/ws`);
  engineWs = ws;
  engineSeenAt = Date.now();

  ws.onmessage = (e) => {
    engineSeenAt = Date.now();
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
  //
  // `view` is the same case and the quietest of the three. The planner marks
  // a screen gate "layout" so it reads the shape of the screen rather than
  // whatever clip is playing inside it; dropped here the gate still scores,
  // still calibrates and still fires, and simply follows the content it was
  // meant to ignore.
  el.dataset.dependsOn = preset.dependsOn ?? "";
  el.dataset.accumulate = preset.accumulate ? "1" : "";
  el.dataset.view = preset.view ?? "";

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
    body: JSON.stringify({
      sentence,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // What is publishing. The planner cannot see the wall, and a goal
      // drafted for a surface nobody is sharing never fires - it should at
      // least know that is what it is doing.
      surfaces: [...new Set(devices.map((d) => (d.kind === "screen" ? "screen" : "camera")))],
    }),
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
      view: el.dataset.view || null,
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
        // Absent rather than null when the draft said nothing, so the Engine
        // can tell "no opinion" - keep whatever the row already had - from a
        // deliberate choice of the ordinary view.
        ...(r.view ? { view: r.view } : {}),
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

// The empty stage carries the same action, because that is where the feed
// will be and so where the hand goes. One handler, two buttons.
$("add-camera-2").addEventListener("click", () => $("add-camera").click());

// --------------------------------------------------------------- the voice --

/**
 * The assistant band.
 *
 * `showExchange` and `speak` were called from the engine socket and defined
 * nowhere, so every assistant message threw a ReferenceError inside the
 * socket handler and the band kept its placeholder for ever. The mic had no
 * listener at all. What looked like a bad design was an unwired one.
 */

const ai = $("ai");

/** Idle is a button, not a wide empty box pretending to be an input. */
function aiIdle(idle) {
  ai.dataset.idle = idle ? "1" : "0";
}
aiIdle(true);

/**
 * Show one turn: what it heard, what it said.
 *
 * Both halves, because the commonest way a voice feature loses trust is
 * acting on something you did not say without ever showing you what it
 * thought it heard.
 */
function showExchange(heard, say, ui = {}) {
  const h = $("ai-heard");
  h.textContent = heard;
  h.hidden = !heard;

  $("ai-said").textContent = say || "—";
  ai.dataset.tone = ui.tone ?? "calm";
  ai.classList.remove("thinking");
  $("ai-state").textContent = "";
  aiIdle(false);

  // The console's own attention follows the assistant's. Naming a skill and
  // then leaving you to find it is the half-done version of this.
  if (ui.focusSkill) {
    focusSkill = ui.focusSkill;
    renderAll();
    drawPlot();
  }
  if (ui.focusGoal) {
    focusGoal = ui.focusGoal;
    renderAll();
  }
}

/**
 * Say it out loud, when the browser can.
 *
 * Wrapped because speechSynthesis is missing or mute on enough platforms
 * that an unguarded call is a crash on somebody's phone, and a silent
 * assistant is far better than a broken page.
 */
function speak(text) {
  if (!text) return;
  try {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {
    // Nothing to do and nothing worth saying: the text is already on screen.
  }
}

/** Send what was said and show the answer. */
async function askPact(text) {
  if (!text) return;
  showExchange(text, "…", { tone: "calm" });
  ai.classList.add("thinking");
  $("ai-state").textContent = "thinking";
  try {
    const res = await fetch("/api/engine/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, room: devices[0]?.room ?? "" }),
    });
    const body = await res.json().catch(() => ({}));
    const say = body.say ?? "I could not think just then.";
    showExchange(text, say, body.ui ?? {});
    speak(say);
  } catch {
    showExchange(text, "I could not reach my own head just then.", { tone: "alert" });
  } finally {
    ai.classList.remove("thinking");
    $("ai-state").textContent = "";
  }
}

/**
 * The microphone.
 *
 * Web Speech where it exists, a typed prompt where it does not. Falling back
 * to typing rather than hiding the control: the assistant is the same
 * feature either way, and a button that vanishes on Firefox reads as broken.
 */
const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
let listening = null;

/**
 * What went wrong, in words a person can act on.
 *
 * Every failure used to arrive as "I did not catch that", which made a
 * refused permission look exactly like mumbling - so the button appeared to
 * do nothing and there was no way to find out why.
 */
const MIC_TROUBLE = {
  "not-allowed": "I need permission to use the microphone. Allow it in the padlock menu, then try again.",
  "service-not-allowed": "This browser is blocking speech recognition. Type instead?",
  "audio-capture": "I cannot find a microphone on this device.",
  network: "Speech recognition needs the network and could not reach it.",
  aborted: "",
  "no-speech": "I did not hear anything.",
};

/** Typing is always available, so the assistant is never simply unusable. */
function askByTyping() {
  const typed = window.prompt("Ask Pact");
  if (typed && typed.trim()) void askPact(typed.trim());
}

$("mic").addEventListener("click", async () => {
  if (listening) {
    listening.stop();
    return;
  }
  if (!Recognition) {
    askByTyping();
    return;
  }

  // Said before anything slow happens. The permission prompt can sit there
  // for as long as it takes someone to read it, and until onstart fires
  // there is otherwise no sign the button did anything at all.
  aiIdle(false);
  $("ai-state").textContent = "starting";
  ai.classList.add("thinking");

  // Asked for explicitly rather than left to the recogniser. Chrome's own
  // prompt from SpeechRecognition is easy to miss and gives no catchable
  // failure, so a denied microphone just looked like silence.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Released at once: the recogniser opens its own. Holding this one keeps
    // the recording indicator lit for as long as the tab is open.
    for (const track of stream.getTracks()) track.stop();
  } catch {
    ai.classList.remove("thinking");
    $("ai-state").textContent = "";
    showExchange("", MIC_TROUBLE["not-allowed"], { tone: "nudge" });
    askByTyping();
    return;
  }

  const rec = new Recognition();
  rec.lang = navigator.language || "en-GB";
  rec.interimResults = true;
  rec.continuous = false;

  rec.onstart = () => {
    listening = rec;
    ai.classList.remove("thinking");
    ai.classList.add("listening");
    $("ai-state").textContent = "listening";
    $("mic").setAttribute("aria-pressed", "true");
  };
  // Interim results are shown as they arrive, so you can see it mishearing
  // you while there is still time to stop and say it again.
  rec.onresult = (e) => {
    const said = [...e.results].map((r) => r[0].transcript).join("").trim();
    const h = $("ai-heard");
    h.textContent = said;
    h.hidden = !said;
    if (e.results[e.results.length - 1].isFinal) void askPact(said);
  };
  rec.onerror = (e) => {
    const why = MIC_TROUBLE[e.error] ?? `Speech recognition failed (${e.error}).`;
    if (why) showExchange("", why, { tone: "nudge" });
    // Anything but a stray silence leaves typing open, so one bad attempt
    // does not end the conversation.
    if (e.error !== "no-speech" && e.error !== "aborted") askByTyping();
  };
  rec.onend = () => {
    listening = null;
    ai.classList.remove("listening", "thinking");
    $("mic").setAttribute("aria-pressed", "false");
    const state = $("ai-state");
    if (state.textContent === "listening" || state.textContent === "starting") state.textContent = "";
  };

  // start() throws InvalidStateError if one is already running, and an
  // uncaught throw here leaves the button stuck looking busy for ever.
  try {
    rec.start();
  } catch {
    ai.classList.remove("thinking");
    $("ai-state").textContent = "";
    askByTyping();
  }
});
