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
  /**
   * The slug a goal's skills are scoped to, and the key every score is
   * reported under.
   *
   * Derived from the name rather than the id, so re-joining with the same
   * device name lands in the same room and keeps the calibration fitted
   * from that room's background - which is what reconnecting a phone is
   * expected to do. Set by the Hub so there is one definition of it: the
   * browser and perception both need this slug, and three independent
   * implementations of one rule is three chances to disagree about which
   * camera a score belongs to.
   */
  room: string;
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
/**
 * A publisher announcing itself. It does not send `room` - the Hub stamps
 * that - so saying it does would be a type that lies about the wire.
 */
export type ClientMessage = { type: "publish"; device: Omit<Device, "room"> };

export interface Env {
  HUB: DurableObjectNamespace;
  ENGINE: DurableObjectNamespace;
  REALTIME_APP_ID?: string;
  REALTIME_APP_SECRET?: string;
  /** Nebius Token Factory, for the planner. The teacher's copy lives in
   *  perception, because escalation needs frames and frames stay put. */
  NEBIUS_API_KEY?: string;
  /**
   * The encoder's machine, started when a camera arrives and stopped when
   * the last one leaves.
   *
   * Separate from NEBIUS_API_KEY on purpose: that one buys tokens from the
   * inference API and this one can stop a virtual machine, which is a very
   * different thing to leak. Absent means the feature is off and the
   * encoder is assumed to be running somewhere already - which is exactly
   * the laptop case, so nothing breaks by not setting them.
   */
  NEBIUS_INSTANCE_ID?: string;
  NEBIUS_COMPUTE_TOKEN?: string;
}
