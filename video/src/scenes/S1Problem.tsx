/**
 * Beat 1 - the problem. 0:00 to 0:23.
 *
 * "Everyone has goals. The hard part was never deciding - it's keeping track.
 *  So for the Nebius and NVIDIA hackathon, we built a personal assistant that
 *  watches, and keeps you on top of them. But sending frames of your day into
 *  a frontier model runs hundreds of dollars a day, per camera. So Pact is
 *  designed to do it for almost nothing."
 *
 * The line names two columns - decided, and tracked - so the scene draws
 * exactly those. Every goal ticks the first one as it arrives, and the second
 * stays empty. Nobody has to be told which half is hard; the empty column is
 * the argument, and it is still sitting there when the narration names it.
 *
 * An earlier version showed four things people keep by hand - a habit app, a
 * spreadsheet, paper. That was built for "none of it tracks itself", a line
 * this script no longer has, and four artefacts is a lot of looking for a
 * phrase that lasts 1.3 seconds.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, F, R } from "../lib/theme";
import { Rise, WordsOn, Mono, inOut, Eyebrow, Phase } from "../lib/prims";
import { CostStream } from "./parts/CostStream";
import { timing } from "../lib/beats";

const t = timing("b1");

const AMBITIONS = [
  "Run in the morning",
  "Get stronger",
  "Keep the place clean",
  "Read before bed",
  "Call home more",
];

const Tick: React.FC<{ on: number }> = ({ on }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
    <path
      d="M5 12.5l4.5 4.5L19 7.5"
      stroke={C.proved}
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray="24"
      strokeDashoffset={24 * (1 - on)}
    />
  </svg>
);

export const S1Problem: React.FC = () => {
  const f = useCurrentFrame();

  const COST = t("frontier") - 12;
  const FLIP = t("almostNothing") - 10;

  return (
    <AbsoluteFill>
      {/* ---- decided, and tracked ---- */}
      {f < COST + 14 && (
        <Phase from={0} to={COST} scale={1.22}>
          <div style={{ width: 1080 }}>
            <WordsOn
              text="Everyone has goals."
              at={t("goals")}
              every={4}
              style={{
                fontFamily: F.display,
                fontSize: 76,
                fontWeight: 700,
                color: C.fg,
                letterSpacing: -2.8,
              }}
            />

            <div style={{ height: 36 }} />

            {/* Two columns, and only one of them ever fills. */}
            <div style={{ display: "flex", gap: 20, marginBottom: 14, paddingRight: 8 }}>
              <div style={{ flex: 1 }} />
              <div style={{ width: 120, textAlign: "center" }}>
                <Mono size={17} color={C.dimmer}>
                  decided
                </Mono>
              </div>
              <div style={{ width: 120, textAlign: "center" }}>
                <Mono size={17} color={C.dimmer}>
                  tracked
                </Mono>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
              {AMBITIONS.map((a, i) => {
                const born = t("goals") + 14 + i * 9;
                const p = inOut(f, born, 15);
                return (
                  <div
                    key={a}
                    style={{
                      opacity: p,
                      transform: `translateY(${(1 - p) * 12}px)`,
                      display: "flex",
                      alignItems: "center",
                      gap: 20,
                      padding: "14px 22px",
                      borderRadius: R.r,
                      background: C.sunk,
                      border: `1px solid ${C.hair}`,
                    }}
                  >
                    <span
                      style={{
                        flex: 1,
                        fontFamily: F.ui,
                        fontSize: 27,
                        color: C.fg,
                        fontWeight: 500,
                        letterSpacing: -0.5,
                      }}
                    >
                      {a}
                    </span>
                    <span style={{ width: 120, display: "grid", placeItems: "center" }}>
                      <Tick on={inOut(f, born + 6, 12)} />
                    </span>
                    <span style={{ width: 120, display: "grid", placeItems: "center" }}>
                      {/* Deliberately nothing. */}
                      <span
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 999,
                          border: `1.5px dashed ${C.line}`,
                          opacity: inOut(f, born + 6, 12),
                        }}
                      />
                    </span>
                  </div>
                );
              })}
            </div>

            <Rise at={t("deciding")} style={{ marginTop: 34 }}>
              <div
                style={{
                  fontFamily: F.display,
                  fontSize: 36,
                  fontWeight: 500,
                  color: C.dim,
                  letterSpacing: -0.9,
                }}
              >
                The hard part was never deciding
                {f >= t("keepingTrack") && (
                  <span style={{ color: C.fg, fontWeight: 700, opacity: inOut(f, t("keepingTrack"), 14) }}>
                    {" "}
                    — it's keeping track.
                  </span>
                )}
              </div>
            </Rise>

            {/* What we built, named where the line names it. */}
            <Rise at={t("hackathon")} style={{ marginTop: 30 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <Mono size={19} color={C.watchText} style={{ letterSpacing: 2 }}>
                  NEBIUS × NVIDIA HACKATHON
                </Mono>
                {f >= t("builtOne") && (
                  <span style={{ opacity: inOut(f, t("builtOne"), 14), display: "flex", gap: 12 }}>
                    <span style={{ width: 22, height: 1, background: C.line, alignSelf: "center" }} />
                    <Mono size={19} color={C.dim}>
                      an assistant that watches
                    </Mono>
                  </span>
                )}
              </div>
            </Rise>
          </div>
        </Phase>
      )}

      {/* ---- what watching costs the obvious way ---- */}
      {f >= COST - 4 && f < FLIP + 12 && (
        <Phase from={COST} to={FLIP}>
          <div>
            <div style={{ marginLeft: 4 }}>
              <Eyebrow at={COST + 2}>every frame, to a frontier model</Eyebrow>
            </div>
            <CostStream at={COST + 8} />
          </div>
        </Phase>
      )}

      {/* ---- the flip ---- */}
      {f >= FLIP - 4 && (
        <Phase from={FLIP} scale={1.12}>
          <div style={{ textAlign: "center" }}>
            <Rise at={FLIP + 8} y={28}>
              <div
                style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 22 }}
              >
                <Hex at={FLIP + 10} />
                <div
                  style={{
                    fontFamily: F.display,
                    fontSize: 128,
                    fontWeight: 700,
                    color: C.fg,
                    letterSpacing: -5,
                    lineHeight: 1,
                  }}
                >
                  pact
                </div>
              </div>
            </Rise>
            <Rise at={FLIP + 28} y={20}>
              <div
                style={{
                  marginTop: 24,
                  fontFamily: F.mono,
                  fontSize: 25,
                  letterSpacing: 3,
                  color: C.provedText,
                  textTransform: "uppercase",
                }}
              >
                designed to do it for almost nothing
              </div>
            </Rise>
          </div>
        </Phase>
      )}
    </AbsoluteFill>
  );
};

/** The product's own mark, drawn on. Stroke only - green is never a surface. */
export const Hex: React.FC<{ at: number; size?: number }> = ({ at, size = 92 }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 30);
  return (
    <svg width={size} height={size} viewBox="0 0 20 20">
      <path
        d="M10 1.4 17.4 5.7v8.6L10 18.6 2.6 14.3V5.7z"
        fill="none"
        stroke={C.proved}
        strokeWidth="1.5"
        strokeDasharray="44"
        strokeDashoffset={44 * (1 - p)}
      />
      <path
        d="M5.8 12.1h8.4"
        stroke={C.fg}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="9"
        strokeDashoffset={9 * (1 - inOut(f, at + 16, 16))}
      />
    </svg>
  );
};
