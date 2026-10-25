/**
 * The old way, drawn honestly: every frame to a hosted frontier model.
 *
 * This is the argument the whole film rests on, and it was previously five
 * rectangles and a counter. It is now the actual mechanism - frames leaving
 * the camera one at a time, each one a request, each request a charge, and
 * the charge compounding through a ladder of multiplications that a viewer
 * can check.
 *
 * Every number here is derived from one measured figure in the repo: a
 * frontier VLM on every frame at the rate a rep needs is $421 a day per
 * camera. Everything else is that divided back down:
 *
 *     8 fps x 86,400 s  = 691,200 frames a day
 *     $421 / 691,200    = $0.000609 a frame
 *     x 8               = $0.00487 a second
 *     x 3,600           = $17.54 an hour
 *     x 24              = $421 a day
 *
 * The per-frame figure lands within a hundredth of a cent of the measured
 * teacher call in the repo, which is the same kind of call. That agreement is
 * why the ladder is worth showing: a viewer who checks it finds it holds.
 *
 * Nothing here is in hue. This is the status quo, and the first colour in the
 * film belongs to the product.
 */

import React from "react";
import { useCurrentFrame, interpolate } from "remotion";
import { C, F, R } from "../../lib/theme";
import { inOut, Mono, Pane, CountUp } from "../../lib/prims";
import { FootageSlot } from "../../lib/footage";

const PER_FRAME = 0.000609;

/** One sampled frame, in flight from the camera to the endpoint. */
const FRAMES_PER_SPAWN = 6;
const TRAVEL = 26;
const X0 = 372;
const X1 = 742;

export const CostStream: React.FC<{ at: number }> = ({ at }) => {
  const f = useCurrentFrame();
  const t = f - at;

  /** How many frames have been sampled so far. Drives everything downstream. */
  const sampled = Math.max(0, Math.floor(t / FRAMES_PER_SPAWN));
  /** How many have landed, and therefore been billed. */
  const billed = Math.max(0, Math.floor((t - TRAVEL) / FRAMES_PER_SPAWN));
  const spent = billed * PER_FRAME;

  /** The frames currently between the camera and the endpoint. */
  const inFlight = [];
  for (let i = Math.max(0, sampled - 8); i <= sampled; i++) {
    const age = t - i * FRAMES_PER_SPAWN;
    if (age < 0 || age > TRAVEL) continue;
    inFlight.push({ i, p: age / TRAVEL });
  }

  /** The last few charges, newest at the bottom. */
  const ledger = [];
  for (let i = Math.max(0, billed - 6); i < billed; i++) ledger.push(i);

  const pulse = billed > 0 && (t - TRAVEL) % FRAMES_PER_SPAWN < 2;

  return (
    <div style={{ width: 1720 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 30 }}>
        {/* The camera, and what it is being asked to do. */}
        <div style={{ width: 342, flexShrink: 0 }}>
          <FootageSlot shot={1} note="any room" at={at} w={342} h={216} radius={R.r} />
          <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Tag at={at + 8}>8 fps</Tag>
            <Tag at={at + 12}>1920×1080</Tag>
            <Tag at={at + 16}>every frame</Tag>
          </div>
          <div style={{ marginTop: 10 }}>
            <Mono size={18} color={C.dimmer}>
              sampled{" "}
              <span style={{ color: C.fg, fontWeight: 700 }}>
                {sampled.toLocaleString("en-US")}
              </span>
            </Mono>
          </div>
        </div>

        {/* The wire. One request per frame, and you can count them. */}
        <div style={{ position: "relative", width: 400, height: 216, flexShrink: 0 }}>
          <svg width="400" height="216" style={{ position: "absolute", inset: 0 }}>
            <line
              x1="0"
              x2="400"
              y1="108"
              y2="108"
              stroke={C.hair}
              strokeWidth="2"
              strokeDasharray="5 7"
            />
          </svg>
          {inFlight.map(({ i, p }) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: p * 330,
                top: 86,
                width: 64,
                height: 40,
                borderRadius: 4,
                background: "repeating-linear-gradient(135deg, #1B2B37 0 7px, #16242F 7px 14px)",
                border: `1px solid ${C.line}`,
                display: "grid",
                placeItems: "center",
                opacity: p > 0.88 ? (1 - p) / 0.12 : 1,
              }}
            >
              <span style={{ fontFamily: F.mono, fontSize: 13, color: C.dimmer }}>
                {String(i).padStart(4, "0")}
              </span>
            </div>
          ))}
          <div style={{ position: "absolute", left: 96, top: 142 }}>
            <Mono size={17} color={C.dimmer}>
              one request per frame
            </Mono>
          </div>
        </div>

        {/* The endpoint. Named as what it is, and billed as what it costs. */}
        <Pane pad={24} style={{ width: 430, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                background: pulse ? C.fg : C.line,
              }}
            />
            <Mono size={19} color={C.dim} style={{ fontWeight: 700 }}>
              frontier VLM · hosted
            </Mono>
          </div>
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 9 }}>
            <Row k="POST" v="/v1/chat/completions" />
            <Row k="image_tokens" v="1,105" />
            <Row k="latency" v="840 ms" />
            <Row k="per call" v="$0.00061" strong />
          </div>
        </Pane>

        {/* The bill, accumulating one line at a time. */}
        <div style={{ flex: 1, minWidth: 420 }}>
          <Mono size={18} color={C.dimmer}>
            billed
          </Mono>
          <div
            style={{
              marginTop: 10,
              height: 158,
              display: "flex",
              flexDirection: "column",
              justifyContent: "flex-end",
              gap: 4,
              overflow: "hidden",
            }}
          >
            {ledger.map((i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between" }}>
                <Mono size={17} color={C.dimmer}>
                  frame {String(i).padStart(4, "0")}
                </Mono>
                <Mono size={17} color={C.dim}>
                  +$0.00061
                </Mono>
              </div>
            ))}
          </div>
          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: `1px solid ${C.line}`,
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
            }}
          >
            <Mono size={19} color={C.dim}>
              this clip
            </Mono>
            <span
              style={{
                fontFamily: F.mono,
                fontSize: 42,
                fontWeight: 700,
                color: C.fg,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              ${spent.toFixed(4)}
            </span>
          </div>
        </div>
      </div>

      {/* The ladder. Four multiplications, each one checkable. */}
      <div style={{ marginTop: 44, display: "flex", alignItems: "center", justifyContent: "center", gap: 0 }}>
        <Rung at={at + 96} value="$0.00061" label="a frame" />
        <Mult at={at + 108} by="× 8 fps" />
        <Rung at={at + 116} value="$0.0049" label="a second" />
        <Mult at={at + 128} by="× 3,600" />
        <Rung at={at + 136} value="$17.54" label="an hour" />
        <Mult at={at + 148} by="× 24" />
        <Rung at={at + 156} value="$421" label="a day · one camera" big />
      </div>
    </div>
  );
};

const Tag: React.FC<{ at: number; children: React.ReactNode }> = ({ at, children }) => {
  const f = useCurrentFrame();
  return (
    <span
      style={{
        opacity: inOut(f, at, 12),
        padding: "5px 11px",
        borderRadius: 999,
        background: C.sunk,
        border: `1px solid ${C.hair}`,
        fontFamily: F.mono,
        fontSize: 16,
        color: C.dim,
      }}
    >
      {children}
    </span>
  );
};

const Row: React.FC<{ k: string; v: string; strong?: boolean }> = ({ k, v, strong }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
    <Mono size={17} color={C.dimmer}>
      {k}
    </Mono>
    <Mono size={strong ? 21 : 17} color={strong ? C.fg : C.dim} style={{ fontWeight: strong ? 700 : 400 }}>
      {v}
    </Mono>
  </div>
);

const Rung: React.FC<{ at: number; value: string; label: string; big?: boolean }> = ({
  at,
  value,
  label,
  big,
}) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 16);
  return (
    <div
      style={{
        opacity: p,
        transform: `translateY(${(1 - p) * 14}px)`,
        padding: big ? "20px 34px" : "20px 26px",
        borderRadius: R.r2,
        background: big ? C.badWash : C.sunk,
        border: `${big ? 2 : 1}px solid ${big ? C.badEdge : C.hair}`,
        textAlign: "center",
        minWidth: big ? 300 : 190,
      }}
    >
      <div
        style={{
          fontFamily: F.mono,
          fontSize: big ? 58 : 34,
          fontWeight: 700,
          letterSpacing: -1.5,
          color: big ? C.badText : C.fg,
          lineHeight: 1.05,
        }}
      >
        {value}
      </div>
      <div style={{ marginTop: 6 }}>
        <Mono size={big ? 19 : 17} color={big ? C.badText : C.dimmer}>
          {label}
        </Mono>
      </div>
    </div>
  );
};

const Mult: React.FC<{ at: number; by: string }> = ({ at, by }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 12);
  return (
    <div
      style={{
        opacity: p,
        display: "flex",
        alignItems: "center",
        padding: "0 16px",
      }}
    >
      <Mono size={18} color={C.dimmer}>
        {by}
      </Mono>
    </div>
  );
};
