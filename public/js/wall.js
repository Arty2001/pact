/* ===========================================================================
   The wall.

   One WebSocket to the Hub tells us what is live. Every device we hear about
   gets its own WebRTC subscription, independent of the others, so a feed that
   fails to connect does not take the wall down with it.
   =========================================================================== */

import { subscribe } from "./sfu-client.js";

const wall = document.getElementById("wall");
const railList = document.getElementById("rail-list");
const railCount = document.getElementById("rail-count");
const statLive = document.getElementById("stat-live");
const statClock = document.getElementById("stat-clock");

/** id -> { device, tile, pc } */
const feeds = new Map();

/** How many empty slots to show so the wall never looks broken. */
const MIN_SLOTS = 4;

let sfuReady = true;

// ------------------------------------------------------------------- clock --

setInterval(() => {
  statClock.textContent = new Date().toISOString().slice(11, 19);
}, 1000);

// ------------------------------------------------------------------ render --

function render() {
  const live = [...feeds.values()];

  statLive.textContent = live.length;
  railCount.textContent = live.length;

  // Channel numbers are assigned here, not at tile creation, so they stay
  // 01..N with no gaps or duplicates after a feed drops out of the middle.
  live.forEach(({ tile }, i) => {
    tile.querySelector(".ch").textContent = String(i + 1).padStart(2, "0");
  });

  // Rail
  railList.replaceChildren(
    ...live.map(({ device }, i) => {
      const li = document.createElement("li");
      li.className = "rail-item";
      li.innerHTML = `
        <span class="led"></span>
        <span class="nm"></span>
        <span class="el"></span>`;
      li.querySelector(".nm").textContent = device.name;
      li.querySelector(".el").textContent = elapsed(device.since);
      li.onclick = () =>
        live[i].tile?.scrollIntoView({ behavior: "smooth", block: "center" });
      return li;
    }),
  );

  if (!live.length) {
    const li = document.createElement("li");
    li.className = "rail-empty";
    li.textContent = sfuReady
      ? "Nothing streaming. Add a device to put it on the wall."
      : "Realtime SFU is not configured, so feeds cannot connect yet.";
    railList.replaceChildren(li);
  }

  // Wall. Tiles are added and removed in place rather than rebuilt wholesale:
  // moving a <video> element in the DOM can interrupt playback, so one device
  // coming up must not disturb the feeds already running.
  const liveTiles = new Set(live.map((f) => f.tile));

  for (const node of [...wall.children]) {
    if (node.classList.contains("slot") || !liveTiles.has(node)) node.remove();
  }
  for (const { tile } of live) {
    if (tile.parentNode !== wall) wall.append(tile);
  }
  for (let i = live.length; i < MIN_SLOTS; i++) {
    const slot = document.createElement("div");
    slot.className = "slot";
    slot.innerHTML = "<span>no signal</span>";
    wall.append(slot);
  }
}

function elapsed(since) {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}m` : `${s}s`;
}

// Keep the rail timers honest without re-rendering the video elements.
setInterval(() => {
  const items = railList.querySelectorAll(".rail-item .el");
  [...feeds.values()].forEach(({ device }, i) => {
    if (items[i]) items[i].textContent = elapsed(device.since);
  });
}, 1000);

// -------------------------------------------------------------------- tile --

function buildTile(device) {
  const tile = document.createElement("div");
  tile.className = "tile connecting";
  tile.innerHTML = `
    <video autoplay playsinline muted></video>
    <div class="clock"></div>
    <div class="umd">
      <span class="tally"></span>
      <span class="ch"></span>
      <span class="nm"></span>
      <span class="kind"></span>
    </div>`;

  tile.querySelector(".nm").textContent = device.name;
  tile.querySelector(".kind").textContent = device.kind;

  const clock = tile.querySelector(".clock");
  const tick = setInterval(() => {
    clock.textContent = new Date().toISOString().slice(11, 19) + "Z";
  }, 1000);
  tile._stopClock = () => clearInterval(tick);

  return tile;
}

// --------------------------------------------------------------- feed life --

async function addFeed(device) {
  if (feeds.has(device.id)) return;

  const tile = buildTile(device);
  feeds.set(device.id, { device, tile, pc: null });
  render();

  try {
    const { pc, stream } = await subscribe(device);
    const entry = feeds.get(device.id);
    if (!entry) {
      pc.close(); // Went down while we were connecting.
      return;
    }
    entry.pc = pc;
    tile.querySelector("video").srcObject = stream;
    tile.classList.remove("connecting");
  } catch (err) {
    console.error(`feed ${device.name}:`, err);
    tile.querySelector(".kind").textContent = "failed";
  }
}

function removeFeed(id) {
  const entry = feeds.get(id);
  if (!entry) return;
  entry.pc?.close();
  entry.tile._stopClock?.();
  feeds.delete(id);
  render();
}

// --------------------------------------------------------------- websocket --

/**
 * The Hub connection, with backoff.
 *
 * On every reconnect the Hub sends a full `state` snapshot, so we reconcile
 * against it rather than trusting what we had. That makes a dropped socket
 * self-healing instead of leaving dead tiles on the wall.
 */
function connect(attempt = 0) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/hub/ws`);

  ws.onopen = () => (attempt = 0);

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "state") {
      const incoming = new Set(msg.devices.map((d) => d.id));
      for (const id of [...feeds.keys()]) if (!incoming.has(id)) removeFeed(id);
      msg.devices.forEach(addFeed);
    } else if (msg.type === "up") {
      addFeed(msg.device);
    } else if (msg.type === "down") {
      removeFeed(msg.id);
    }
  };

  ws.onclose = () => {
    const delay = Math.min(1000 * 2 ** attempt, 15000);
    setTimeout(() => connect(attempt + 1), delay);
  };

  ws.onerror = () => ws.close();
}

// ------------------------------------------------------------ add a device --

const dialog = document.getElementById("claim-dialog");
const qrBox = document.getElementById("claim-qr");

document.getElementById("add-device").onclick = async () => {
  const res = await fetch("/api/hub/claim", { method: "POST" });
  const { code } = await res.json();
  const url = `${location.origin}/join?c=${code}`;

  document.getElementById("claim-code").textContent = code;
  document.getElementById("claim-url").textContent = url;

  qrBox.replaceChildren();
  new QRCode(qrBox, { text: url, width: 166, height: 166, correctLevel: QRCode.CorrectLevel.M });

  dialog.showModal();
};

document.getElementById("claim-close").onclick = () => dialog.close();

document.getElementById("claim-copy").onclick = async (e) => {
  await navigator.clipboard.writeText(document.getElementById("claim-url").textContent);
  e.target.textContent = "Copied";
  setTimeout(() => (e.target.textContent = "Copy link"), 1600);
};

// -------------------------------------------------------------------- boot --

fetch("/api/config")
  .then((r) => r.json())
  .then((c) => {
    sfuReady = c.sfuReady;
    render();
  })
  .catch(() => {});

render();
connect();
