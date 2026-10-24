# Pact — video hub

A feed wall you add devices to by scanning a QR code. No app to install, no
config file to edit, no redeploy. Open a link on a phone or laptop, pick camera
or screen, and it appears on the wall for everyone watching.

Built for the **Nebius × NVIDIA hackathon**. This repo is the ingest and
distribution layer only — the piece everything else needs first.

> **Scope.** Pact's product goal is goal tracking with visual proof: you say
> you'll do something, the cameras confirm you did. That means a vision pipeline
> sampling frames, embedding them, and training small classifiers — intended to
> run on Nebius GPUs. **None of that is in this repo.** This is the transport
> problem solved cleanly so the inference work has something to consume.

---

## What works

| | Status |
|---|---|
| Browser camera → wall | Working |
| Browser screen share → wall | Working (not iOS Safari — no `getDisplayMedia`) |
| QR / one-time code pairing | Working |
| Live device registry, pushed over WebSocket | Working |
| Auto-reconnect, self-healing wall | Working |
| RTSP / RTMP / MJPEG / ESP32 ingest | Working, via [the bridge](bridge/) |

---

## Architecture

```
  ┌─ phone camera ──┐
  │  laptop camera  │   getUserMedia / getDisplayMedia
  │  screen share   │
  └────────┬────────┘
           │  WebRTC (SDP brokered by the Worker, media direct)
           ▼
   Cloudflare Realtime SFU ──────────────▶ viewers on the wall
      (media plane)                         WebRTC subscribe
           ▲
           │  SDP only, never media
  ┌────────┴─────────────────────────────────────────┐
  │  Worker  (src/index.ts)                          │
  │    /api/sfu/*  → proxies SDP, holds app secret   │
  │    /api/hub/*  → forwards to the Durable Object  │
  └────────┬─────────────────────────────────────────┘
           │
  ┌────────▼─────────────────────────────────────────┐
  │  Hub Durable Object  (src/hub.ts)                │
  │    one instance, named "wall"                    │
  │    WebSocket fanout + claim codes                │
  └──────────────────────────────────────────────────┘
```

**Media never passes through the Worker.** Workers can't carry WebRTC — no UDP,
no long-lived sockets. The Worker only brokers the SDP handshake, because that
step needs the SFU app secret and the browser can't be trusted with it. Actual
video goes browser ↔ Cloudflare edge directly.

### The registry has no storage

The live device list is **derived from the set of open publisher WebSockets**:

```ts
private devices(): Device[] {
  return this.ctx.getWebSockets()
    .map((ws) => this.metaOf(ws))
    .filter((m) => m?.role === "publisher")
    .map((m) => m.device);
}
```

A publisher holds its socket open for as long as it streams, so *socket open*
and *device live* are the same fact, recorded once. No heartbeats, no TTLs, no
reconciliation, and no way to strand a device that already left. Closing the tab
takes the feed off the wall because the socket closes.

This is also why the Durable Object matters: it gives one authoritative,
single-threaded answer to "what is live right now," and a place to fan that
answer out over WebSocket. A stateless Worker could not hold the sockets, and
KV could not keep the list consistent.

### The publish/subscribe asymmetry

The direction of the SDP offer flips depending on what you're doing, which is
the one genuinely confusing part of the SFU API:

- **Publishing** — you offer, the SFU answers. One round trip.
- **Subscribing** — you name the tracks you want, the SFU offers, you answer via
  `/renegotiate`. Two round trips.

Both paths have a race worth knowing about: `setRemoteDescription` can fire ICE
and `track` events synchronously, so listeners must be attached *before* it is
called. See the comments in [`public/js/sfu-client.js`](public/js/sfu-client.js).

---

## Files

```
src/
  index.ts    Router. /api/hub/* → Durable Object, /api/sfu/* → Cloudflare.
  hub.ts      The Hub Durable Object: registry, WebSocket fanout, claim codes.
  sfu.ts      Realtime SFU client. Pass-through plus the app secret.
  types.ts    Shared types.

public/
  index.html  The wall.
  join.html   The publisher page.
  pact.css    Design system.
  js/
    sfu-client.js  publish() and subscribe(). The WebRTC core.
    wall.js        Hub socket, tile lifecycle, QR dialog.
    join.js        Source picking, publish, liveness socket.

bridge/          Node process for non-browser sources. Own package.json.
  src/
    index.ts     CLI + per-source supervision (restart, backoff, watchdog).
    publish.ts   werift -> SFU. The Node twin of sfu-client.js.
    source.ts    ffmpeg argument construction and spawning.
    hub.ts       Hub WebSocket client: announce + liveness.
```

No build step and no framework. The frontend is modules the browser loads
directly, which keeps the interesting parts readable.

---

## Setup

```bash
npm install
```

Create a Realtime app at
[dash.cloudflare.com → Realtime](https://dash.cloudflare.com/?to=/:account/calls)
and set both secrets:

```bash
npx wrangler secret put REALTIME_APP_ID
npx wrangler secret put REALTIME_APP_SECRET
```

For local dev, copy `.dev.vars.example` to `.dev.vars` and fill it in.

```bash
npm run dev       # localhost:8787
npm run deploy    # pact.lanvar.ai
npm run typecheck
```

Without the secrets the wall still loads and the registry still works — feeds
just can't connect, and `/api/config` reports `sfuReady: false` so the UI says
so instead of failing at handshake time.

---

## Tier 2: RTSP, RTMP, ESP32

Non-browser sources go through [`bridge/`](bridge/) — a small Node process that
runs wherever the camera is reachable:

```bash
cd bridge && npm install

# synthetic source, no hardware needed
npm start -- --hub https://pact.lanvar.ai --name "Test" --input testsrc

# an H.264 RTSP camera (no transcode, nearly free)
npm start -- --hub https://pact.lanvar.ai --name "Shop" --input rtsp://10.0.0.5:554/stream1

# an ESP32-CAM serving MJPEG (must be re-encoded)
npm start -- --hub https://pact.lanvar.ai --name "ESP32" --input http://10.0.0.77:81/stream --transcode
```

It exists because **Cloudflare Realtime SFU does not speak WHIP** — it has its
own sessions/tracks API, so despite ffmpeg 8 shipping a WHIP muxer there is no
`ffmpeg -f whip` shortcut that reaches it. The bridge does the WebRTC handshake
itself against the same `/api/sfu/*` endpoints the browser uses:

```
ffmpeg ──RTP/UDP──▶ localhost ──▶ werift ──WebRTC──▶ SFU ──▶ wall
                                     └──WebSocket──▶ Hub (announce + liveness)
```

Nothing is decoded in Node — ffmpeg's bytes are forwarded packet by packet into
a WebRTC track. See [bridge/README.md](bridge/README.md) for the copy-vs-transcode
decision, the supervision model, and `--dry-run`.

### ESP32 notes

Use the bridge, and prefer **RTSP firmware** such as
[`esp32cam-rtsp`](https://github.com/rzeldent/esp32cam-rtsp) over the stock
CameraWebServer MJPEG example. The stock MJPEG stream does not return a proper
HTTP status code, so it plays in a browser but
[chokes ffmpeg, VLC and OpenCV](https://github.com/espressif/arduino-esp32/issues/3597).
RTSP avoids that entirely.

An S3 has no hardware video encoder, so `--transcode` is mandatory (~1 core per
stream). An ESP32-P4 has hardware H.264 at 1080p30, which lets the bridge run
`-c:v copy` for near-zero CPU.

Publishing WebRTC *directly* from the board is not currently possible against
this hub. Espressif's [`esp-webrtc-solution`](https://github.com/espressif/esp-webrtc-solution)
speaks WHIP, and Realtime SFU does not. Its signaling layer is pluggable
(`esp_peer_signaling_impl_t` is three functions), so porting it to Cloudflare's
sessions/tracks API is feasible firmware work — but it is firmware work, not a
config change.

## What this deliberately is not

- **No real auth.** Claim codes stop a stranger who finds the join URL from
  publishing, and that is all they do. Anyone with the wall URL can watch. Put
  Cloudflare Access in front of it before pointing it at anything private.
- **No recording.** Live only, nothing is stored.
- **No transcoding in the cloud.** The SFU forwards bytes untouched, so viewers
  get whatever the publisher encoded. The bridge can transcode locally with
  `--transcode`, on your CPU, not Cloudflare's.
- **Audio is not published.** A wall of simultaneous audio is unusable; wall
  videos are `muted` anyway, which is also what lets them autoplay.

## Cost

Realtime SFU is **$0.05/GB egress with the first 1,000 GB free**; inbound is
free. Workers and Durable Objects fall inside the paid plan's included usage at
this scale. A handful of feeds and viewers costs nothing.
