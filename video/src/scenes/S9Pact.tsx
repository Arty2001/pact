/**
 * Beat 9 - the pact. 2:31 to 2:46.
 *
 * "Every goal is a few things a camera can see, and a rule about them. No
 *  video is kept. Every goal it settled is still there to explain. You already
 *  made the promise. Pact is the part that keeps it."
 *
 * The close has to do two jobs in twelve seconds: compress the whole system
 * into one line somebody could repeat at a judging table, and answer the
 * question anybody sensible asks about a camera in their house.
 *
 * So the first phase is the reduction - the three sub-goals from beat 3 and
 * the rule over them, as one expression. The second is the two facts that
 * sound contradictory and are not: nothing is kept, and everything can still
 * be explained. Those sit side by side deliberately, with the thing that
 * actually persists spelled out in bytes, because "privacy-first" as a claim
 * is worth nothing and 4.6 KB of floats is worth something.
 *
 * Then the mark, and the only sentence in the film that is allowed to be a
 * little bit of a promise.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, F, R } from "../lib/theme";
import { Rise, Mono, inOut, Eyebrow, Chip, Phase, WordsOn } from "../lib/prims";
import { timing } from "../lib/beats";
import { Hex } from "./S1Problem";

const t = timing("b9");

/** The three sub-goals, exactly as beat 3 named them. */
const SEEN = [
  { label: "someone in a room", kind: "gate" },
  { label: "someone in a pushup position", kind: "action" },
  { label: "20 of them", kind: "counter" },
];

/** What is actually on disk after a day of watching. */
const KEPT = [
  { k: "the frame", v: "discarded", gone: true },
  { k: "1152 floats", v: "4.6 KB", gone: false },
  { k: "the verdict", v: "1 row", gone: false },
];

/** The trail behind one settled goal. Every number comes from an earlier beat. */
const TRAIL = [
  { time: "07:14:08", what: "someone in a room", detail: "gate · passed · 0.88" },
  { time: "07:14:22", what: "someone in a pushup position", detail: "action · held 0.61 s" },
  { time: "07:21:40", what: "20 of them", detail: "counter · 20 / 20 · before 12:00" },
];

export const S9Pact: React.FC = () => {
  const f = useCurrentFrame();

  const KEEP = t("noVideo") - 12;
  const CLOSE = t("promise") - 14;

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      {/* ---- what a goal is, in one expression ---- */}
      {f < KEEP + 14 && (
        <Phase from={0} to={KEEP} scale={1.26}>
          <div style={{ width: 1340 }}>
            <Eyebrow at={t("fewThings")}>every goal, all the way down</Eyebrow>

            <div style={{ display: "flex", gap: 36, alignItems: "stretch" }}>
              {/* A few things a camera can see. */}
              <div style={{ flex: 1 }}>
                <Mono size={18} color={C.dimmer}>
                  a few things a camera can see
                </Mono>
                <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                  {SEEN.map((s, i) => {
                    const p = inOut(f, t("fewThings") + 8 + i * 9, 15);
                    return (
                      <div
                        key={s.label}
                        style={{
                          opacity: p,
                          transform: `translateY(${(1 - p) * 12}px)`,
                          display: "flex",
                          alignItems: "center",
                          gap: 14,
                          padding: "15px 20px",
                          borderRadius: R.r,
                          background: C.watchWash,
                          border: `1px solid ${C.watchEdge}`,
                        }}
                      >
                        <span
                          style={{ width: 9, height: 9, borderRadius: 999, background: C.watch }}
                        />
                        <span
                          style={{
                            flex: 1,
                            fontFamily: F.ui,
                            fontSize: 24,
                            color: C.fg,
                            fontWeight: 500,
                            letterSpacing: -0.5,
                          }}
                        >
                          {s.label}
                        </span>
                        <Mono size={16} color={C.watchText}>
                          {s.kind}
                        </Mono>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: "grid", placeItems: "center", width: 40 }}>
                <div
                  style={{
                    fontFamily: F.display,
                    fontSize: 48,
                    fontWeight: 300,
                    color: C.dimmer,
                    opacity: inOut(f, t("aRule") - 6, 14),
                  }}
                >
                  +
                </div>
              </div>

              {/* And a rule about them. */}
              <div style={{ flex: 1 }}>
                <Mono size={18} color={C.dimmer}>
                  and a rule about them
                </Mono>
                <Rise at={t("aRule")} style={{ marginTop: 14 }} y={14}>
                  <div
                    style={{
                      padding: 24,
                      borderRadius: R.r2,
                      background: C.glassTop,
                      border: `2px solid ${C.provedEdge}`,
                      minHeight: 176,
                      boxSizing: "border-box",
                    }}
                  >
                    {[
                      "gate passes",
                      "→ action held ≥ 0.50 s",
                      "→ counter reaches 20",
                      "→ before 12:00",
                    ].map((l, i) => (
                      <div
                        key={l}
                        style={{
                          opacity: inOut(f, t("aRule") + 6 + i * 7, 14),
                          marginLeft: i * 16,
                          marginTop: i ? 7 : 0,
                        }}
                      >
                        <Mono size={21} color={i === 0 ? C.fg : C.provedText} style={{ fontWeight: 600 }}>
                          {l}
                        </Mono>
                      </div>
                    ))}
                  </div>
                </Rise>
              </div>
            </div>

            <Rise at={t("aRule") + 34} style={{ marginTop: 30, textAlign: "center" }} y={16}>
              <Mono size={19} color={C.dimmer}>
                that is the whole data model · six kinds of sub-goal, differing only in their numbers
              </Mono>
            </Rise>
          </div>
        </Phase>
      )}

      {/* ---- nothing kept, everything explainable ---- */}
      {f >= KEEP - 4 && f < CLOSE + 14 && (
        <Phase from={KEEP} to={CLOSE} scale={1.2}>
          <div style={{ width: 1480, display: "flex", gap: 44, alignItems: "stretch" }}>
            {/* No video is kept - and what replaces it, in bytes. */}
            <div style={{ width: 560 }}>
              <Eyebrow at={t("noVideo")}>no video is kept</Eyebrow>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {KEPT.map((r, i) => {
                  const p = inOut(f, t("noVideo") + 6 + i * 10, 15);
                  return (
                    <div
                      key={r.k}
                      style={{
                        opacity: p,
                        transform: `translateX(${(1 - p) * -12}px)`,
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "15px 20px",
                        borderRadius: R.r,
                        background: r.gone ? C.sunk : C.provedWash,
                        border: `1px ${r.gone ? "dashed" : "solid"} ${
                          r.gone ? C.line : C.provedEdge
                        }`,
                      }}
                    >
                      <Mono
                        size={20}
                        color={r.gone ? C.dimmer : C.fg}
                        style={{ textDecoration: r.gone ? "line-through" : "none" }}
                      >
                        {r.k}
                      </Mono>
                      <Mono
                        size={20}
                        color={r.gone ? C.dimmer : C.provedText}
                        style={{ fontWeight: 700 }}
                      >
                        {r.v}
                      </Mono>
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: 16, opacity: inOut(f, t("noVideo") + 40, 16) }}>
                <Mono size={17} color={C.dimmer}>
                  a day of one camera at 0.5 Hz · about 200 MB of numbers
                </Mono>
              </div>
            </div>

            {/* And the receipt, which is why that is not a trade-off. */}
            <div style={{ flex: 1 }}>
              <Eyebrow at={t("stillExplain")}>every goal it settled is still there to explain</Eyebrow>
              <div
                style={{
                  padding: 24,
                  borderRadius: R.r2,
                  background: C.glassTop,
                  border: `1px solid ${C.hair}`,
                  opacity: inOut(f, t("stillExplain"), 16),
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
                  <Chip label="done · 07:21:40" tone="proved" mono size={17} />
                  <span
                    style={{
                      fontFamily: F.ui,
                      fontSize: 23,
                      color: C.fg,
                      fontWeight: 600,
                      letterSpacing: -0.5,
                    }}
                  >
                    20 pushups every morning
                  </span>
                </div>
                {TRAIL.map((r, i) => {
                  const p = inOut(f, t("stillExplain") + 10 + i * 9, 14);
                  return (
                    <div
                      key={r.what}
                      style={{
                        opacity: p,
                        transform: `translateX(${(1 - p) * -10}px)`,
                        display: "flex",
                        alignItems: "center",
                        gap: 16,
                        padding: "11px 0",
                        borderTop: i ? `1px solid ${C.hair}` : "none",
                      }}
                    >
                      <Mono size={17} color={C.dimmer} style={{ width: 92 }}>
                        {r.time}
                      </Mono>
                      <span
                        style={{
                          flex: 1,
                          fontFamily: F.ui,
                          fontSize: 20,
                          color: C.fg,
                          fontWeight: 500,
                        }}
                      >
                        {r.what}
                      </span>
                      <Mono size={17} color={C.provedText}>
                        {r.detail}
                      </Mono>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </Phase>
      )}

      {/* ---- the close ---- */}
      {f >= CLOSE - 4 && (
        <Phase from={CLOSE} scale={1.14}>
          <div style={{ textAlign: "center" }}>
            <WordsOn
              text="You already made the promise."
              at={t("promise")}
              every={4}
              style={{
                fontFamily: F.display,
                fontSize: 62,
                fontWeight: 500,
                color: C.dim,
                letterSpacing: -2,
              }}
            />

            <Rise at={t("keepsIt")} style={{ marginTop: 30 }} y={26}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 26,
                }}
              >
                <Hex at={t("keepsIt") + 2} size={104} />
                <div
                  style={{
                    fontFamily: F.display,
                    fontSize: 142,
                    fontWeight: 700,
                    color: C.fg,
                    letterSpacing: -6,
                    lineHeight: 1,
                  }}
                >
                  pact
                </div>
              </div>
            </Rise>

            <Rise at={t("keepsIt") + 18} style={{ marginTop: 18 }} y={18}>
              <div
                style={{
                  fontFamily: F.display,
                  fontSize: 40,
                  fontWeight: 500,
                  color: C.fg,
                  letterSpacing: -1.2,
                }}
              >
                is the part that <span style={{ color: C.provedText }}>keeps it.</span>
              </div>
            </Rise>

            <Rise at={t("keepsIt") + 40} style={{ marginTop: 40 }} y={14}>
              <div style={{ display: "flex", justifyContent: "center", gap: 22 }}>
                <Mono size={21} color={C.dimmer} style={{ letterSpacing: 2.4 }}>
                  pact.lanvar.ai
                </Mono>
                <span style={{ width: 1, background: C.line }} />
                <Mono size={21} color={C.dimmer} style={{ letterSpacing: 2.4 }}>
                  NEBIUS × NVIDIA 2026
                </Mono>
              </div>
            </Rise>
          </div>
        </Phase>
      )}
    </AbsoluteFill>
  );
};
