/* ===========================================================================
   Cloudflare Realtime SFU — publish and subscribe.

   The asymmetry worth understanding before reading:

     Publishing  — WE make the offer. We hand the SFU our tracks, it answers.
     Subscribing — THE SFU makes the offer. We ask for tracks by name, it
                   replies with an offer we have to answer separately.

   That second direction is why subscribing takes an extra round trip
   (/tracks then /renegotiate) while publishing takes one.

   Media never touches our Worker. These fetches carry SDP only; the actual
   video goes browser <-> Cloudflare edge over UDP.
   =========================================================================== */

const ICE = { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] };

/** Both directions start with a session: one PeerConnection to the edge. */
async function newSession() {
  const res = await fetch("/api/sfu/sessions", { method: "POST" });
  if (!res.ok) throw new Error(`session failed (${res.status})`);
  const { sessionId } = await res.json();
  return sessionId;
}

/**
 * Resolves when ICE completes, rejects on timeout.
 *
 * Must be wired up BEFORE setRemoteDescription. ICE can finish faster than the
 * next await resumes, and a listener attached afterwards misses the event and
 * hangs forever.
 */
function iceConnected(pc, ms = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ICE timed out")), ms);

    const check = () => {
      if (pc.iceConnectionState === "connected") {
        clearTimeout(timer);
        pc.removeEventListener("iceconnectionstatechange", check);
        resolve();
      } else if (pc.iceConnectionState === "failed") {
        clearTimeout(timer);
        pc.removeEventListener("iceconnectionstatechange", check);
        reject(new Error("ICE failed"));
      }
    };

    pc.addEventListener("iceconnectionstatechange", check);
    check(); // In case it is already connected.
  });
}

/**
 * Push a local MediaStream to the SFU.
 *
 * Returns the coordinates other browsers need to pull it: our session id plus
 * one track name per track. Those go to the Hub, which hands them to viewers.
 */
export async function publish(stream) {
  const sessionId = await newSession();
  const pc = new RTCPeerConnection(ICE);

  // addTransceiver with an explicit direction rather than addTrack: the SFU
  // needs each track pinned to a known mid, and sendonly keeps it one-way.
  const transceivers = stream
    .getTracks()
    .map((track) => pc.addTransceiver(track, { direction: "sendonly" }));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const res = await fetch(`/api/sfu/sessions/${sessionId}/tracks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionDescription: { sdp: offer.sdp, type: "offer" },
      tracks: transceivers.map(({ mid, sender }) => ({
        location: "local",
        mid,
        trackName: sender.track.id,
      })),
    }),
  });

  if (!res.ok) throw new Error(`publish failed (${res.status})`);
  const answer = await res.json();
  if (answer.errorCode) throw new Error(answer.errorDescription);

  const connected = iceConnected(pc);
  await pc.setRemoteDescription(new RTCSessionDescription(answer.sessionDescription));
  await connected;

  return {
    pc,
    sessionId,
    trackNames: transceivers.map(({ sender }) => sender.track.id),
  };
}

/**
 * Pull someone else's tracks and return them as a MediaStream.
 *
 * `device.sfuSessionId` and `device.trackNames` came from the Hub over the
 * WebSocket. We open our own session and name the tracks we want.
 */
export async function subscribe(device) {
  const sessionId = await newSession();
  const pc = new RTCPeerConnection(ICE);

  const res = await fetch(`/api/sfu/sessions/${sessionId}/tracks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tracks: device.trackNames.map((trackName) => ({
        location: "remote",
        trackName,
        sessionId: device.sfuSessionId,
      })),
    }),
  });

  if (!res.ok) throw new Error(`subscribe failed (${res.status})`);
  const pull = await res.json();
  if (pull.errorCode) throw new Error(pull.errorDescription);

  // Same race as ICE above, and a worse one: setRemoteDescription fires the
  // track events synchronously. Match on mid so tracks land in a known order.
  const arriving = Promise.all(
    pull.tracks.map(
      ({ mid }) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("track timed out")), 10000);
          const onTrack = ({ transceiver, track }) => {
            if (transceiver.mid !== mid) return;
            clearTimeout(timer);
            pc.removeEventListener("track", onTrack);
            resolve(track);
          };
          pc.addEventListener("track", onTrack);
        }),
    ),
  );

  // Pulling always needs this: the SFU offered, so we answer.
  if (pull.requiresImmediateRenegotiation) {
    await pc.setRemoteDescription(new RTCSessionDescription(pull.sessionDescription));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    const reneg = await fetch(`/api/sfu/sessions/${sessionId}/renegotiate`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionDescription: { sdp: answer.sdp, type: "answer" } }),
    }).then((r) => r.json());

    if (reneg.errorCode) throw new Error(reneg.errorDescription);
  }

  const stream = new MediaStream();
  for (const track of await arriving) stream.addTrack(track);
  return { pc, stream };
}
