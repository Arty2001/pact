/**
 * Beat 4 - fifty cost what one costs. 1:01 to 1:17.
 *
 * "Every sub-goal becomes a simple comparison between embeddings. Watching for
 *  fifty things costs barely more than watching for one. We also made sure to
 *  be smart about which sub-goals are being watched. We reuse sub-goals from
 *  other goals, so everything stacks into one clean tree of goals and
 *  sub-goals."
 *
 * Two claims, two phases, and both are arithmetic rather than assertion.
 *
 * First the ledger. The encode is the only expensive thing that happens to a
 * frame; a sub-goal is a dot product over 1152 numbers, which is free next to
 * it. The right-hand column is operations rather than milliseconds, because
 * nobody has measured a forward pass on the machine this will be judged on and
 * a latency figure invented to look precise is the fastest way to lose a
 * technical room. Multiply-adds are exact, checkable, and make the same point
 * harder: fifty sub-goals add 57,600 of them to a forward pass.
 *
 * Then the tree, and it merges on screen. Three goals declare eight sub-goals
 * between them and three of those are the same gate, so the duplicates travel
 * to one position and the goals move out to a column that keeps its lines to
 * what it uses. The shared node ending up with three lines on it is the whole
 * argument for the tree, made without a word.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, F, R } from "../lib/theme";
import { Rise, Mono, inOut, Eyebrow, Phase, CountUp } from "../lib/prims";
import { timing } from "../lib/beats";

const t = timing("b4");

/* ------------------------------------------------------------------ ledger */

const ROWS = [
  {
    n: "1 ×",
    what: "encode the frame",
    detail: "C-RADIOv3-B forward pass → 1152-d",
    cost: "the whole cost",
    hero: true,
  },
  {
    n: "50 ×",
    what: "score a sub-goal",
    detail: "one dot product · 1152 multiply-adds",
    cost: "57,600 mults",
  },
];

const Ledger: React.FC<{ at: number }> = ({ at }) => {
  const f = useCurrentFrame();
  return (
    <div style={{ width: 880 }}>
      {ROWS.map((r, i) => {
        const p = inOut(f, at + i * 16, 16);
        return (
          <div
            key={r.what}
            style={{
              opacity: p,
              transform: `translateY(${(1 - p) * 14}px)`,
              display: "flex",
              alignItems: "center",
              gap: 18,
              padding: "18px 22px",
              marginBottom: 10,
              borderRadius: R.r,
              background: r.hero ? C.watchWash : C.sunk,
              border: `1px solid ${r.hero ? C.watchEdge : C.hair}`,
            }}
          >
            <Mono size={22} color={r.hero ? C.watchText : C.dim} style={{ width: 62, fontWeight: 700 }}>
              {r.n}
            </Mono>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: F.ui, fontSize: 26, color: C.fg, fontWeight: 500 }}>
                {r.what}
              </div>
              <div style={{ marginTop: 3 }}>
                <Mono size={17} color={C.dimmer}>
                  {r.detail}
                </Mono>
              </div>
            </div>
            <Mono
              size={23}
              color={r.hero ? C.watchText : C.dim}
              style={{ fontWeight: 700, whiteSpace: "nowrap" }}
            >
              {r.cost}
            </Mono>
          </div>
        );
      })}

      {/* The total, which is the point: the second row barely moves it. */}
      <div
        style={{
          opacity: inOut(f, at + 40, 16),
          display: "flex",
          alignItems: "center",
          gap: 18,
          marginTop: 16,
          paddingTop: 20,
          borderTop: `1px solid ${C.line}`,
        }}
      >
        <Mono size={19} color={C.dimmer} style={{ flex: 1 }}>
          what 50 sub-goals add to a frame
        </Mono>
        <Mono size={34} color={C.provedText} style={{ fontWeight: 700 }}>
          <CountUp to={57600} at={at + 44} dur={26} />
        </Mono>
        <Mono size={22} color={C.dimmer} style={{ paddingBottom: 3 }}>
          multiply-adds
        </Mono>
      </div>

      <Rise at={at + 56} style={{ marginTop: 22 }} y={16}>
        <div
          style={{
            fontFamily: F.display,
            fontSize: 34,
            fontWeight: 600,
            color: C.fg,
            letterSpacing: -1,
          }}
        >
          Fifty things cost what one thing costs,
          <br />
          <span style={{ color: C.provedText }}>plus 57,600 multiply-adds.</span>
        </div>
      </Rise>
    </div>
  );
};

/* -------------------------------------------------------------------- tree */

type N = {
  id: string;
  label: string;
  kind?: string;
  /** Before the merge. */
  x0: number;
  y0: number;
  /** After it. Duplicates share a destination. */
  x1: number;
  y1: number;
  w0: number;
  w1: number;
  /** A duplicate, which does not survive its own arrival. */
  dies?: boolean;
  goal?: boolean;
  /** Index of the goal column rows this sub-goal feeds, for the lines. */
  feeds?: number[];
};

const SUB_W = 560;
const GOAL_W = 360;
const GOAL_X = 700;

const NODES: N[] = [
  // The three goals, which move out to their own column.
  { id: "gA", label: "20 pushups every morning", goal: true, x0: 0, y0: 0, x1: GOAL_X, y1: 86, w0: SUB_W, w1: GOAL_W },
  { id: "gB", label: "keep the sink clear", goal: true, x0: 0, y0: 198, x1: GOAL_X, y1: 170, w0: SUB_W, w1: GOAL_W },
  { id: "gC", label: "read before bed", goal: true, x0: 0, y0: 352, x1: GOAL_X, y1: 254, w0: SUB_W, w1: GOAL_W },

  // The gate all three of them need. One survives.
  { id: "a1", label: "someone in a room", kind: "gate", x0: 46, y0: 50, x1: 0, y1: 44, w0: SUB_W - 46, w1: SUB_W, feeds: [0, 1, 2] },
  { id: "b1", label: "someone in a room", kind: "gate", x0: 46, y0: 248, x1: 0, y1: 44, w0: SUB_W - 46, w1: SUB_W, dies: true },
  { id: "c1", label: "someone in a room", kind: "gate", x0: 46, y0: 402, x1: 0, y1: 44, w0: SUB_W - 46, w1: SUB_W, dies: true },

  // And everything that is only wanted once.
  { id: "a2", label: "someone in a pushup position", kind: "action", x0: 46, y0: 94, x1: 46, y1: 108, w0: SUB_W - 46, w1: SUB_W - 46, feeds: [0] },
  { id: "a3", label: "20 of them", kind: "counter", x0: 46, y0: 138, x1: 46, y1: 152, w0: SUB_W - 46, w1: SUB_W - 46, feeds: [0] },
  { id: "b2", label: "dishes in the sink", kind: "object", x0: 46, y0: 292, x1: 46, y1: 196, w0: SUB_W - 46, w1: SUB_W - 46, feeds: [1] },
  { id: "c2", label: "a book open", kind: "object", x0: 46, y0: 446, x1: 46, y1: 240, w0: SUB_W - 46, w1: SUB_W - 46, feeds: [2] },
];

const GOAL_Y = [86, 170, 254];

const Tree: React.FC<{ at: number; merge: number }> = ({ at, merge }) => {
  const f = useCurrentFrame();
  const m = merge;
  const mix = (a: number, b: number) => a + (b - a) * m;

  return (
    <div style={{ position: "relative", width: 1060, height: 500 - 196 * m }}>
      {/* Lines from each surviving sub-goal to the goals that use it. Drawn
          only once the nodes have arrived, so nothing crosses in transit. */}
      <svg width="1060" height="500" style={{ position: "absolute", inset: 0 }}>
        {NODES.filter((n) => n.feeds).map((n) =>
          n.feeds!.map((g) => {
            const x1 = n.x1 + n.w1;
            const y1 = n.y1 + 21;
            const x2 = GOAL_X;
            const y2 = GOAL_Y[g] + 21;
            const p = inOut(f, at + 40, 18);
            return (
              <path
                key={`${n.id}-${g}`}
                d={`M ${x1} ${y1} C ${x1 + 60} ${y1} ${x2 - 60} ${y2} ${x2} ${y2}`}
                fill="none"
                stroke={n.feeds!.length > 1 ? C.proved : C.line}
                strokeWidth={n.feeds!.length > 1 ? 1.8 : 1.2}
                opacity={Math.max(0, m - 0.72) * 3.5 * p}
              />
            );
          }),
        )}
      </svg>

      {NODES.map((n) => {
        const born = inOut(f, at + (n.goal ? 0 : 8), 16);
        // Duplicates fade as they land on the node they are the same as.
        const alive = n.dies ? 1 - Math.min(1, Math.max(0, (m - 0.5) / 0.3)) : 1;
        const shared = n.feeds && n.feeds.length > 1 && m > 0.75;
        return (
          <div
            key={n.id}
            style={{
              position: "absolute",
              left: mix(n.x0, n.x1),
              top: mix(n.y0, n.y1),
              width: mix(n.w0, n.w1),
              height: 42,
              opacity: born * alive,
              display: "flex",
              alignItems: "center",
              gap: 13,
              padding: "0 16px",
              boxSizing: "border-box",
              borderRadius: R.r,
              background: n.goal ? C.glassTop : shared ? C.provedWash : C.sunk,
              border: `1px solid ${n.goal ? C.hair : shared ? C.provedEdge : C.hair}`,
            }}
          >
            {n.goal ? (
              <svg width="15" height="15" viewBox="0 0 20 20" style={{ flexShrink: 0 }}>
                <path
                  d="M10 1.4 17.4 5.7v8.6L10 18.6 2.6 14.3V5.7z"
                  fill="none"
                  stroke={C.dimmer}
                  strokeWidth="1.6"
                />
              </svg>
            ) : (
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: shared ? C.proved : C.dimmer,
                  flexShrink: 0,
                }}
              />
            )}
            <span
              style={{
                flex: 1,
                fontFamily: F.ui,
                fontSize: n.goal ? 21 : 20,
                color: C.fg,
                fontWeight: n.goal ? 600 : 500,
                letterSpacing: -0.4,
                whiteSpace: "nowrap",
                overflow: "hidden",
              }}
            >
              {n.label}
            </span>
            {shared && (
              <Mono size={15} color={C.provedText} style={{ fontWeight: 700 }}>
                ×3
              </Mono>
            )}
            {n.kind && (
              <Mono size={15} color={C.dimmer}>
                {n.kind}
              </Mono>
            )}
          </div>
        );
      })}
    </div>
  );
};

export const S4Fifty: React.FC = () => {
  const f = useCurrentFrame();

  const TREE = t("shared") - 12;
  const merge = inOut(f, t("oneTree"), 36);

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      {/* ---- what a sub-goal actually costs ---- */}
      {f < TREE + 14 && (
        <Phase from={0} to={TREE} scale={1.38}>
          <div>
            <Eyebrow at={t("oneComparison")}>one encode, then arithmetic</Eyebrow>
            <Ledger at={t("oneComparison") + 6} />
          </div>
        </Phase>
      )}

      {/* ---- and which ones are even watched ---- */}
      {f >= TREE - 4 && (
        <Phase from={TREE} scale={1.3}>
          <div style={{ width: 1060 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 26 }}>
              <Eyebrow at={t("shared")}>
                {merge > 0.8 ? "one tree of goals and sub-goals" : "three goals, declared separately"}
              </Eyebrow>
              <div style={{ marginLeft: "auto", display: "flex", gap: 22, opacity: inOut(f, t("cameFrom"), 16) }}>
                <Mono size={19} color={C.dimmer}>
                  declared <span style={{ color: C.fg, fontWeight: 700 }}>8</span>
                </Mono>
                <Mono size={19} color={merge > 0.6 ? C.provedText : C.dimmer}>
                  scored{" "}
                  <span style={{ fontWeight: 700 }}>{merge > 0.6 ? 6 : 8}</span>
                </Mono>
              </div>
            </div>
            <Tree at={t("shared")} merge={merge} />
          </div>
        </Phase>
      )}
    </AbsoluteFill>
  );
};
