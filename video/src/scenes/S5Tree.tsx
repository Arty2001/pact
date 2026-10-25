/**
 * Beat 5 - one skill switches on another. 1:07 to 1:25.
 *
 * Two ideas, and the second was missing from the film entirely until now.
 *
 * The tree: a skill is eligible only while its parent gate is open, so an
 * asleep skill is not scored at all. The score column says so - a sleeping
 * row shows a dash, not a number - which draws the whole saving without a
 * word of commentary.
 *
 * The rate: perception asks for the fastest rate any eligible skill needs and
 * the camera obeys. A gate is fine at 0.5 Hz, most skills want 2, and a rep
 * counter is blind below about 4, so the ladder steps 0.5 -> 2 -> 12 as the
 * tree wakes. That is in run.py, it is genuinely clever, and leaving it out
 * was the biggest omission in the cut.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, F, R, s } from "../lib/theme";
import { Rise, Mono, inOut, Eyebrow } from "../lib/prims";
import { FootageSlot, WatchFrame } from "../lib/footage";

type Row = {
  label: string;
  kind: string;
  indent: number;
  /** When this row wakes, in scene frames. Infinity = stays asleep. */
  wakes: number;
  score: number;
};

const SkillLine: React.FC<{ row: Row; at: number }> = ({ row, at }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 16);
  const awake = f >= row.wakes;
  const tone = awake
    ? row.kind === "gate"
      ? { t: C.provedText, w: C.provedWash, e: C.provedEdge, s: C.proved }
      : { t: C.pendingText, w: C.pendingWash, e: C.pendingEdge, s: C.pending }
    : { t: C.dimmer, w: C.sunk, e: C.hair, s: C.dimmer };

  /** Rises over half a second when the row wakes, so the number gets watched. */
  const lift = awake ? inOut(f, row.wakes, 15) : 0;
  const shown = (0.06 + (row.score - 0.06) * lift).toFixed(2);

  return (
    <div
      style={{
        opacity: p * (awake ? 1 : 0.5),
        transform: `translateY(${(1 - p) * 14}px)`,
        marginLeft: row.indent,
        width: 860 - row.indent,
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "15px 20px",
        borderRadius: R.r,
        background: tone.w,
        border: `1px solid ${tone.e}`,
      }}
    >
      <span style={{ width: 9, height: 9, borderRadius: 999, background: tone.s, flexShrink: 0 }} />
      <span
        style={{
          flex: 1,
          fontFamily: F.ui,
          fontSize: 24,
          color: C.fg,
          fontWeight: 500,
          whiteSpace: "nowrap",
        }}
      >
        {row.label}
      </span>
      <Mono size={16} color={C.dimmer}>
        {row.kind}
      </Mono>
      {/* The point of the scene: a sleeping skill has no score, because it
          was never scored. */}
      <span
        style={{
          width: 96,
          textAlign: "right",
          fontFamily: F.mono,
          fontSize: 21,
          fontWeight: 700,
          color: awake ? tone.t : C.dimmer,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {awake ? shown : "—"}
      </span>
      <span style={{ width: 96, textAlign: "right" }}>
        <Mono size={15} color={C.dimmer}>
          {awake ? "scored" : "not scored"}
        </Mono>
      </span>
    </div>
  );
};

export const S5Tree: React.FC = () => {
  const f = useCurrentFrame();
  // Caught from beat 4, which ended on this same sub-goal as a node. The
  // tree arrives from the right, where that node was, so the shared skill
  // carries across the cut instead of being redrawn.
  const CATCH = inOut(f, 0, 18);

  const WALKIN = s(2.0);
  const CHILD = s(4.6);

  const rows: Row[] = [
    { label: "someone in a room", kind: "gate", indent: 0, wakes: WALKIN, score: 0.91 },
    {
      label: "someone in a pushup position",
      kind: "counter",
      indent: 64,
      wakes: CHILD,
      score: 0.74,
    },
    { label: "someone at the kitchen sink", kind: "gate", indent: 0, wakes: Infinity, score: 0 },
    { label: "dishes in the sink", kind: "object", indent: 64, wakes: Infinity, score: 0 },
  ];

  const eligible = rows.filter((r) => f >= r.wakes).length;
  const hz = f >= CHILD ? 12 : f >= WALKIN ? 2 : 0.5;

  const LADDER = [
    { hz: "0.5/s", when: "empty room", live: hz === 0.5 },
    { hz: "2/s", when: "someone's here", live: hz === 2 },
    { hz: "12/s", when: "counting reps", live: hz === 12 },
  ];

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 1700 }}>
        <div style={{ display: "flex", gap: 44, alignItems: "flex-start" }}>
          {/* The room, and the rate it is being asked for. */}
          <div style={{ width: 620, flexShrink: 0 }}>
            <div style={{ position: "relative" }}>
              <FootageSlot
                shot={4}
                note="living room — empty, then you walk in"
                at={2}
                w={620}
                h={366}
              />
              {f >= WALKIN && <WatchFrame at={WALKIN} inset={0} />}
              <div
                style={{
                  position: "absolute",
                  left: 18,
                  bottom: 18,
                  opacity: inOut(f, WALKIN + 4, 14),
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 16px",
                  borderRadius: 999,
                  background: "rgba(13,27,38,.66)",
                  border: `1px solid ${C.watchEdge}`,
                }}
              >
                <span style={{ width: 9, height: 9, borderRadius: 999, background: C.watch }} />
                <Mono size={18} color={C.onDark}>
                  watching
                </Mono>
              </div>
            </div>

            {/* The rate the camera is told to run at, and why it changes. */}
            <div
              style={{
                marginTop: 18,
                padding: 22,
                borderRadius: R.r2,
                background: C.glass,
                border: `1px solid ${C.hair}`,
                opacity: inOut(f, 14, 16),
              }}
            >
              <div
                style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}
              >
                <Mono size={17} color={C.dimmer}>
                  sample rate
                </Mono>
                <span
                  style={{
                    fontFamily: F.mono,
                    fontSize: 44,
                    fontWeight: 700,
                    color: hz === 12 ? C.pendingText : hz === 2 ? C.provedText : C.dim,
                    letterSpacing: -1.6,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {hz}/s
                </span>
              </div>
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                {LADDER.map((l) => (
                  <div
                    key={l.hz}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "8px 13px",
                      borderRadius: 6,
                      background: l.live ? C.glassTop : "transparent",
                      border: `1px solid ${l.live ? C.line : "transparent"}`,
                    }}
                  >
                    <Mono size={17} color={l.live ? C.fg : C.dimmer}>
                      {l.when}
                    </Mono>
                    <Mono
                      size={17}
                      color={l.live ? C.fg : C.dimmer}
                      style={{ fontWeight: l.live ? 700 : 400 }}
                    >
                      {l.hz}
                    </Mono>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* The tree. */}
          <div
            style={{
              flex: 1,
              transform: `translateX(${(1 - CATCH) * 90}px)`,
              opacity: CATCH,
            }}
          >
            <div
              style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}
            >
              <Eyebrow at={2}>the skills for this room</Eyebrow>
              <div style={{ marginBottom: 22 }}>
                <Mono size={19} color={C.dimmer}>
                  eligible <span style={{ color: C.fg, fontWeight: 700 }}>{eligible}</span> of 4
                </Mono>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
              <SkillLine row={rows[0]} at={4} />
              <div style={{ position: "relative" }}>
                <svg
                  width="80"
                  height="70"
                  style={{ position: "absolute", left: 24, top: -22, overflow: "visible" }}
                >
                  <path
                    d="M 2 0 V 40 H 30"
                    fill="none"
                    stroke={f >= CHILD ? C.provedEdge : C.hair}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeDasharray="72"
                    strokeDashoffset={72 * (1 - inOut(f, CHILD, 18))}
                  />
                </svg>
                <SkillLine row={rows[1]} at={6} />
              </div>
              <SkillLine row={rows[2]} at={8} />
              <SkillLine row={rows[3]} at={10} />
            </div>

            <Rise at={s(7.0)} style={{ marginTop: 34 }}>
              <div
                style={{
                  fontFamily: F.display,
                  fontSize: 34,
                  fontWeight: 500,
                  color: C.dim,
                  letterSpacing: -0.9,
                  lineHeight: 1.35,
                  maxWidth: 880,
                }}
              >
                A skill that passes unlocks the ones below it.{" "}
                <span style={{ color: C.fg, fontWeight: 600 }}>
                  The rest are never scored at all.
                </span>
              </div>
            </Rise>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
