/**
 * Beat 4 - fifty cost what one costs. 1:03 to 1:21.
 *
 * Beat 3 ended on one comparison. This beat is its consequence: the frame is
 * encoded once, and every sub-goal after that is another comparison against
 * that same vector. So the count of things being watched climbs while the
 * encoder cost sits at one - drawn as a fan, because a fan is what it is.
 *
 * Then reuse, which is the same argument one level up: goals do not own
 * sub-goals, they reference them, so the second goal in a room mostly
 * attaches to things that already exist. The graph belongs here rather than
 * in beat 3 - reuse is a cost argument, not a creation one.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, F, R, s } from "../lib/theme";
import { Rise, Mono, inOut, outIn, Eyebrow, DrawArrow, Phase } from "../lib/prims";

const SUBGOALS = [
  "someone in a room",
  "someone in a pushup position",
  "at the kitchen sink",
  "dishes in the sink",
  "a phone in hand",
  "bins by the door",
];

/** One frame, many comparisons, one flat cost. */
const Fan: React.FC<{ at: number }> = ({ at }) => {
  const f = useCurrentFrame();
  const n = Math.min(50, Math.max(1, Math.floor((f - at - 30) / 1.5)));

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 34 }}>
      {/* The one thing that cost anything. */}
      <div style={{ textAlign: "center", flexShrink: 0 }}>
        <div
          style={{
            width: 210,
            height: 128,
            borderRadius: R.r2,
            background: C.watchWash,
            border: `2px solid ${C.watchEdge}`,
            display: "grid",
            placeItems: "center",
            opacity: inOut(f, at, 16),
          }}
        >
          <Mono size={19} color={C.watchText} style={{ fontWeight: 700 }}>
            one frame
          </Mono>
        </div>
        <div style={{ marginTop: 10 }}>
          <Mono size={16} color={C.dimmer}>
            encoded once
          </Mono>
        </div>
      </div>

      {/* Every sub-goal reaching for the same vector. */}
      <svg width="180" height="330" style={{ overflow: "visible", flexShrink: 0 }}>
        {Array.from({ length: 6 }, (_, i) => {
          const y = 38 + i * 51;
          return (
            <DrawArrow
              key={i}
              id={`fan${i}`}
              at={at + 18 + i * 5}
              dur={14}
              color={C.hair}
              width={1.75}
              d={`M 0 165 C 86 165, 96 ${y}, 174 ${y}`}
            />
          );
        })}
      </svg>

      <div style={{ display: "flex", flexDirection: "column", gap: 9, flexShrink: 0 }}>
        {SUBGOALS.map((label, i) => {
          const p = inOut(f, at + 24 + i * 5, 14);
          return (
            <div
              key={label}
              style={{
                opacity: p,
                transform: `translateX(${(1 - p) * -10}px)`,
                width: 372,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 16px",
                borderRadius: R.r,
                background: C.sunk,
                border: `1px solid ${C.hair}`,
              }}
            >
              <Mono size={17} color={C.dim}>
                {label}
              </Mono>
              <Mono size={15} color={C.dimmer}>
                1 compare
              </Mono>
            </div>
          );
        })}
        <div style={{ opacity: inOut(f, at + 62, 16), paddingLeft: 16, paddingTop: 2 }}>
          <Mono size={17} color={C.dimmer}>
            … and {n > 6 ? n - 6 : 0} more
          </Mono>
        </div>
      </div>

      {/* The number that does not move. */}
      <div
        style={{
          flexShrink: 0,
          marginLeft: 10,
          padding: "24px 32px",
          borderRadius: R.r2,
          background: C.provedWash,
          border: `2px solid ${C.provedEdge}`,
          textAlign: "center",
          opacity: inOut(f, at + 40, 16),
        }}
      >
        <Mono size={17} color={C.dimmer}>
          watching for
        </Mono>
        <div
          style={{
            fontFamily: F.mono,
            fontSize: 58,
            fontWeight: 700,
            color: C.fg,
            lineHeight: 1.1,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {n}
        </div>
        <div style={{ marginTop: 13, paddingTop: 13, borderTop: `1px solid ${C.provedEdge}` }}>
          <Mono size={17} color={C.dimmer}>
            encoder cost
          </Mono>
          <div
            style={{
              fontFamily: F.mono,
              fontSize: 36,
              fontWeight: 700,
              color: C.provedText,
              lineHeight: 1.1,
            }}
          >
            ×1
          </div>
        </div>
      </div>
    </div>
  );
};

/** Two goals, one shared sub-goal, and nothing created for the second. */
const Shared: React.FC<{ at: number }> = ({ at }) => {
  const f = useCurrentFrame();
  const GX = 40;
  const GW = 340;
  const SX = 700;
  const SW = 430;
  const yA = 60;
  const yB = 198;

  const node = (
    x: number,
    y: number,
    w: number,
    label: string,
    sub: string,
    tone: "none" | "proved" | "watch",
    pill: boolean,
    appear: number,
    badge?: string,
  ) => {
    const p = inOut(f, appear, 16);
    const k =
      tone === "proved"
        ? { t: C.provedText, w: C.provedWash, e: C.provedEdge, s: C.proved }
        : tone === "watch"
          ? { t: C.watchText, w: C.watchWash, e: C.watchEdge, s: C.watch }
          : { t: C.dim, w: C.sunk, e: C.hair, s: C.dimmer };
    return (
      <div
        style={{
          position: "absolute",
          left: x,
          top: y - 36,
          width: w,
          height: 72,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 20px",
          borderRadius: pill ? 36 : R.r2,
          background: k.w,
          border: `${tone === "none" ? 1 : 2}px solid ${k.e}`,
          opacity: p,
          transform: `scale(${0.93 + p * 0.07})`,
        }}
      >
        <div
          style={{
            fontFamily: F.ui,
            fontSize: 23,
            fontWeight: 600,
            color: C.fg,
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </div>
        <div style={{ fontFamily: F.mono, fontSize: 15, color: k.t, marginTop: 2 }}>{sub}</div>
        {badge && (
          <div
            style={{
              position: "absolute",
              right: -14,
              top: -12,
              padding: "4px 10px",
              borderRadius: 999,
              background: k.s,
              color: "#fff",
              fontFamily: F.mono,
              fontSize: 15,
              fontWeight: 700,
              opacity: inOut(f, appear + 14, 12),
            }}
          >
            {badge}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ position: "relative", width: 1180, height: 272 }}>
      <svg width="1180" height="272" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <DrawArrow
          id="sh0"
          at={at + 8}
          dur={16}
          color={C.line}
          width={2}
          d={`M ${GX + GW} ${yA} H ${SX}`}
        />
        <DrawArrow
          id="sh1"
          at={at + 44}
          dur={20}
          color={C.watch}
          width={3}
          d={`M ${GX + GW} ${yB - 8} C 520 ${yB - 8}, 540 ${yA}, ${SX} ${yA}`}
        />
      </svg>
      {node(GX, yA, GW, "tidy the living room", "goal · existing", "none", false, at)}
      {node(GX, yB, GW, "20 pushups every morning", "goal · new", "proved", false, at + 30)}
      {node(SX, yA, SW, "someone in a room", "sub-goal", "watch", true, at + 4, "used by 2")}
    </div>
  );
};

/** Scene length, so the handoff can be timed from the end. */
const LEN = 528;

export const S4Live: React.FC = () => {
  const f = useCurrentFrame();
  const SHARE = s(9.4);
  // Beat 5 opens on the same sub-goal at the head of its tree, so the graph
  // slides toward that side as this beat leaves rather than dissolving.
  const HANDOFF = inOut(f, LEN - 14, 14);

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      {/* The fan. */}
      {f < SHARE + 14 && (
        <Phase from={0} to={SHARE - 12}>
          <div>
            <div style={{ marginLeft: 4, marginBottom: 6 }}>
              <Eyebrow at={2}>one frame, every sub-goal</Eyebrow>
            </div>
            <Fan at={10} />
            <Rise at={s(6.2)} style={{ marginTop: 30, textAlign: "center" }}>
              <div
                style={{
                  fontFamily: F.display,
                  fontSize: 36,
                  fontWeight: 500,
                  color: C.dim,
                  letterSpacing: -0.9,
                }}
              >
                Watching for fifty things costs{" "}
                <span style={{ color: C.fg, fontWeight: 600 }}>
                  barely more than watching for one.
                </span>
              </div>
            </Rise>
          </div>
        </Phase>
      )}

      {/* The reuse. */}
      {f >= SHARE - 4 && (
        <Phase from={SHARE}>
          <div
            style={{
              transform: `translateX(${-110 * HANDOFF}px) scale(${1 - 0.05 * HANDOFF})`,
              opacity: 1 - 0.35 * HANDOFF,
            }}
          >
            <div style={{ marginLeft: 4, marginBottom: 10 }}>
              <Eyebrow at={SHARE}>and they're shared</Eyebrow>
            </div>
            <Shared at={SHARE + 8} />
            <Rise at={SHARE + 78} style={{ marginTop: 6, textAlign: "center" }}>
              <div
                style={{
                  fontFamily: F.display,
                  fontSize: 36,
                  fontWeight: 500,
                  color: C.dim,
                  letterSpacing: -0.9,
                }}
              >
                Goals stack into one tree —{" "}
                <span style={{ color: C.fg, fontWeight: 600 }}>not fifty separate watchers.</span>
              </div>
            </Rise>
          </div>
        </Phase>
      )}
    </AbsoluteFill>
  );
};
