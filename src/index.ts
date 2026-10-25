import { Engine } from "./goals/engine.ts";
import { Hub } from "./hub.ts";
import { Sfu } from "./sfu.ts";
import type { Env } from "./types.ts";

export { Engine, Hub };

/**
 * Router.
 *
 * Static files are served by the assets binding before this ever runs, so
 * everything here is /api/*. Two groups:
 *
 *   /api/hub/*     -> the Hub Durable Object: who is live right now
 *   /api/sfu/*     -> Cloudflare Realtime, with our secret attached
 *   /api/engine/*  -> the Engine Durable Object: goals, skills, the ledger
 *   /api/frames/*  -> a sampled JPEG on its way to perception
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

    // Frames and the goal ledger both live in the Engine. Frames are a
    // separate prefix only because the publisher posts them to a URL it
    // builds itself, and a short one is easier to read in a trace.
    if (path.startsWith("/api/engine/") || path.startsWith("/api/frames/")) {
      const engine = env.ENGINE.get(env.ENGINE.idFromName("engine"));
      const rest = path.startsWith("/api/engine")
        ? path.slice("/api/engine".length)
        : path.slice("/api".length);
      return engine.fetch(new Request(new URL(rest, url), request));
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
