/** What kind of thing is producing this feed. Shapes the icon and the label. */
export type DeviceKind = "camera" | "screen" | "bridge";

/**
 * One live feed on the wall.
 *
 * `sfuSessionId` + `trackNames` are the coordinates a viewer needs to pull
 * this feed from the Cloudflare Realtime SFU. They are not secret: holding
 * them lets you watch, which is the whole point of the hub.
 */
export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  sfuSessionId: string;
  trackNames: string[];
  since: number;
}

/** Hub -> client. The client never needs to ask; it is told. */
export type ServerMessage =
  | { type: "state"; devices: Device[] }
  | { type: "up"; device: Device }
  | { type: "down"; id: string };

/** Client -> Hub. Only publishers send anything. */
export type ClientMessage = { type: "publish"; device: Device };

export interface Env {
  HUB: DurableObjectNamespace;
  ENGINE: DurableObjectNamespace;
  REALTIME_APP_ID?: string;
  REALTIME_APP_SECRET?: string;
  /** Nebius Token Factory, for the planner. The teacher's copy lives in
   *  perception, because escalation needs frames and frames stay put. */
  NEBIUS_API_KEY?: string;
}
