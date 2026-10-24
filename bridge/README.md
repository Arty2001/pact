# Pact bridge

Puts a non-browser source onto a Pact wall: an IP camera, an ESP32, an RTMP
feed, a video file, or a synthetic test pattern.

```bash
npm install

# No hardware needed - synthetic test pattern
npm start -- --hub https://pact.lanvar.ai --name "Test" --input testsrc

# An RTSP camera that already encodes H.264 (no transcode, nearly free)
npm start -- --hub https://pact.lanvar.ai --name "Shop" --input rtsp://user:pass@10.0.0.5:554/stream1

# An ESP32-CAM, which serves MJPEG and must be re-encoded
npm start -- --hub https://pact.lanvar.ai --name "ESP32" --input http://10.0.0.77:81/stream --transcode

# Several at once
npm start -- --hub https://pact.lanvar.ai --config sources.json
```

Requires `ffmpeg` on PATH. Ctrl-C in a terminal takes the feeds off the wall
cleanly - but see [signals](#signals-matter-here) before running it under a
supervisor.

## Why this exists

Cloudflare Realtime SFU does **not** speak WHIP. It has its own sessions/tracks
API, so despite ffmpeg 8 shipping a WHIP muxer there is no
`ffmpeg -i rtsp://… -f whip …` shortcut that reaches it. This bridge does the
WebRTC handshake itself, using the same `/api/sfu/*` endpoints the browser
publisher uses.

## How it works

```
ffmpeg ──RTP/UDP──▶ 127.0.0.1:5004 ──▶ werift ──WebRTC──▶ Realtime SFU ──▶ wall
                                          │
                                          └──WebSocket──▶ Hub (announce + liveness)
```

ffmpeg packetises into RTP and sends it to a local UDP port.
[werift](https://github.com/shinyoshiaki/werift-webrtc) (a pure-TypeScript
WebRTC stack) reads those packets and forwards each one into a WebRTC track
with `track.writeRtp(buf)`.

**Nothing is decoded in Node.** The bytes ffmpeg produces are the bytes that
reach the viewer's browser. That is what makes a bridge cheap enough to run
several of on a small box.

Two details that must line up, or the feed silently never appears:

- **Payload type.** ffmpeg is told `-payload_type 96` and werift advertises
  `payloadType: 96`. A mismatch means the browser discards every packet.
- **Packet size.** `?pkt_size=1200` keeps RTP under the MTU. Oversized packets
  get dropped somewhere in the path with no error anywhere.

## copy vs transcode

| Source | Flag | Cost |
|---|---|---|
| H.264 RTSP camera | *(none)* | `-c:v copy` — re-packetise only, nearly free |
| MJPEG (ESP32-CAM) | `--transcode` | Full decode + encode, ~1 core per 1080p stream |
| H.265 / HEVC camera | `--transcode` | Same. Browsers mostly cannot play H.265 |
| `testsrc` | automatic | Always encodes; it is raw frames |

Check your camera's settings before reaching for `--transcode`. Many cameras
can be switched to H.264 in their own web UI, which moves the encoding onto the
camera's ASIC and off your CPU entirely.

When transcoding, the encoder is set to `-tune zerolatency` (no B-frames, no
lookahead), `-profile:v baseline` (widest browser support) and `-g 30`
(keyframe every second).

## Supervision

Most of `src/index.ts` is supervision rather than streaming, which is the
honest ratio for this problem. RTSP sources are notoriously unreliable over
days — cameras wedge, wifi drops, ffmpeg exits quietly — and the nastiest
failure is a stream that **stops sending without closing the connection**,
because nothing reports an error at all.

| Failure | Detection | Response |
|---|---|---|
| ffmpeg exits or crashes | `exit` event | Restart with backoff |
| Source goes quiet, socket stays open | watchdog: no RTP for 15 s | Restart with backoff |
| Hub WebSocket drops | `close` event | Restart (the wall no longer shows us) |
| SFU handshake fails | thrown error | Restart with backoff |
| Hub has no Realtime secrets | HTTP 503 | Restart, with a message saying what to do |

Backoff doubles from 1 s to a 30 s cap, with ±25% jitter so a dozen cameras
don't reconnect in lockstep after a router reboot. A run that stays up for 60 s
is considered healthy and resets the backoff. Teardown uses `SIGKILL`, because
a wedged ffmpeg reading a dead RTSP socket can ignore `SIGTERM` and hold the UDP
port indefinitely.

## `--dry-run`

Builds the offer, prints the SDP, counts RTP packets for three seconds, and
publishes nothing. Use it to check ffmpeg can actually read your source before
involving the network:

```
$ npm start -- --hub https://pact.lanvar.ai --name "Test" --input testsrc --dry-run

[Test] starting (udp :5004)
  [dry-run] would POST this offer to https://pact.lanvar.ai:
    ...
    a=rtpmap:96 H264/90000
    a=fmtp:96 profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1
[Test] ffmpeg -> werift OK: 803 RTP packets in 3s
```

`packetization-mode=1` in that output is what browsers require for H.264. If
you see `NO RTP received`, the problem is ffmpeg reading your input, and its
errors will be printed just above.

## Options

| Flag | |
|---|---|
| `--hub <url>` | Pact hub base URL (required) |
| `--name <text>` | Name shown on the wall |
| `--input <url>` | RTSP / RTMP / HTTP URL, file path, or `testsrc` |
| `--config <file>` | JSON array of sources; see `sources.example.json` |
| `--transcode` | Re-encode to H.264 baseline |
| `--rtsp-transport` | `tcp` (default) or `udp` |
| `--bitrate <rate>` | Target bitrate when transcoding, e.g. `2500k` |
| `--dry-run` | Print the SDP and packet count, publish nothing |

## Signals matter here

The hub decides a device is live by whether its WebSocket is open, so **the
process must actually die for the feed to leave the wall.** That makes signal
delivery load-bearing rather than cosmetic, and there are two separate ways it
goes wrong.

**Wrapper processes swallow signals.** `npm start` spawns a chain
(`npm` -> `tsx` -> `node` -> `ffmpeg`) and npm does not forward signals to its
children. `sh -c` has the same problem. Signalling the wrapper kills the wrapper
and orphans the bridge. So for anything unattended, skip npm:

```bash
npx tsx src/index.ts --hub https://pact.lanvar.ai --config sources.json
```

**On Windows, programmatic SIGINT does not work at all.** Node on Windows only
fires `process.on("SIGINT")` from a genuine console Ctrl-C; there is no way to
deliver a console control event to a detached process from a script. This is an
OS limitation, not something the code can fix. Use `taskkill` instead:

```bash
taskkill /PID <pid> /T /F        # /T includes children
```

The symptom of getting this wrong is a **phantom device stuck on the wall**:
the process is still alive, still holding its hub socket open, still pushing
media to the SFU, with no terminal attached to stop it.

What works, verified:

| | |
|---|---|
| Ctrl-C in a terminal | Clean shutdown everywhere — the TTY signals the whole process group |
| `SIGTERM` / `SIGINT` to the node process on Unix | Clean shutdown |
| systemd with `KillMode=control-group` | Clean — signals every process in the cgroup |
| `taskkill /T /F` on Windows | Feed leaves the wall immediately |
| `kill -9` / any hard kill | Feed leaves the wall immediately |

That last row is the safety net worth knowing: **you never need a graceful
shutdown to get a feed off the wall.** Killing the process closes the socket,
and the hub removes the device on the next round trip. The graceful path only
exists to make it tidy.

## Running it permanently

Nothing here daemonises itself. Use whatever your host already has. Note that
`ExecStart` invokes tsx rather than npm, per the section above.

```ini
# /etc/systemd/system/pact-bridge.service
[Unit]
Description=Pact bridge
After=network-online.target

[Service]
WorkingDirectory=/opt/pact/bridge
ExecStart=/opt/pact/bridge/node_modules/.bin/tsx src/index.ts --hub https://pact.lanvar.ai --config /etc/pact/sources.json
Restart=always
RestartSec=5
KillMode=control-group
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

In Docker use exec form — `ENTRYPOINT ["npx","tsx","src/index.ts"]`. The shell
form wraps the command in `/bin/sh -c`, which swallows signals exactly like npm.

## What is not handled

- **Audio.** Video only, deliberately. The wall's `<video>` elements are muted
  anyway, which is also what lets them autoplay.
- **Reconnect without a new session.** Every restart creates a fresh SFU
  session and a new device id, so the feed briefly leaves the wall and comes
  back rather than seamlessly resuming.
- **Adaptive bitrate.** The encoder is told one bitrate and holds it. The SFU
  forwards whatever arrives; it does not transcode down for slow viewers.
