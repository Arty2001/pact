/**
 * Beat 7 - two models, then you. 1:47 to 2:12.
 *
 * This beat carries criterion 1 almost on its own, so both Nemotron calls
 * have to be legible and the Nebius plate has to stay on screen long enough
 * to read. The rules gate on MEANINGFUL integration, and "a model decides the
 * hard cases, a person decides what even a model cannot" is about as
 * load-bearing as it gets.
 *
 * The ladder is the real escalation order from teacher.py, not a
 * simplification: the state machine resolves what it can, the VL model
 * adjudicates what it cannot, and an UNSURE verdict is treated as a real
 * answer that hands the question to a person rather than as a failure.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, F, T, R, s } from "../lib/theme";
import { Rise, Mono, inOut, Eyebrow, Chip, Pane, DrawArrow } from "../lib/prims";
import { ModelPlate } from "./S3Plan";

const W = 760;
const H = 190;

/** A score that wanders in the band and resolves nothing. */
const stuck = (t: number) => 0.58 + Math.sin(t * 15) * 0.05 + Math.sin(t * 41) * 0.022;

export const S7Ladder: React.FC = () => {
  const f = useCurrentFrame();

  const ASK = s(4.2);
  const VERDICT = s(8.0);
  const UNSURE = s(11.4);
  const QUESTION = s(14.6);
  const LABEL = s(18.6);

  // Caught from beat 6: the plot arrives at that scene's scale and settles
  // to this one's, so the curve reads as continuing rather than restarting.
  const CATCH = inOut(f, 0, 16);

  const pts: string[] = [];
  const prog = Math.min(1, Math.max(0, (f - 10) / s(3.6)));
  for (let i = 0; i <= 300 * prog; i++) {
    const t = i / 300;
    pts.push(`${(t * W).toFixed(1)},${(H - stuck(t) * H).toFixed(1)}`);
  }

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div
        style={{
          width: 1640,
          transform: `scale(${1040 / 760 - (1040 / 760 - 1) * CATCH})`,
          transformOrigin: "left center",
          opacity: CATCH,
        }}
      >
        <Eyebrow at={2}>when it can't tell, it doesn't guess</Eyebrow>

        <div style={{ display: "flex", gap: 56, alignItems: "flex-start" }}>
          {/* The stuck curve. */}
          <div>
            <Pane pad={24} style={{ width: W + 48 }}>
              <svg width={W} height={H} style={{ display: "block" }}>
                <rect
                  x="0"
                  y={H - 0.75 * H}
                  width={W}
                  height={0.3 * H}
                  fill={C.pendingWash}
                />
                <line
                  x1="0"
                  x2={W}
                  y1={H - 0.75 * H}
                  y2={H - 0.75 * H}
                  stroke={C.pendingEdge}
                  strokeWidth="2"
                  strokeDasharray="7 6"
                />
                <line
                  x1="0"
                  x2={W}
                  y1={H - 0.45 * H}
                  y2={H - 0.45 * H}
                  stroke={C.line}
                  strokeWidth="2"
                  strokeDasharray="7 6"
                />
                {pts.length > 1 && (
                  <polyline
                    points={pts.join(" ")}
                    fill="none"
                    stroke={C.pending}
                    strokeWidth="3"
                    strokeLinejoin="round"
                  />
                )}
              </svg>
              <div style={{ marginTop: 14 }}>
                <Chip label="stuck between the thresholds · 60s" tone="pending" mono size={19} />
              </div>
            </Pane>

            {/* Four frames lifting out. */}
            <div
              style={{
                display: "flex",
                gap: 12,
                marginTop: 26,
                opacity: inOut(f, ASK, 16),
              }}
            >
              {/* The four frames that actually get sent. Same striped
                  treatment as every other footage slot, so they read as video
                  rather than as empty boxes. */}
              {Array.from({ length: 4 }, (_, i) => {
                const p = inOut(f, ASK + i * 4, 18);
                return (
                  <div
                    key={i}
                    style={{
                      width: 118,
                      height: 74,
                      borderRadius: R.r,
                      border: `1px solid ${C.watchEdge}`,
                      background:
                        "repeating-linear-gradient(135deg, #12222E 0 9px, #0D1B26 9px 18px)",
                      transform: `translateY(${(1 - p) * 26}px)`,
                      opacity: p,
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: F.mono,
                        fontSize: 15,
                        color: C.onDarkDim,
                      }}
                    >
                      {`t−${3 - i}`}
                    </span>
                  </div>
                );
              })}
              <div style={{ alignSelf: "center", marginLeft: 12 }}>
                <Mono size={19} color={C.dim}>
                  4 frames
                </Mono>
              </div>
            </div>
          </div>

          {/* The ladder: model, then person. */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 20 }}>
            <ModelPlate
              at={ASK + 10}
              model="Nemotron 3.5 Super VL"
              where="Nebius Token Factory"
            />

            {f >= VERDICT && (
              <Rise at={VERDICT} y={16}>
                <Pane pad={22} style={{ width: 620 }}>
                  <Mono size={18} color={C.dimmer}>
                    verdict
                  </Mono>
                  <div style={{ marginTop: 10, display: "flex", gap: 14, alignItems: "center" }}>
                    <Chip label="YES · 0.88" tone="proved" mono size={21} />
                    <Mono size={19} color={C.dim}>
                      settles it
                    </Mono>
                  </div>
                </Pane>
              </Rise>
            )}

            {f >= UNSURE && (
              <Rise at={UNSURE} y={16}>
                <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
                  <Chip label="UNSURE" tone="pending" mono size={21} />
                  <Mono size={20} color={C.dim}>
                    a real answer, not a failure — so it asks you
                  </Mono>
                </div>
              </Rise>
            )}

            {/* The question, with the answer already filled in. */}
            {f >= QUESTION && (
              <Rise at={QUESTION} y={20}>
                <Pane raised pad={26} style={{ width: 620 }}>
                  <Mono size={18} color={C.pendingText}>
                    waiting on you
                  </Mono>
                  <div
                    style={{
                      fontFamily: F.ui,
                      fontSize: 28,
                      color: C.fg,
                      fontWeight: 500,
                      marginTop: 10,
                      letterSpacing: -0.6,
                    }}
                  >
                    What weight was on the bar?
                  </div>
                  <div
                    style={{
                      marginTop: 16,
                      display: "flex",
                      alignItems: "center",
                      gap: 16,
                    }}
                  >
                    <div
                      style={{
                        padding: "12px 20px",
                        borderRadius: R.r,
                        background: C.glassHi,
                        border: `1px solid ${C.line}`,
                        fontFamily: F.mono,
                        fontSize: 28,
                        color: C.fg,
                        fontWeight: 700,
                      }}
                    >
                      60 kg
                    </div>
                    <Mono size={19} color={C.dimmer}>
                      already filled in · one tap
                    </Mono>
                  </div>
                </Pane>
              </Rise>
            )}
          </div>
        </div>

        {/* What the answer is actually worth.

            A refit is measured on points the fit never saw, and one that
            does not beat the holdout is reported and thrown away rather than
            shipped. Showing the discarded one beside the accepted one is the
            single most trust-earning detail available here: a system that
            only ever reports improvements is not reporting anything. */}
        {f >= LABEL && (
          <Rise at={LABEL} style={{ marginTop: 30 }}>
            <div style={{ display: "flex", alignItems: "stretch", gap: 24 }}>
              <div
                style={{
                  padding: "18px 22px",
                  borderRadius: R.r2,
                  background: C.glass,
                  border: `1px solid ${C.hair}`,
                  minWidth: 300,
                }}
              >
                <Mono size={17} color={C.dimmer}>
                  labels for this skill
                </Mono>
                <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap", width: 262 }}>
                  {Array.from({ length: 22 }, (_, i) => {
                    const p = inOut(f, LABEL + 6 + i * 1.6, 11);
                    return (
                      <div
                        key={i}
                        style={{
                          width: 20,
                          height: 20,
                          borderRadius: 4,
                          background: C.provedWash,
                          border: `1px solid ${C.provedEdge}`,
                          opacity: p,
                          transform: `scale(${0.7 + p * 0.3})`,
                        }}
                      />
                    );
                  })}
                </div>
              </div>

              <Refit
                at={LABEL + 26}
                n="41"
                before="0.67"
                after="0.75"
                verdict="accepted"
                good
              />
              <Refit
                at={LABEL + 46}
                n="12"
                before="0.71"
                after="0.69"
                verdict="discarded"
              />

              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  opacity: inOut(f, LABEL + 64, 16),
                }}
              >
                <div
                  style={{
                    fontFamily: F.display,
                    fontSize: 30,
                    fontWeight: 500,
                    color: C.dim,
                    letterSpacing: -0.7,
                    lineHeight: 1.35,
                  }}
                >
                  The models never change —{" "}
                  <span style={{ color: C.fg, fontWeight: 600 }}>
                    the detector on top sharpens.
                  </span>
                </div>
              </div>
            </div>
          </Rise>
        )}
      </div>
    </AbsoluteFill>
  );
};

/** One refit, with the holdout numbers that decided its fate. */
const Refit: React.FC<{
  at: number;
  n: string;
  before: string;
  after: string;
  verdict: string;
  good?: boolean;
}> = ({ at, n, before, after, verdict, good }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 16);
  return (
    <div
      style={{
        opacity: p * (good ? 1 : 0.62),
        transform: `translateY(${(1 - p) * 14}px)`,
        padding: "18px 22px",
        borderRadius: R.r2,
        background: good ? C.provedWash : C.sunk,
        border: `1px solid ${good ? C.provedEdge : C.hair}`,
        minWidth: 250,
      }}
    >
      <Mono size={17} color={C.dimmer}>
        refit · n={n}
      </Mono>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 10 }}>
        <span style={{ fontFamily: F.mono, fontSize: 28, color: C.dimmer }}>{before}</span>
        <span style={{ fontFamily: F.mono, fontSize: 20, color: C.dimmer }}>→</span>
        <span
          style={{
            fontFamily: F.mono,
            fontSize: 34,
            fontWeight: 700,
            color: good ? C.provedText : C.dim,
          }}
        >
          {after}
        </span>
      </div>
      <div style={{ marginTop: 8 }}>
        <Mono size={15} color={C.dimmer}>
          holdout · {verdict}
        </Mono>
      </div>
    </div>
  );
};
