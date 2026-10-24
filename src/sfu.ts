/**
 * Thin client for the Cloudflare Realtime SFU.
 *
 * Every method here is a pass-through: the browser builds the SDP, we forward
 * it, we hand back the answer. The only thing this file adds is the app secret,
 * which is why these calls go through the Worker instead of straight from the
 * browser to Cloudflare.
 */

const BASE = "https://rtc.live.cloudflare.com/v1/apps";

export class Sfu {
  constructor(
    private appId: string,
    private appSecret: string,
  ) {}

  private call(path: string, method: "POST" | "PUT", body?: unknown) {
    return fetch(`${BASE}/${this.appId}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.appSecret}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** Allocate a session. One session per browser tab, publisher or viewer. */
  newSession() {
    return this.call("/sessions/new", "POST");
  }

  /**
   * Add tracks to a session.
   *
   * Publishing: body carries our offer plus `location: "local"` tracks, and the
   * response is the answer.
   *
   * Subscribing: body carries only `location: "remote"` tracks, and the SFU
   * replies with its *own* offer that we have to answer via renegotiate().
   */
  newTracks(sessionId: string, body: unknown) {
    return this.call(`/sessions/${sessionId}/tracks/new`, "POST", body);
  }

  /** Answer the offer the SFU sent us when we subscribed. */
  renegotiate(sessionId: string, body: unknown) {
    return this.call(`/sessions/${sessionId}/renegotiate`, "PUT", body);
  }
}
