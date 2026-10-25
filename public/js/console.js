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
}, 1000);

// ------------------------------------------------------------------ state --

async function load() {
  const res = await fetch("/api/engine/state");
  if (!res.ok) return;
  state = await res.json();
  renderAll();
}

function renderAll() {
  renderGoals();
  renderSkills();
  renderQuestions();
  renderMeta();
  renderNotices();
  renderTally();
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
function renderNotices() {
  const box = $("notices");
  box.replaceChildren();

  // Liveness comes from scores arriving, not from the last snapshot. The
  // watcher's socket drops and reconnects in under two seconds on any
  // deploy, and a banner driven by a snapshot latches on that blip and then
  // sits there calling a working watcher offline.
  const scoring = Date.now() - lastScoreAt < 15000;
  if (scoring || (state.perception ?? []).length > 0) return;

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
  if (goals.length === 0) return;

  host.replaceChildren(
    ...goals.map((g) => {
      const today = (g.instances ?? [])[0];
      const el = document.createElement("div");
      el.className = `goal is-${today?.state ?? "pending"}`;

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
        drawPlot();
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

function renderSkills() {
  const host = $("skills");
  host.replaceChildren(
    ...(state.skills ?? []).map((s) => {
      const el = document.createElement("div");
      el.className = "skill";
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
  const best =
    goals
      .map((g) => ({ g, i: (g.instances ?? [])[0] }))
      .filter((x) => x.i)
      .sort((a, b) => (b.i.observed ?? 0) - (a.i.observed ?? 0))[0] ?? null;

  if (!best) return;
  const { g, i } = best;
  $("tally-n").textContent = fmt(i.observed);
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
function drawPlot() {
  const svg = $("plot");
  const W = 600;
  const H = 150;
  const y = (v) => H - 12 - v * (H - 26);
  const parts = [];

  // An enter/exit band belongs to one skill. Six of them stacked would be
  // six overlapping rectangles and no readable threshold, so the band
  // appears only once the chart has been narrowed to a single series.
  const focus = focusSkill ? state.skills.find((s) => s.key === focusSkill) : null;
  if (focus) {
    const enter = focus.enterConf ?? 0.75;
    const exit = focus.exitConf ?? 0.45;
    parts.push(
      '<rect class="plot-band" x="42" y="' + y(enter) + '" width="' + (W - 50) +
        '" height="' + Math.max(0, y(exit) - y(enter)) + '"/>',
      line(42, y(enter), W - 8, y(enter), "plot-enter"),
      line(42, y(exit), W - 8, y(exit), "plot-exit"),
      label(0, y(enter) + 3, num(enter), "plot-lbl enter"),
      label(0, y(exit) + 3, num(exit), "plot-lbl"),
    );
  }

  const shown = [...traces.entries()].filter(
    ([key, pts]) => pts.length > 1 && (focusSkill === null || key === focusSkill),
  );

  if (shown.length === 0) {
    parts.push(
      '<text class="plot-wait" x="' + W / 2 + '" y="' + H / 2 +
        '" text-anchor="middle">waiting for a watcher to report scores</text>',
    );
    svg.innerHTML = parts.join("");
    return;
  }

  const step = (W - 50) / Math.max(TRACE - 1, 1);
  for (const [key, pts] of shown) {
    const stroke = hueOf(key);
    const d = pts.map((pt, i) => 42 + i * step + "," + y(pt.score)).join(" ");
    parts.push(
      '<polyline class="plot-curve' + (focusSkill === key ? " lead" : "") +
        '" points="' + d + '" style="stroke:' + stroke + '"/>',
    );
    const last = pts[pts.length - 1];
    parts.push(
      '<circle class="plot-head" cx="' + (42 + (pts.length - 1) * step) +
        '" cy="' + y(last.score) + '" r="3" style="fill:' + stroke + '"/>',
    );
  }

  svg.innerHTML = parts.join("");
}

const line = (x1, y1, x2, y2, cls) =>
  `<line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-width="1" stroke-dasharray="3 3"/>`;
const label = (x, yy, t, cls) => `<text class="${cls}" x="${x}" y="${yy}">${t}</text>`;

function pushScore(skillKey, score, phase) {
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
function renderLegend(scores) {
  const host = $("legend");
  if (host === null) return;
  const keys = Object.keys(scores).sort();

  host.replaceChildren(
    ...keys.map((key) => {
      const s = scores[key];
      const el = document.createElement("button");
      el.type = "button";
      el.className = "sig is-" + (s.phase ?? "idle") + (focusSkill === key ? " on" : "");
      el.title = state.skills.find((x) => x.key === key)?.label ?? key;
      el.setAttribute("aria-pressed", String(focusSkill === key));
      el.innerHTML =
        '<i style="background:' + hueOf(key) + '"></i>' +
        '<span class="k">' + esc(key) + "</span>" +
        '<span class="v">' + num(s.score) + "</span>";
      // Clicking the focused one clears the filter, so there is always a way
      // back to the whole picture without hunting for a reset control.
      el.addEventListener("click", () => {
        focusSkill = focusSkill === key ? null : key;
        renderLegend(scores);
        drawPlot();
      });
      return el;
    }),
  );

  const hit = keys.some((k) => scores[k].phase === "active");
  const box = document.querySelector(".bbox");
  if (box) box.classList.toggle("hit", hit);
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
      for (const [key, s] of Object.entries(msg.scores ?? {})) pushScore(key, s.score, s.phase);
      drawPlot();
      renderLegend(msg.scores ?? {});
      renderNotices();
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
  el.append(
    select(["gate", "object", "action", "counter", "discriminator", "metric"], preset.kind ?? "action"),
    input(preset.key ?? "", "person_at_desk"),
    input(preset.label ?? "", "what a camera would literally see"),
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
    const [kind, key, label, role] = el.querySelectorAll("select, input");
    return {
      kind: kind.value,
      key: key.value.trim(),
      label: label.value.trim(),
      role: role.value,
      sequenceIndex: el.dataset.step === undefined ? null : Number(el.dataset.step),
    };
  });

  // Skills first: the join row carries a foreign key, and a goal pointing at
  // nothing is a goal that can never settle.
  for (const r of defined.filter((r) => r.key && r.label)) {
    await fetch("/api/engine/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: r.key, kind: r.kind, label: r.label }),
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
