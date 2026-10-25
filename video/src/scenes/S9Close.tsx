/**
 * Beat 9 - close. 2:44 to 2:56.
 *
 * The registry, with every goal from the film in it and the skill each one
 * uses marked. The pattern is the argument: the same dots light for different
 * goals, and "wash up after dinner" lights two that already existed and adds
 * nothing. Five goals, six skills, ten references - which is the claim the
 * whole video has been making, finally shown as a count rather than said.
 *
 * The end frame has to survive being screenshotted on its own, because it is
 * the frame that ends up in a thread. So it carries the mark, the URL and the
 * three models credited, and nothing else.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { C, F, R, s } from "../lib/theme";
import { Rise, Mono, inOut, Chip, Eyebrow, Phase } from "../lib/prims";
import { Hex } from "./S1Bug";

/** Six skills, shared across five goals. Indices below point into this. */
const SKILLS = [
  "living room",
  "pushup position",
  "at the sink",
  "dishes present",
  "bins by the door",
  "pill box",
];

const GOALS: Array<{
  label: string;
  kind: string;
  tone: "proved" | "pending" | "watch";
  uses: number[];
  added: number;
}> = [
  { label: "20 pushups every morning", kind: "counter", tone: "proved", uses: [0, 1], added: 2 },
  { label: "keep the sink clear", kind: "limit", tone: "proved", uses: [2, 3], added: 2 },
  { label: "wash up after dinner", kind: "target", tone: "proved", uses: [2, 3], added: 0 },
  { label: "bins out on Tuesday", kind: "target", tone: "proved", uses: [4], added: 1 },
  { label: "has Dad taken his pills?", kind: "target", tone: "pending", uses: [5], added: 1 },
];

const REFERENCES = GOALS.reduce((n, g) => n + g.uses.length, 0);

export const S9Close: React.FC = () => {
  const f = useCurrentFrame();
  const END = s(8.6);
  // Caught from beat 8's cost cards, which were about this registry.
  const CATCH = inOut(f, 0, 18);

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      {f < END + 14 && (
        <Phase from={0} to={END - 10}>
          <div
            style={{
              width: 1420,
              transform: `scale(${1.07 - 0.07 * CATCH})`,
              opacity: CATCH,
            }}
          >
            <div
              style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}
            >
              <Eyebrow at={2}>everything from this video, still running</Eyebrow>
              <div style={{ marginBottom: 22, display: "flex", gap: 18 }}>
                <Mono size={19} color={C.dimmer}>
                  <span style={{ color: C.fg, fontWeight: 700 }}>{GOALS.length}</span> goals
                </Mono>
                <Mono size={19} color={C.dimmer}>
                  <span style={{ color: C.fg, fontWeight: 700 }}>{SKILLS.length}</span> skills
                </Mono>
                <Mono size={19} color={C.dimmer}>
                  <span style={{ color: C.fg, fontWeight: 700 }}>{REFERENCES}</span> references
                </Mono>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
              {GOALS.map((g, i) => {
                const p = inOut(f, 4 + i * 7, 16);
                const k =
                  g.tone === "pending"
                    ? { t: C.pendingText, w: C.pendingWash, e: C.pendingEdge, s: C.pending }
                    : { t: C.provedText, w: C.provedWash, e: C.provedEdge, s: C.proved };
                return (
                  <div
                    key={g.label}
                    style={{
                      opacity: p,
                      transform: `translateX(${(1 - p) * -18}px)`,
                      display: "flex",
                      alignItems: "center",
                      gap: 18,
                      padding: "16px 22px",
                      borderRadius: R.r,
                      background: k.w,
                      border: `1px solid ${k.e}`,
                    }}
                  >
                    <span
                      style={{ width: 10, height: 10, borderRadius: 999, background: k.s }}
                    />
                    <span
                      style={{
                        flex: 1,
                        fontFamily: F.ui,
                        fontSize: 27,
                        color: C.fg,
                        fontWeight: 500,
                        letterSpacing: -0.6,
                      }}
                    >
                      {g.label}
                    </span>

                    {/* Which of the six skills this goal uses. The pattern
                        repeating down the column IS the reuse. */}
                    <div style={{ display: "flex", gap: 6 }}>
                      {SKILLS.map((sk, j) => (
                        <div
                          key={sk}
                          style={{
                            width: 15,
                            height: 15,
                            borderRadius: 4,
                            background: g.uses.includes(j) ? k.s : "transparent",
                            border: `1px solid ${g.uses.includes(j) ? k.e : C.line}`,
                            opacity: g.uses.includes(j) ? 1 : 0.5,
                          }}
                        />
                      ))}
                    </div>

                    <span style={{ width: 150, textAlign: "right" }}>
                      <Mono
                        size={17}
                        color={g.added === 0 ? C.provedText : C.dimmer}
                        style={{ fontWeight: g.added === 0 ? 700 : 400 }}
                      >
                        {g.added === 0 ? "added nothing" : `+${g.added} new`}
                      </Mono>
                    </span>
                    <Mono size={16} color={C.dimmer} style={{ width: 76, textAlign: "right" }}>
                      {g.kind}
                    </Mono>
                  </div>
                );
              })}
            </div>

            {/* The cost of all of it, which does not move as goals are added. */}
            <div
              style={{
                marginTop: 28,
                display: "flex",
                alignItems: "center",
                gap: 22,
                opacity: inOut(f, s(3.4), 16),
              }}
            >
              <svg width="560" height="40" style={{ overflow: "visible" }}>
                <line x1="0" x2="560" y1="20" y2="20" stroke={C.hair} strokeWidth="1.5" />
                <line
                  x1="0"
                  x2={interpolate(f, [s(3.6), s(6.4)], [0, 560], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  })}
                  y1="20"
                  y2="20"
                  stroke={C.proved}
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>
              <Mono size={21} color={C.provedText}>
                cost, as goals are added
              </Mono>
            </div>

            <Rise at={s(4.4)} style={{ marginTop: 26 }}>
              <div
                style={{
                  fontFamily: F.display,
                  fontSize: 36,
                  fontWeight: 500,
                  color: C.dim,
                  letterSpacing: -0.9,
                }}
              >
                No video is kept.{" "}
                <span style={{ color: C.fg, fontWeight: 600 }}>
                  Every goal it settled is still there to explain.
                </span>
              </div>
            </Rise>
          </div>
        </Phase>
      )}

      {/* The end frame. Must stand alone as a screenshot. */}
      {f >= END - 4 && (
        <Phase from={END}>
          <div style={{ textAlign: "center" }}>
            <div
              style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 24 }}
            >
              <Hex at={END + 4} size={104} />
              <div
                style={{
                  fontFamily: F.display,
                  fontSize: 140,
                  fontWeight: 700,
                  color: C.fg,
                  letterSpacing: -5.5,
                  lineHeight: 1,
                }}
              >
                pact
              </div>
            </div>

            <Rise at={END + 18} style={{ marginTop: 22 }}>
              <div
                style={{
                  fontFamily: F.mono,
                  fontSize: 27,
                  letterSpacing: 2.4,
                  color: C.provedText,
                }}
              >
                pact.lanvar.ai
              </div>
            </Rise>

            <Rise at={END + 32} style={{ marginTop: 40 }}>
              <div style={{ display: "flex", gap: 14, justifyContent: "center" }}>
                <Chip label="C-RADIO v3-B" tone="none" mono size={19} />
                <Chip label="Nemotron 3 Super 120B" tone="none" mono size={19} />
                <Chip label="Nemotron 3.5 Super VL" tone="none" mono size={19} />
              </div>
            </Rise>

            <Rise at={END + 44} style={{ marginTop: 18 }}>
              <Mono size={20} color={C.dimmer}>
                NVIDIA open models · Nebius Token Factory &amp; AI Cloud
              </Mono>
            </Rise>
          </div>
        </Phase>
      )}
    </AbsoluteFill>
  );
};
