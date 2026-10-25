/* ===========================================================================
   Publisher.

   Two things happen when you press start:

     1. The stream goes to the SFU over WebRTC.
     2. A WebSocket opens to the Hub and announces the device.

   That socket is the liveness signal. The Hub treats socket-open as
   device-live, so we never send a heartbeat and never have to time anything
   out — closing the tab is what takes the feed off the wall.
   =========================================================================== */

import { FrameTap } from "./frame-tap.js";
import { publish } from "./sfu-client.js";

const el = (id) => document.getElementById(id);

const gate = el("gate");
const setup = el("setup");
const onair = el("onair");
const preview = el("preview");
const placeholder = el("placeholder");
const nameInput = el("name");
const startBtn = el("start");
const status = el("status");

let stream = null;
let kind = null;
let session = null; // { pc, sessionId, trackNames }
let ws = null;
let tap = null;

// ------------------------------------------------------------------- claim --

/**
 * Check the hub can actually reach Cloudflare Realtime before we let anyone
 * pick a camera. Without the secrets every publish dies at the first fetch
 * with a bare 503, which tells the user nothing they can act on.
 */
async function checkConfig() {
  const { sfuReady } = await fetch("/api/config")
    .then((r) => r.json())
    .catch(() => ({ sfuReady: false }));

  if (sfuReady) return true;

  fail(
    "The hub is not connected to Cloudflare Realtime yet",
    "Streaming needs a Realtime app. On the machine that deploys this hub, run " +
      "'wrangler secret put REALTIME_APP_ID' and 'wrangler secret put REALTIME_APP_SECRET', " +
      "then reload this page. No redeploy needed.",
  );
  return false;
}

/**
 * Redeem the one-time code from the QR before showing anything.
 *
 * This is deliberately thin: it stops a stranger who finds the URL from
 * publishing, and it is not a substitute for real auth. See the README.
 */
async function checkClaim() {
  const code = new URLSearchParams(location.search).get("c");

  if (!code) {
    return fail("No code in the link", 'Open the wall, choose "Add a device", and scan the code it shows you.');
  }

  const res = await fetch("/api/hub/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });

  if (res.ok) {
    gate.hidden = true;
    setup.hidden = false;
    return;
  }

  const { reason } = await res.json().catch(() => ({ reason: "unknown" }));
  return reason === "expired"
    ? fail("That code expired", "Codes last ten minutes. Generate a fresh one from the wall.")
    : fail("That code is not valid", "It may have been used already. Each code works once.");
}

function fail(title, body) {
  el("gate-title").textContent = title;
  el("gate-body").textContent = body;
  gate.hidden = false;
  setup.hidden = true;
}

// ------------------------------------------------------------------ source --

async function pick(which) {
  try {
    const next =
      which === "camera"
        ? await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
          })
        : await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 15 } },
            audio: false,
          });

    stream?.getTracks().forEach((t) => t.stop());
    stream = next;
    kind = which === "camera" ? "camera" : "screen";

    preview.srcObject = stream;
    placeholder.hidden = true;

    el("pick-camera").setAttribute("aria-pressed", String(which === "camera"));
    el("pick-screen").setAttribute("aria-pressed", String(which === "screen"));

    if (!nameInput.value) nameInput.value = which === "camera" ? "Camera" : "Screen";
    startBtn.disabled = false;
    say("");

    // The browser's own "stop sharing" bar ends the track without telling us.
    stream.getVideoTracks()[0].addEventListener("ended", () => stop());
  } catch (err) {
    say(err.name === "NotAllowedError" ? "Permission denied." : `Could not open source: ${err.message}`, "err");
  }
}

function say(text, cls = "") {
  status.textContent = text;
  status.className = `status ${cls}`;
}

// ------------------------------------------------------------------- start --

async function start() {
  startBtn.disabled = true;
  say("Connecting to the edge...");

  try {
    session = await publish(stream);
  } catch (err) {
    say(
      /503/.test(err.message)
        ? "The hub has no Cloudflare Realtime credentials set, so it cannot start a stream."
        : `Could not start: ${err.message}`,
      "err",
    );
    startBtn.disabled = false;
    return;
  }

  const device = {
    id: crypto.randomUUID(),
    name: nameInput.value.trim() || (kind === "camera" ? "Camera" : "Screen"),
    kind,
    sfuSessionId: session.sessionId,
    trackNames: session.trackNames,
    since: Date.now(),
  };

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/api/hub/ws`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "publish", device }));
    setup.hidden = true;
    onair.hidden = false;
    el("onair-name").textContent = device.name;
    el("onair-status").textContent = `${device.kind} · ${session.trackNames.length} track(s) · live`;

    // Sampling is deliberately separate from the SFU leg. The wall can be
    // watching with nobody analysing, and perception can be analysing with
    // nobody watching; coupling them would break both cases.
    tap = new FrameTap(
      preview,
      device.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      device.kind === "screen" ? "screen" : "camera",
    );
    tap.start();
    setInterval(() => {
      if (!tap) return;
      const { sampled, gated, sent, lastMoved } = tap.stats;
      const gate = el("onair-gate");

      // Checked before everything else, because while it is true none of the
      // other numbers are moving and all of them look fine.
      if (tap.throttled) {
        gate.className = "status err";
        gate.textContent =
          "This tab is in the background, so the browser has throttled it and " +
          "frames have stopped. Keep this tab visible - or publish from a phone " +
          "and watch the goals page somewhere else.";
        return;
      }

      if (tap.unwatched) {
        // The feed is on the wall and nothing is analysing it. Say so, and
        // say what to do, because every other signal on this page looks
        // healthy and the goal just never advances.
        gate.className = "status err";
        gate.textContent =
          "No perception worker is connected, so these frames are being discarded. " +
          `Start one with:  --room ${tap.room} --hub ${location.origin}`;
        return;
      }
      gate.className = "status";
      gate.textContent =
        `${sent} sent · ${gated} gated (${Math.round((gated / Math.max(sampled, 1)) * 100)}%) · motion ${lastMoved.toFixed(3)}`;
    }, 1000);
  };

  // If the Hub connection drops, the feed is effectively off the wall.
  ws.onclose = () => {
    if (!onair.hidden) el("onair-status").textContent = "Disconnected from the hub.";
  };
}

// -------------------------------------------------------------------- stop --

function stop() {
  tap?.stop();
  tap = null;
  ws?.close();
  session?.pc.close();
  stream?.getTracks().forEach((t) => t.stop());
  ws = session = stream = null;

  preview.srcObject = null;
  placeholder.hidden = false;
  startBtn.disabled = true;
  onair.hidden = true;
  setup.hidden = false;
  el("pick-camera").setAttribute("aria-pressed", "false");
  el("pick-screen").setAttribute("aria-pressed", "false");
  say("Stopped.");
}

// -------------------------------------------------------------------- boot --

el("pick-camera").onclick = () => pick("camera");
el("pick-screen").onclick = () => pick("screen");
startBtn.onclick = start;
el("stop").onclick = stop;

// iOS Safari has getUserMedia but not getDisplayMedia. Say so instead of
// letting the button fail.
if (!navigator.mediaDevices?.getDisplayMedia) {
  const b = el("pick-screen");
  b.disabled = true;
  b.title = "This browser cannot share a screen";
  b.style.opacity = "0.45";
}

gate.hidden = false;
checkConfig().then((ok) => ok && checkClaim());

// ------------------------------------------------------------------ voice --

/*
 * Talking to Pact from the device already in the room.
 *
 * Recognition runs here and only the transcript is sent, so the audio never
 * crosses the network - the same bargain the motion gate makes with frames
 * and the encoder makes with pixels. It also means this works from across
 * the room, mid-set, which a button on a laptop at a desk does not.
 */

const Speech = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition ?? null;
let heard = null;
/** Whether the button is on. */
let open = false;
/** Whether it is actually listening, which is false while it talks. */
let deaf = false;
let lastSpoken = "";
let spokeUntil = 0;

/*
 * This device has the microphone and the speaker in the same room, so left
 * running it transcribes its own reply, answers that, and hears itself
 * again. It goes deaf while thinking and talking, which costs nothing - the
 * person is listening in that window, not talking.
 */
function deafen() {
  deaf = true;
  try {
    heard?.stop();
  } catch {
    // Already stopped.
  }
}

function undeafen() {
  deaf = false;
  if (!open || heard === null) return;
  try {
    heard.start();
  } catch {
    // Already running.
  }
}

function isOwnEcho(text) {
  if (Date.now() - spokeUntil > 1500) return false;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const said = norm(lastSpoken);
  const got = norm(text);
  return got.length > 0 && (said.includes(got) || got.includes(said.slice(0, 40)));
}

function speak(text) {
  const synth = globalThis.speechSynthesis;
  if (!synth || !text) return;
  synth.cancel();
  lastSpoken = text;
  deafen();

  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.04;
  const done = () => {
    spokeUntil = Date.now();
    // A speaker does not stop dead, and the first thing the mic hears after
    // it is our own sentence coming back off the walls.
    setTimeout(undeafen, 450);
  };
  u.onend = done;
  u.onerror = done;
  setTimeout(done, 1200 + text.length * 70);
  synth.speak(u);
}

function showSaid(text, muted = false) {
  const box = el("said");
  box.hidden = !text;
  box.textContent = text;
  box.classList.toggle("muted", muted);
}

async function askPact(text) {
  if (!text.trim()) return;
  showSaid("…", true);
  try {
    const res = await fetch("/api/engine/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const { say: reply = "I lost that one." } = await res.json().catch(() => ({}));
    showSaid(reply);
    // speak() takes over the deafening from here; without a reply nothing
    // would ever switch the microphone back on.
    if (!reply) undeafen();
    // Spoken here, by the device in the room. The console shows the same
    // exchange but stays quiet, or every answer arrives twice.
    speak(reply);
  } catch {
    showSaid("Could not reach the engine.", true);
    undeafen();
  }
}

function listen() {
  if (!Speech || open) return;
  heard = new Speech();
  heard.lang = "en-US";
  heard.interimResults = true;
  heard.continuous = false;

  heard.onresult = (e) => {
    const last = e.results[e.results.length - 1];
    const text = last[0].transcript.trim();
    if (deaf || isOwnEcho(text)) return;
    showSaid(text, true);
    if (last.isFinal) {
      deafen();
      void askPact(text);
    }
  };
  heard.onerror = (e) => {
    // A quiet room gives "no-speech" and our own stop() gives "aborted".
    // Neither is a reason to switch the microphone off.
    if (e.error === "no-speech" || e.error === "aborted") return;
    hush();
  };
  heard.onend = () => {
    // Chrome ends the session on every pause, so it has to be restarted
    // while the button is still on or you get exactly one sentence - but
    // never while we are the one talking.
    if (open && !deaf) {
      try {
        heard.start();
      } catch {
        hush();
      }
    }
  };

  open = true;
  el("listen").setAttribute("aria-pressed", "true");
  el("listen-label").textContent = "Listening — tap to stop";
  try {
    heard.start();
  } catch {
    hush();
  }
}

function hush() {
  open = false;
  deaf = false;
  el("listen").setAttribute("aria-pressed", "false");
  el("listen-label").textContent = "Talk to Pact";
  try {
    heard?.stop();
  } catch {
    // Already stopped.
  }
  heard = null;
}

if (Speech === null) {
  el("listen").disabled = true;
  el("listen-label").textContent = "No speech recognition here";
} else {
  el("listen").addEventListener("click", () => (open ? hush() : listen()));
}

/*
 * Unprompted speech, heard where it matters.
 *
 * A nudge about the bathroom is useless on a laptop in another room, and
 * this device is the one that is actually there. It listens to the Engine
 * for a turn with no `heard` - the mark of something nobody asked for - and
 * says it. The console shows the same line and stays quiet while a camera
 * is publishing, so it is spoken once.
 */
let engineSeenAt = Date.now();
let engineWs = null;

// This tab stays open for a whole workout, which is long enough for a socket
// to die quietly - and a nudge that never arrives is indistinguishable from
// a nudge nobody sent. Ten minutes of silence is reason enough to rebuild
// it; closing is all that happens here, and onclose does the reopening.
setInterval(() => {
  if (Date.now() - engineSeenAt > 600000) {
    engineSeenAt = Date.now();
    try {
      engineWs?.close();
    } catch {
      // Already closing.
    }
  }
}, 15000);

function hearEngine() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/engine/ws`);
  engineWs = ws;
  engineSeenAt = Date.now();
  ws.onmessage = (e) => {
    engineSeenAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type !== "assistant" || msg.heard) return;
    showSaid(msg.say ?? "");
    speak(msg.say ?? "");
  };
  ws.onclose = () => setTimeout(hearEngine, 3000);
}

hearEngine();
