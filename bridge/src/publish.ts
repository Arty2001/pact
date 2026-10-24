import { createSocket, type Socket } from "node:dgram";
import { MediaStreamTrack, RTCPeerConnection, useH264 } from "werift";

/**
 * Publishes RTP arriving on a local UDP port into a Pact hub.
 *
 * This is the Node equivalent of public/js/sfu-client.js, and it exists because
 * Cloudflare Realtime SFU does not speak WHIP - it has its own sessions/tracks
 * API, so there is no `ffmpeg -f whip` shortcut. The signaling sequence here is
 * identical to the browser's publish path:
 *
 *   1. POST /api/sfu/sessions                -> sessionId
 *   2. build an offer with one sendonly track
 *   3. POST /api/sfu/sessions/:id/tracks     -> answer
 *   4. setRemoteDescription(answer)
 *
 * The one thing Node needs that the browser does not: we must wait for ICE
 * gathering to finish before sending the offer, because the SFU expects a
 * complete description rather than trickled candidates.
 */

/** Must match ffmpeg's -payload_type. */
const PAYLOAD_TYPE = 96;

export interface Published {
  pc: RTCPeerConnection;
  udp: Socket;
  sessionId: string;
  trackName: string;
  /** Epoch ms of the last RTP packet seen. The watchdog reads this. */
  lastPacketAt: () => number;
  /** Total RTP packets forwarded. Used by --dry-run to prove ffmpeg works. */
  packets: () => number;
  close: () => Promise<void>;
}

export async function publish(
  hub: string,
  port: number,
  dryRun = false,
): Promise<Published> {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    codecs: {
      video: [
        useH264({
          payloadType: PAYLOAD_TYPE,
          clockRate: 90000,
          rtcpFeedback: [
            { type: "nack" },
            { type: "nack", parameter: "pli" },
            { type: "goog-remb" },
          ],
        }),
      ],
    },
  });

  const trackName = `bridge-${crypto.randomUUID().slice(0, 8)}`;
  const track = new MediaStreamTrack({ kind: "video", id: trackName });
  const transceiver = pc.addTransceiver(track, { direction: "sendonly" });

  // Receive RTP from ffmpeg and hand each packet straight to the track. No
  // decode, no re-packetise: the bytes ffmpeg produced are the bytes that
  // reach the viewer's browser.
  let lastPacketAt = 0;
  let packets = 0;
  const udp = createSocket("udp4");
  udp.on("message", (data) => {
    lastPacketAt = Date.now();
    packets++;
    track.writeRtp(data);
  });
  await new Promise<void>((resolve, reject) => {
    udp.once("error", reject);
    udp.bind(port, "127.0.0.1", resolve);
  });

  const close = async () => {
    try { udp.close(); } catch { /* already closed */ }
    try { await pc.close(); } catch { /* already closed */ }
  };

  try {
    const offer = await pc.setLocalDescription(await pc.createOffer());
    await iceGathered(pc);

    if (dryRun) {
      console.log(`  [dry-run] would POST this offer to ${hub}:\n`);
      console.log(
        (pc.localDescription?.sdp ?? offer.toString())
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
      );
      return {
        pc, udp, sessionId: "dry-run", trackName,
        lastPacketAt: () => lastPacketAt, packets: () => packets, close,
      };
    }

    const session = await post(`${hub}/api/sfu/sessions`);
    const { sessionId } = (await json(session, "create session")) as { sessionId: string };

    const res = await post(`${hub}/api/sfu/sessions/${sessionId}/tracks`, {
      sessionDescription: { sdp: pc.localDescription!.sdp, type: "offer" },
      tracks: [{ location: "local", mid: transceiver.mid, trackName }],
    });
    const answer = (await json(res, "publish tracks")) as {
      sessionDescription?: { sdp: string; type: string };
      errorDescription?: string;
    };
    if (answer.errorDescription) throw new Error(answer.errorDescription);
    if (!answer.sessionDescription) throw new Error("SFU returned no answer");

    await pc.setRemoteDescription({
      sdp: answer.sessionDescription.sdp,
      type: "answer",
    });

    return {
      pc, udp, sessionId, trackName,
      lastPacketAt: () => lastPacketAt, packets: () => packets, close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

/**
 * Wait until ICE has gathered every candidate.
 *
 * The listener is attached before the state is read, for the same reason the
 * browser client does it: gathering may already be complete, in which case no
 * further event is coming and a naive wait hangs forever.
 */
function iceGathered(pc: RTCPeerConnection, ms = 10000): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ICE gathering timed out")), ms);
    pc.iceGatheringStateChange.subscribe((state) => {
      if (state === "complete") {
        clearTimeout(timer);
        resolve();
      }
    });
    // Re-check after subscribing, in case it completed in between.
    if (pc.iceGatheringState === "complete") {
      clearTimeout(timer);
      resolve();
    }
  });
}

function post(url: string, body?: unknown) {
  return fetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function json(res: Response, what: string) {
  if (res.ok) return res.json();

  // 503 means the hub is up but has no Realtime credentials, which is a
  // configuration problem rather than a bridge problem. Say so.
  if (res.status === 503) {
    throw new Error(
      `${what}: the hub has no Cloudflare Realtime credentials set. ` +
        `Run 'wrangler secret put REALTIME_APP_ID' and REALTIME_APP_SECRET.`,
    );
  }
  throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}
