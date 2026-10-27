/**
 * Beat 5 - most of it never happens. 1:17 to 1:34.
 *
 * "And that tree has a hierarchy. A still room doesn't even send a frame. When
 *  you walk in, one sub-goal passes and wakes the one beneath it. Everything
 *  else stays asleep, never scored. It only works as hard as it needs to."
 *
 * One continuous shot, because the claim is about one continuous thing. The
 * tree from beat 4 is still on screen - same nodes, same order - and the only
 * new element is the strip along the bottom, which marks every frame the
 * system actually sent.
 *
 * That strip is the beat. Before anyone walks in, the marks are 2 seconds
 * apart; afterwards they are every half second, and the density change is
 * visible from across a room. It is drawn from the same schedule the engine
 * uses - idle_hz 0.5, and 2 Hz for a woken skill - so it is a picture of the
 * behaviour rather than an illustration of it.
 *
 * The two rows that stay grey are doing the other half of the work: the goals
 * they belong to are still active, and they are still never scored.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, F, R } from "../lib/theme";
import { Rise, Mono, inOut, Eyebrow, Chip, Fit } from "../lib/prims";
import { FootageSlot, WatchFrame } from "../lib/footage";
import { timing } from "../lib/beats";

const t = timing("b5");

const LEN = 435;
const WAKE = t("walkIn");
const IDLE_HZ = 0.5;
const LIVE_HZ = 2;

/** Every frame the engine would actually have sent, on this schedule. */
const SENT: number[] = (() => {
  const out: number[] = [];
  let fr = 6;
  while (fr < LEN) {
    out.push(Math.round(fr));
    fr += 30 / (fr < WAKE ? IDLE_HZ : LIVE_HZ);
  }
  return out;
})();

type Row = {
  label: string;
  kind: string;
  indent: number;
  /** When this row stops being asleep, if it ever does. */
  wake?: number;
  /** When it reaches its own conclusion. */
  pass?: number;
};

const ROWS: Row[] = [
  { label: "someone in a room", kind: "gate", indent: 0, wake: 0, pass: t("passes") },
  { label: "someone in a pushup position", kind: "action", indent: 34, wake: t("wakes") },
  { label: "20 of them", kind: "counter", indent: 34 },
  { label: "dishes in the sink", kind: "object", indent: 34 },
  { label: "a book open", kind: "object", indent: 34 },
];

const Node: React.FC<{ row: Row; at: number; cold: boolean }> = ({ row, at, cold }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 16);

  const woken = row.wake !== undefined && f >= row.wake;
  const passed = row.pass !== undefined && f >= row.pass;

  const tone = passed ? "proved" : woken ? "watch" : "none";
  const kit =
    tone === "proved"
      ? { wash: C.provedWash, edge: C.provedEdge, solid: C.proved, text: C.provedText }
      : tone === "watch"
        ? { wash: C.watchWash, edge: C.watchEdge, solid: C.watch, text: C.watchText }
        : { wash: C.sunk, edge: C.hair, solid: C.dimmer, text: C.dimmer };

  // The woken row lands with a little weight; asleep rows never move.
  const kick = woken ? inOut(f, row.wake!, 12) : 0;

  return (
    <div
      style={{
        opacity: p * (woken || passed ? 1 : cold ? 0.4 : 0.62),
        transform: `translate(${row.indent}px, ${(1 - p) * 12}px) scale(${1 + kick * 0.012})`,
        width: 700 - row.indent,
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "15px 20px",
        marginBottom: 9,
        borderRadius: R.r,
        background: kit.wash,
        border: `1px solid ${kit.edge}`,
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: 999,
          background: kit.solid,
          flexShrink: 0,
          boxShadow:
            tone === "watch"
              ? `0 0 0 ${3 + 2.5 * Math.abs(Math.sin(f / 16))}px ${C.watchWash}`
              : "none",
        }}
      />
      <span
        style={{
          flex: 1,
          fontFamily: F.ui,
          fontSize: 24,
          color: C.fg,
          fontWeight: 500,
          letterSpacing: -0.5,
          whiteSpace: "nowrap",
        }}
      >
        {row.label}
      </span>
      <Mono size={16} color={C.dimmer}>
        {row.kind}
      </Mono>
      <Mono size={17} color={kit.text} style={{ fontWeight: 700, width: 96, textAlign: "right" }}>
        {passed ? "passed" : woken ? "watching" : "asleep"}
      </Mono>
    </div>
  );
};

/** Every frame the system sent, as a mark on a 16-second strip. */
const SentStrip: React.FC<{ at: number }> = ({ at }) => {
  const f = useCurrentFrame();
  const W = 1480;
  const p = inOut(f, at, 16);
  const hz = f < WAKE ? IDLE_HZ : LIVE_HZ;

  return (
    <div style={{ opacity: p, width: W }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 12 }}>
        <Mono size={18} color={C.dimmer}>
          frames actually sent
        </Mono>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
          <Mono size={18} color={C.dimmer}>
            sample rate
          </Mono>
          <Mono
            size={26}
            color={hz > IDLE_HZ ? C.watchText : C.dimmer}
            style={{ fontWeight: 700 }}
          >
            {hz.toFixed(1)} Hz
          </Mono>
        </span>
      </div>

      <div
        style={{
          position: "relative",
          height: 64,
          borderRadius: R.r,
          background: C.sunk,
          border: `1px solid ${C.hair}`,
          overflow: "hidden",
        }}
      >
        {/* Where the rate changes, and why. */}
        <div
          style={{
            position: "absolute",
            left: (WAKE / LEN) * W,
            top: 0,
            bottom: 0,
            width: 1.5,
            background: C.watch,
            opacity: f >= WAKE ? 0.7 : 0,
          }}
        />
        {SENT.map((s) => {
          const seen = f >= s;
          const fresh = Math.max(0, 1 - (f - s) / 10);
          const dense = s >= WAKE;
          return (
            <div
              key={s}
              style={{
                position: "absolute",
                left: (s / LEN) * W,
                top: dense ? 10 : 20,
                bottom: dense ? 10 : 20,
                width: 2,
                background: dense ? C.watch : C.dimmer,
                opacity: seen ? 0.42 + fresh * 0.58 : 0,
              }}
            />
          );
        })}
        {/* The playhead, so the marks read as a recording rather than a chart. */}
        <div
          style={{
            position: "absolute",
            left: (Math.min(f, LEN) / LEN) * W,
            top: 0,
            bottom: 0,
            width: 1,
            background: C.fg,
            opacity: 0.22,
          }}
        />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}>
        <Mono size={16} color={C.dimmer}>
          one frame every 2 s · nothing in the room
        </Mono>
        <Mono size={16} color={f >= WAKE ? C.watchText : "transparent"}>
          one frame every 0.5 s · a gate is open
        </Mono>
      </div>
    </div>
  );
};

export const S5Most: React.FC = () => {
  const f = useCurrentFrame();
  const cold = f >= t("asleep");

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <Fit s={1.12}>
      <div style={{ width: 1480 }}>
        <div style={{ display: "flex", gap: 48, alignItems: "flex-start" }}>
          {/* The room, which is the input. */}
          <div style={{ position: "relative" }}>
            <FootageSlot
              shot={1}
              note="living room — empty, then someone walks in"
              at={t("hierarchy")}
              w={640}
              h={400}
              src="room_walkin.mp4"
            />
            {f >= WAKE && <WatchFrame at={WAKE} inset={0} />}
            <div
              style={{
                position: "absolute",
                left: 16,
                top: 16,
                display: "flex",
                gap: 10,
                alignItems: "center",
              }}
            >
              {f < WAKE ? (
                <Chip label="idle · 0.5 Hz" tone="none" mono size={17} />
              ) : (
                <Chip label="awake · 2 Hz" tone="watch" mono size={17} />
              )}
            </div>
          </div>

          {/* The tree, which is the thing being woken. */}
          <div style={{ flex: 1 }}>
            <Eyebrow at={t("hierarchy")}>the tree has a hierarchy</Eyebrow>
            {ROWS.map((r, i) => (
              <Node key={r.label} row={r} at={t("hierarchy") + 6 + i * 6} cold={cold} />
            ))}

            {/* Named only once it is visibly true. */}
            <Rise at={t("neverScored")} style={{ marginTop: 6 }} y={14}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginLeft: 34 }}>
                <span style={{ width: 26, height: 1, background: C.line }} />
                <Mono size={19} color={C.dimmer}>
                  3 of 5 asleep · never scored
                </Mono>
              </div>
            </Rise>
          </div>
        </div>

        <div style={{ marginTop: 34 }}>
          <SentStrip at={t("stillRoom")} />
        </div>

        <Rise at={t("asHard")} style={{ marginTop: 26, textAlign: "center" }} y={18}>
          <div
            style={{
              fontFamily: F.display,
              fontSize: 42,
              fontWeight: 600,
              color: C.fg,
              letterSpacing: -1.2,
            }}
          >
            It only works as hard as it needs to.
          </div>
        </Rise>
      </div>
      </Fit>
    </AbsoluteFill>
  );
};
