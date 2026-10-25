/**
 * Beat 6 - it counts, and closes itself out. 1:25 to 1:47.
 *
 * The proof beat, and the densest frame in the film on purpose: a viewer who
 * pauses here should find a working state machine rather than a decorative
 * one. Everything on screen is derived from the same curve by the same rules
 * the real machine uses, so the four states, the dwell timer, the event log
 * and the tally cannot disagree with each other.
 *
 * Two thresholds rather than one is the thing an engineer on the panel looks
 * for, so the band between them is tinted and labelled, and the scene spends
 * two seconds on a wobble that does NOT cross the lower line while the
 * counter stays put. That inset answers "surely it double counts" without the
 * voiceover having to defend anything.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { C, F, T, R, s } from "../lib/theme";
import { Rise, Mono, inOut, Eyebrow, Chip } from "../lib/prims";
import { FootageSlot } from "../lib/footage";

const W = 1040;
const H = 300;
const ENTER = 0.75;
const EXIT = 0.45;
const STEPS = 420;
/** Dwell, in curve steps. A counter releases fast so the next rep is its own. */
const DWELL = 7;
/** Seconds of wall clock the whole curve represents. */
const SPAN_S = 13.5;

/**
 * Score at time t (0..1 across the plot). Deterministic, and it has to add up:
 * exactly twenty full cycles, because the tally counts them the way the state
 * machine does and the goal is twenty. Eight reps, then one flicker that peaks
 * under the enter line and must not count, then twelve.
 */
const TROUGH = 0.04;
const scoreAt = (t: number): number => {
  if (t < 0.4) {
    const u = (t - 0.02) / 0.38;
    if (u < 0) return TROUGH;
    return 0.46 + Math.sin(u * Math.PI * 2 * 8 - Math.PI / 2) * 0.42;
  }
  if (t < 0.48) {
    const u = (t - 0.4) / 0.08;
    return TROUGH + Math.sin(u * Math.PI) * 0.6;
  }
  const u = Math.min(1, (t - 0.48) / 0.5);
  return 0.46 + Math.sin(u * Math.PI * 2 * 12 - Math.PI / 2) * 0.42;
};

const Y = (v: number) => H - v * H;

type Phase = "idle" | "candidate" | "active" | "cooldown";
const PHASES: Phase[] = ["idle", "candidate", "active", "cooldown"];

/** Scene length, so the handoff can be timed from the end. */
const LEN = 420;
/** Beat 7's plot is 760 wide against this one's 1040. */
const NEXT = 760 / 1040;

export const S6Count: React.FC = () => {
  const f = useCurrentFrame();
  // Beat 7 opens on the same plot with the same thresholds, so this beat
  // zooms out to meet it rather than cutting. The scale is the real ratio
  // between the two, about the left edge, where they already align.
  const HANDOFF = inOut(f, LEN - 14, 14);

  const START = s(0.8);
  const RUN = s(5.4);
  const FLICK = START + RUN * 0.4;
  const DONE = START + RUN;

  const prog = interpolate(f, [START, START + RUN], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  /**
   * One walk of the curve, producing everything on screen. Deriving the tally,
   * the phase and the log from separate rules is how a frame ends up showing
   * "done" over a count of eight, which an earlier cut did.
   */
  let count = 0;
  let armed = false;
  let enteredAt = 0;
  let peak = 0;
  const events: Array<{ n: number; ms: number; peak: number }> = [];
  const pts: string[] = [];
  const upTo = STEPS * prog;

  for (let i = 0; i <= upTo; i++) {
    const t = i / STEPS;
    const v = scoreAt(t);
    pts.push(`${(t * W).toFixed(1)},${Y(v).toFixed(1)}`);
    if (!armed && v >= ENTER) {
      armed = true;
      enteredAt = i;
      peak = v;
    }
    if (armed) peak = Math.max(peak, v);
    if (armed && v < EXIT) {
      armed = false;
      count++;
      events.push({
        n: count,
        ms: Math.round(((i - enteredAt) / STEPS) * SPAN_S * 1000),
        peak,
      });
      peak = 0;
    }
  }

  const shown = Math.min(20, count);
  const nowV = scoreAt(prog);
  const held = upTo - enteredAt;
  const phase: Phase = !armed ? "idle" : held < DWELL ? "candidate" : "active";
  const settled = shown >= 20;
  const log = events.slice(-4).reverse();

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div
        style={{
          width: 1620,
          transform: `scale(${1 - (1 - NEXT) * HANDOFF})`,
          transformOrigin: "left center",
          opacity: 1 - 0.3 * HANDOFF,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <Eyebrow at={2}>one up-and-down, one entry</Eyebrow>
          <div style={{ display: "flex", gap: 16, marginBottom: 22 }}>
            <Chip label="enter 0.75" tone="pending" mono />
            <Chip label="exit 0.45" tone="none" mono />
          </div>
        </div>

        <div style={{ display: "flex", gap: 40, alignItems: "flex-start" }}>
          <div style={{ width: 1092 }}>
            {/* The plot. */}
            <div
              style={{
                position: "relative",
                background: C.glass,
                border: `1px solid ${C.hair}`,
                borderRadius: R.r2,
                padding: 26,
              }}
            >
              <svg width={W} height={H} style={{ display: "block", overflow: "visible" }}>
                <rect
                  x="0"
                  y={Y(ENTER)}
                  width={W}
                  height={Y(EXIT) - Y(ENTER)}
                  fill={C.pendingWash}
                  opacity={inOut(f, 8, 16)}
                />
                <line
                  x1="0"
                  x2={W}
                  y1={Y(ENTER)}
                  y2={Y(ENTER)}
                  stroke={C.pendingEdge}
                  strokeWidth="2"
                  strokeDasharray="7 6"
                  opacity={inOut(f, 8, 16)}
                />
                <line
                  x1="0"
                  x2={W}
                  y1={Y(EXIT)}
                  y2={Y(EXIT)}
                  stroke={C.line}
                  strokeWidth="2"
                  strokeDasharray="7 6"
                  opacity={inOut(f, 10, 16)}
                />
                {pts.length > 1 && (
                  <polyline
                    points={pts.join(" ")}
                    fill="none"
                    stroke={C.proved}
                    strokeWidth="3"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )}
                {prog > 0 && prog < 1 && (
                  <circle
                    cx={prog * W}
                    cy={Y(nowV)}
                    r="7"
                    fill={nowV >= ENTER ? C.proved : C.dimmer}
                  />
                )}
              </svg>

              {f >= FLICK && f < FLICK + s(3.4) && (
                <div
                  style={{
                    position: "absolute",
                    left: 26 + 0.42 * W - 118,
                    top: 26 + Y(0.56),
                    opacity: inOut(f, FLICK, 10) * (1 - inOut(f, FLICK + s(2.6), 16)),
                  }}
                >
                  <div
                    style={{
                      padding: "12px 18px",
                      borderRadius: R.r,
                      background: C.glassTop,
                      border: `1px solid ${C.line}`,
                      boxShadow: "0 8px 22px -12px rgba(13,27,38,.4)",
                      textAlign: "center",
                    }}
                  >
                    <Mono size={18} color={C.dim}>
                      never crossed
                    </Mono>
                    <div
                      style={{
                        fontFamily: F.ui,
                        fontSize: 23,
                        fontWeight: 600,
                        color: C.fg,
                        marginTop: 2,
                      }}
                    >
                      doesn't count
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* The machine itself: four states, and which one it is in now. */}
            <div
              style={{
                marginTop: 18,
                display: "flex",
                alignItems: "center",
                gap: 14,
                opacity: inOut(f, 20, 16),
              }}
            >
              {PHASES.map((p, i) => {
                const on = p === phase;
                const tone =
                  p === "active"
                    ? { t: C.provedText, w: C.provedWash, e: C.provedEdge }
                    : p === "candidate"
                      ? { t: C.pendingText, w: C.pendingWash, e: C.pendingEdge }
                      : { t: C.dim, w: C.sunk, e: C.hair };
                return (
                  <React.Fragment key={p}>
                    <div
                      style={{
                        padding: "11px 20px",
                        borderRadius: R.r,
                        background: on ? tone.w : "transparent",
                        border: `${on ? 2 : 1}px solid ${on ? tone.e : C.hair}`,
                        fontFamily: F.mono,
                        fontSize: 19,
                        fontWeight: on ? 700 : 400,
                        color: on ? tone.t : C.dimmer,
                      }}
                    >
                      {p}
                    </div>
                    {i < 3 && (
                      <Mono size={17} color={C.dimmer}>
                        →
                      </Mono>
                    )}
                  </React.Fragment>
                );
              })}

              <div style={{ marginLeft: "auto", display: "flex", gap: 26 }}>
                <Readout k="score" v={nowV.toFixed(2)} />
                <Readout k="held" v={`${Math.max(0, Math.round((held / STEPS) * SPAN_S * 1000))}ms`} />
                <Readout k="dwell" v={`${Math.round((DWELL / STEPS) * SPAN_S * 1000)}ms`} />
              </div>
            </div>
          </div>

          {/* The tally, the footage it came from, and the ledger it wrote. */}
          <div style={{ width: 460, display: "flex", flexDirection: "column", gap: 18 }}>
            <FootageSlot shot={5} note="a full set, no cuts" at={4} w={460} h={232} />

            <div
              style={{
                background: settled ? C.provedWash : C.glass,
                border: `1px solid ${settled ? C.provedEdge : C.hair}`,
                borderRadius: R.r2,
                padding: 22,
              }}
            >
              <Mono size={T.micro} color={C.dimmer}>
                pushups, every morning
              </Mono>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 6 }}>
                <span
                  style={{
                    fontFamily: F.mono,
                    fontSize: 76,
                    fontWeight: 700,
                    color: settled ? C.provedText : C.fg,
                    letterSpacing: -3,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {shown}
                </span>
                <span style={{ fontFamily: F.mono, fontSize: 34, color: C.dimmer }}>/ 20</span>
              </div>
              {settled && (
                <div style={{ marginTop: 12, opacity: inOut(f, DONE, 14) }}>
                  <Chip label="done · camera · 7:14" tone="proved" mono size={20} />
                </div>
            )}
            </div>

            {/* What actually crossed the wire. One line per rep. */}
            <div>
              <Mono size={18} color={C.dimmer}>
                transitions
              </Mono>
              <div
                style={{
                  marginTop: 8,
                  display: "flex",
                  flexDirection: "column",
                  gap: 5,
                  height: 112,
                  overflow: "hidden",
                }}
              >
                {log.map((e) => (
                  <div
                    key={e.n}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "5px 10px",
                      borderRadius: 5,
                      background: C.sunk,
                    }}
                  >
                    <Mono size={16} color={C.provedText}>
                      entered #{e.n}
                    </Mono>
                    <Mono size={16} color={C.dimmer}>
                      {e.ms}ms · peak {e.peak.toFixed(2)}
                    </Mono>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <Rise at={s(7.4)} style={{ marginTop: 20 }}>
          <div
            style={{
              fontFamily: F.display,
              fontSize: 34,
              fontWeight: 500,
              color: C.dim,
              letterSpacing: -0.8,
            }}
          >
            When something doesn't count, it says which —{" "}
            <span style={{ color: C.fg, fontWeight: 600 }}>
              too short, or never confident enough.
            </span>
          </div>
        </Rise>
      </div>
    </AbsoluteFill>
  );
};

const Readout: React.FC<{ k: string; v: string }> = ({ k, v }) => (
  <div style={{ textAlign: "right" }}>
    <Mono size={15} color={C.dimmer}>
      {k}
    </Mono>
    <div
      style={{
        fontFamily: F.mono,
        fontSize: 24,
        fontWeight: 700,
        color: C.fg,
        fontVariantNumeric: "tabular-nums",
        lineHeight: 1.1,
      }}
    >
      {v}
    </div>
  </div>
);
