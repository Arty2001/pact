import { Hub } from "./hub";
import { Sfu } from "./sfu";
import type { Env } from "./types";

export { Hub };

/**
 * Router.
 *
 * Static files are served by the assets binding before this ever runs, so
 * everything here is /api/*. Two groups:
 *
 *   /api/hub/*  -> forwarded to the single Hub Durable Object (control plane)
 *   /api/sfu/*  -> forwarded to Cloudflare Realtime, with our secret attached
 *
 * Media never passes through this Worker. The browser talks WebRTC straight to
 * the SFU; we only broker the SDP handshake because it needs the app secret.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith("/api/")) {
      return new Response("not found", { status: 404 });
    }

    // Lets the UI say "not configured yet" instead of failing at handshake time.
    if (path === "/api/config") {
      return Response.json({ sfuReady: Boolean(env.REALTIME_APP_ID && env.REALTIME_APP_SECRET) });
    }

    if (path.startsWith("/api/hub/")) {
      const hub = env.HUB.get(env.HUB.idFromName("wall"));
      return hub.fetch(new Request(new URL(path.slice("/api/hub".length), url), request));
    }

    if (path.startsWith("/api/sfu/")) {
      if (!env.REALTIME_APP_ID || !env.REALTIME_APP_SECRET) {
        return Response.json({ error: "Realtime SFU is not configured" }, { status: 503 });
      }
      const sfu = new Sfu(env.REALTIME_APP_ID, env.REALTIME_APP_SECRET);
      const rest = path.slice("/api/sfu".length);

      if (rest === "/sessions" && request.method === "POST") {
        return sfu.newSession();
      }

      // /sessions/:id/tracks  and  /sessions/:id/renegotiate
      const match = rest.match(/^\/sessions\/([A-Za-z0-9_-]+)\/(tracks|renegotiate)$/);
      if (match) {
        const [, sessionId, action] = match;
        const body = await request.json();
        return action === "tracks"
          ? sfu.newTracks(sessionId, body)
          : sfu.renegotiate(sessionId, body);
      }
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
