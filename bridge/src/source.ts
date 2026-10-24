import { type ChildProcess, spawn } from "node:child_process";

export interface SourceSpec {
  /** Name shown on the wall. */
  name: string;
  /** RTSP / RTMP / HTTP URL, a local file path, or the literal "testsrc". */
  input: string;
  /** Re-encode to H.264 baseline. Required for MJPEG, H.265, or anything odd. */
  transcode?: boolean;
  /** RTSP over TCP avoids packet loss on flaky wifi. Defaults to tcp. */
  rtspTransport?: "tcp" | "udp";
  /** Target bitrate when transcoding. */
  bitrate?: string;
}

/**
 * ffmpeg arguments.
 *
 * We send RTP to a local UDP port and let werift pick it up, which avoids
 * decoding video in Node entirely. Two paths:
 *
 *   copy      - the source is already H.264, so just re-packetise it. Nearly
 *               free: no decode, no encode.
 *   transcode - the source is MJPEG, H.265, or otherwise unplayable in a
 *               browser. Costs real CPU per stream.
 */
export function ffmpegArgs(spec: SourceSpec, port: number): string[] {
  const input: string[] =
    spec.input === "testsrc"
      ? ["-re", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30"]
      : spec.input.startsWith("rtsp://")
        ? ["-rtsp_transport", spec.rtspTransport ?? "tcp", "-i", spec.input]
        : ["-re", "-i", spec.input];

  // testsrc is raw frames, so it always needs encoding regardless of the flag.
  const encode: string[] =
    spec.transcode || spec.input === "testsrc"
      ? [
          "-c:v", "libx264",
          "-preset", "veryfast",
          // No B-frames, no lookahead. Both add latency we cannot spend.
          "-tune", "zerolatency",
          // Baseline is the widest browser support.
          "-profile:v", "baseline",
          "-level", "3.1",
          "-pix_fmt", "yuv420p",
          // Keyframe every ~1s. Also what makes 1 fps frame sampling cheap
          // downstream, since every keyframe is independently decodable.
          "-g", "30",
          "-b:v", spec.bitrate ?? "1500k",
          "-maxrate", spec.bitrate ?? "1500k",
          "-bufsize", "3000k",
        ]
      : ["-c:v", "copy"];

  return [
    "-hide_banner",
    "-loglevel", "warning",
    ...input,
    // Audio is dropped on purpose: a wall of microphones is unusable, and the
    // wall's <video> elements are muted anyway so autoplay works.
    "-an",
    ...encode,
    "-f", "rtp",
    // Must match the payload type werift advertises in its SDP.
    "-payload_type", "96",
    // Keep RTP packets under the MTU. Oversized packets are silently dropped
    // somewhere in the path and the feed just never appears.
    `rtp://127.0.0.1:${port}?pkt_size=1200`,
  ];
}

/** Spawns ffmpeg and reports when it dies. Restart policy lives in index.ts. */
export function startFfmpeg(
  spec: SourceSpec,
  port: number,
  onExit: (reason: string) => void,
): ChildProcess {
  const args = ffmpegArgs(spec, port);
  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) console.error(`  ffmpeg[${spec.name}] ${line}`);
  });

  proc.on("error", (err) => onExit(`spawn failed: ${err.message}`));
  proc.on("exit", (code, signal) =>
    onExit(signal ? `killed by ${signal}` : `exited with code ${code}`),
  );

  return proc;
}
