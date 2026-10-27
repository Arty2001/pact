import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { announce, type Device, type HubLink } from "./hub.ts";
import { publish, type Published } from "./publish.ts";
import { startFfmpeg, type SourceSpec } from "./source.ts";

/* ===========================================================================
   Pact bridge.

   Puts a non-browser source - an IP camera, an ESP32, an RTMP feed, a file -
   onto a Pact wall. One supervised pipeline per source:

     ffmpeg -> local UDP -> werift -> Cloudflare Realtime SFU
                                   -> Hub WebSocket (announce + liveness)

   Most of the code below is supervision rather than streaming, which is the
   honest ratio for this problem. RTSP sources are famously unreliable over
   days: cameras wedge, wifi drops, ffmpeg exits silently, and streams go
   quiet without ever closing the connection. A bridge that does not assume
   all of that will look like it works and then stop overnight.
   =========================================================================== */

/** No RTP for this long means the source is wedged, even if nothing errored. */
const STALL_TIMEOUT_MS = 15_000;
const WATCHDOG_INTERVAL_MS = 5_000;

/** A run lasting this long is considered healthy, so backoff resets. */
const HEALTHY_AFTER_MS = 60_000;

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/** RTP port per source. RTCP conventionally takes port+1, so step by 2. */
const PORT_BASE = 5004;

class Bridge {
  private ffmpeg?: ChildProcess;
  private published?: Published;
  private link?: HubLink;
  private watchdog?: NodeJS.Timeout;
  private attempt = 0;
  private startedAt = 0;
  private stopping = false;
  /** Guards against two failures racing to restart the same pipeline. */
  private cycling = false;

  constructor(
    private spec: SourceSpec,
    private hub: string,
    private port: number,
    private dryRun: boolean,
  ) {}

  async start(): Promise<void> {
    if (this.stopping) return;
    this.cycling = false;
    this.startedAt = Date.now();

    const tag = this.spec.name;
    console.log(`[${tag}] starting (udp :${this.port})`);

    try {
      // ffmpeg first: it needs somewhere to send, but UDP does not care if
      // nobody is listening yet, and starting it early means RTP is already
      // flowing by the time the SFU answers.
      this.ffmpeg = startFfmpeg(this.spec, this.port, (reason) =>
        this.fail(`ffmpeg ${reason}`),
      );

      this.published = await publish(this.hub, this.port, this.dryRun);

      if (this.dryRun) {
        // Give ffmpeg a moment to actually produce RTP, so a dry run proves
        // the media leg works and not just that the SDP parses.
        await new Promise((r) => setTimeout(r, 3000));
        const n = this.published.packets();
        console.log(
          n > 0
            ? `[${tag}] ffmpeg -> werift OK: ${n} RTP packets in 3s`
            : `[${tag}] NO RTP received - check the ffmpeg errors above`,
        );
        // stopping first, or teardown's SIGKILL would trip the restart path.
        this.stopping = true;
        await this.teardown();
        return;
      }

      const device: Device = {
        id: crypto.randomUUID(),
        name: this.spec.name,
        kind: "bridge",
        sfuSessionId: this.published.sessionId,
        trackNames: [this.published.trackName],
        since: Date.now(),
      };

      this.link = await announce(this.hub, device, (reason) => this.fail(reason));

      console.log(`[${tag}] live on the wall  session=${this.published.sessionId}`);
      this.attempt = 0;

      this.watchdog = setInterval(() => this.checkStall(), WATCHDOG_INTERVAL_MS);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * A source can stop sending without the connection ever closing - the single
   * most common way long-running RTSP pipelines die quietly. Nothing reports an
   * error, so the only way to notice is to watch for silence.
   */
  private checkStall() {
    const last = this.published?.lastPacketAt() ?? 0;
    if (last === 0) return; // Nothing has arrived yet; startup grace.
    if (Date.now() - last > STALL_TIMEOUT_MS) {
      this.fail(`no RTP for ${Math.round((Date.now() - last) / 1000)}s`);
    }
  }

  private fail(reason: string) {
    if (this.stopping || this.cycling) return;
    this.cycling = true;

    // A run that stayed up a while was healthy; do not punish it with the
    // backoff earned by a previous crash loop.
    if (Date.now() - this.startedAt > HEALTHY_AFTER_MS) this.attempt = 0;

    const delay = Math.min(BACKOFF_MIN_MS * 2 ** this.attempt, BACKOFF_MAX_MS);
    // Jitter stops several cameras from reconnecting in lockstep after a
    // router reboot and hammering the hub at the same instant.
    const jittered = Math.round(delay * (0.75 + Math.random() * 0.5));
    this.attempt++;

    console.error(`[${this.spec.name}] ${reason} - restarting in ${jittered}ms`);

    void this.teardown().then(() => {
      if (!this.stopping) setTimeout(() => void this.start(), jittered);
    });
  }

  private async teardown() {
    clearInterval(this.watchdog);
    this.watchdog = undefined;

    this.link?.close();
    this.link = undefined;

    await this.published?.close();
    this.published = undefined;

    // SIGKILL rather than SIGTERM: a wedged ffmpeg reading a dead RTSP socket
    // can ignore SIGTERM, and we would hold the UDP port forever waiting.
    this.ffmpeg?.kill("SIGKILL");
    this.ffmpeg = undefined;
  }

  async stop() {
    this.stopping = true;
    await this.teardown();
  }
}

/* ----------------------------------------------------------------- CLI --- */

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const USAGE = `
Pact bridge - put a camera, encoder or file onto a Pact wall.

  One source:
    npm start -- --hub https://pact.lanvar.ai --name "Shop" --input rtsp://10.0.0.5/stream1

  Several sources:
    npm start -- --hub https://pact.lanvar.ai --config sources.json

  No hardware needed:
    npm start -- --hub https://pact.lanvar.ai --name "Test" --input testsrc

Options
  --hub <url>        Pact hub base URL                        (required)
  --name <text>      Name shown on the wall
  --input <url>      RTSP / RTMP / HTTP URL, file path, or "testsrc"
  --no-loop          Play a file once instead of for ever (files loop by
                     default, because a wall is continuous)
  --config <file>    JSON array of sources; see sources.example.json
  --transcode        Re-encode to H.264 baseline. Needed for MJPEG and H.265.
  --rtsp-transport   tcp (default) or udp
  --bitrate <rate>   Target bitrate when transcoding, e.g. 2500k
  --dry-run          Build the offer and print the SDP, publish nothing
`;

const args = parseArgs(process.argv.slice(2));
const hub = typeof args.hub === "string" ? args.hub.replace(/\/$/, "") : "";

if (!hub || args.help) {
  console.log(USAGE);
  process.exit(args.help ? 0 : 1);
}

let specs: SourceSpec[];

if (typeof args.config === "string") {
  specs = JSON.parse(readFileSync(args.config, "utf8"));
  if (!Array.isArray(specs) || specs.length === 0) {
    console.error("config must be a non-empty JSON array of sources");
    process.exit(1);
  }
} else if (typeof args.input === "string") {
  specs = [
    {
      name: typeof args.name === "string" ? args.name : "Bridge",
      input: args.input,
      loop: args["no-loop"] === true ? false : undefined,
      transcode: args.transcode === true,
      rtspTransport: args["rtsp-transport"] === "udp" ? "udp" : "tcp",
      bitrate: typeof args.bitrate === "string" ? args.bitrate : undefined,
    },
  ];
} else {
  console.log(USAGE);
  process.exit(1);
}

const dryRun = args["dry-run"] === true;

console.log(`hub: ${hub}`);
console.log(`sources: ${specs.map((s) => s.name).join(", ")}${dryRun ? "  (dry run)" : ""}\n`);

const bridges = specs.map(
  (spec, i) => new Bridge(spec, hub, PORT_BASE + i * 2, dryRun),
);

for (const b of bridges) void b.start();

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nshutting down");
    // Closing each hub socket is what takes the feeds off the wall, so wait
    // for teardown rather than exiting straight away.
    void Promise.all(bridges.map((b) => b.stop())).then(() => process.exit(0));
  });
}
