import type { ClientMessage, Device, Env, ServerMessage } from "./types";

/** Claim codes are short-lived on purpose: scan it now or get a new one. */
const CLAIM_TTL_MS = 10 * 60 * 1000;

/** Attached to each WebSocket. Survives hibernation. */
type SocketMeta = { role: "viewer" } | { role: "publisher"; device: Device };

/**
 * The Hub is the control plane, and there is exactly one of them.
 *
 * It answers one question — "what is live right now?" — for every connected
 * browser, and it keeps the answer consistent because a Durable Object is
 * single-threaded and has one address.
 *
 * The important design choice: there is no device table. The live set is
 * *derived* from the publisher WebSockets that are currently open. A publisher
 * holds its socket open for as long as it is streaming, so socket-open and
 * device-live are the same fact, stored once. Nothing to expire, nothing to
 * reconcile, and no way to leak a device that is no longer there.
 */
export class Hub implements DurableObject {
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}

  // ---------------------------------------------------------------- routing

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const [client, server] = Object.values(new WebSocketPair());

      // Hibernation: the runtime may evict this object from memory while the
      // socket stays open, then re-run the constructor on the next event.
      // That is why all per-socket state lives on the socket itself.
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ role: "viewer" } satisfies SocketMeta);

      this.send(server, { type: "state", devices: this.devices() });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/devices") {
      return Response.json({ devices: this.devices() });
    }

    if (url.pathname === "/claim" && request.method === "POST") {
      const code = newCode();
      await this.ctx.storage.put(`claim:${code}`, Date.now() + CLAIM_TTL_MS);
      return Response.json({ code, expiresInMs: CLAIM_TTL_MS });
    }

    if (url.pathname === "/redeem" && request.method === "POST") {
      const { code } = (await request.json()) as { code?: string };
      const key = `claim:${(code ?? "").toUpperCase()}`;
      const expiresAt = await this.ctx.storage.get<number>(key);

      if (expiresAt === undefined) {
        return Response.json({ ok: false, reason: "unknown" }, { status: 404 });
      }
      if (Date.now() > expiresAt) {
        await this.ctx.storage.delete(key);
        return Response.json({ ok: false, reason: "expired" }, { status: 410 });
      }
      // Single use. Redeeming it burns it.
      await this.ctx.storage.delete(key);
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  }

  // ------------------------------------------------------------- websockets

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "publish") {
      // This socket is now the liveness signal for this device.
      ws.serializeAttachment({
        role: "publisher",
        device: msg.device,
      } satisfies SocketMeta);
      this.broadcast({ type: "up", device: msg.device }, ws);
    }
  }

  webSocketClose(ws: WebSocket) {
    this.onGone(ws);
  }

  webSocketError(ws: WebSocket) {
    this.onGone(ws);
  }

  /** A socket went away. If it was publishing, its feed is over. */
  private onGone(ws: WebSocket) {
    const meta = this.metaOf(ws);
    if (meta?.role === "publisher") {
      this.broadcast({ type: "down", id: meta.device.id }, ws);
    }
  }

  // ----------------------------------------------------------------- helpers

  /** The live set, derived from open sockets. This is the whole registry. */
  private devices(): Device[] {
    return this.ctx
      .getWebSockets()
      .map((ws) => this.metaOf(ws))
      .filter((m): m is Extract<SocketMeta, { role: "publisher" }> => m?.role === "publisher")
      .map((m) => m.device)
      .sort((a, b) => a.since - b.since);
  }

  private metaOf(ws: WebSocket): SocketMeta | null {
    try {
      return (ws.deserializeAttachment() as SocketMeta) ?? null;
    } catch {
      return null;
    }
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket raced us and closed. The close handler will clean up.
    }
  }

  /** Tell everyone except `except` (usually the socket that caused the event). */
  private broadcast(msg: ServerMessage, except?: WebSocket) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== except) this.send(ws, msg);
    }
  }
}

/** Four characters, no vowels and no 0/O/1/I, so it survives being read aloud. */
function newCode(): string {
  const alphabet = "23456789BCDFGHJKLMNPQRSTVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}
