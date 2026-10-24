/**
 * Hub WebSocket client.
 *
 * Exactly the same contract the browser publisher uses: open a socket, send one
 * `publish` message, keep it open. The hub derives its live device list from
 * open publisher sockets, so this socket IS the liveness signal - when it
 * closes, the feed leaves the wall. No heartbeat to send.
 */

export interface Device {
  id: string;
  name: string;
  kind: "camera" | "screen" | "bridge";
  sfuSessionId: string;
  trackNames: string[];
  since: number;
}

export interface HubLink {
  ws: WebSocket;
  close: () => void;
}

export function announce(
  hub: string,
  device: Device,
  onLost: (reason: string) => void,
): Promise<HubLink> {
  const url = `${hub.replace(/^http/, "ws")}/api/hub/ws`;
  const ws = new WebSocket(url);

  let settled = false;
  let closedByUs = false;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error("hub connection timed out"));
      }
    }, 10000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "publish", device }));
      clearTimeout(timer);
      settled = true;
      resolve({
        ws,
        close: () => {
          closedByUs = true;
          try { ws.close(); } catch { /* ignore */ }
        },
      });
    });

    ws.addEventListener("error", () => {
      if (!settled) {
        clearTimeout(timer);
        settled = true;
        reject(new Error(`could not reach hub at ${url}`));
      }
    });

    // Losing this socket means the wall no longer believes the device is live,
    // so the supervisor rebuilds the whole feed rather than limping on.
    ws.addEventListener("close", () => {
      if (settled && !closedByUs) onLost("hub socket closed");
    });
  });
}
