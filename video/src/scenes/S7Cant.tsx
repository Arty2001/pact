/**
 * Beat 7 - when it can't tell. 1:49 to 2:11.
 *
 * "When it can't tell on its own, it doesn't guess. Four frames go to Nemotron
 *  three point five Super V L. When even that's unsure, or no camera could
 *  read it, like the weight on a bar, it asks you. Your answer becomes a new
 *  label. The models never change, but the detector on top sharpens."
 *
 * An escalation, so the scene is built as one: three rungs, each with what it
 * costs and what it is allowed to decide. The first rung's 0.52 is placed
 * inside the same band beat 6 just spent fifteen seconds establishing, which
 * is what makes "can't tell" mean something specific rather than vague.
 *
 * The last phase is the only claim in the film that could be mistaken for
 * fine-tuning, so it is drawn to be unmistakable: the two model cards are
 * stamped frozen and stay on screen while the only thing that moves is the
 * boundary of the linear probe above them. The holdout number is there because
 * a refit that does not beat it is thrown away, and that rule is the reason
 * this is a safe thing to do at all.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, F, R } from "../lib/theme";
import { Rise, Mono, inOut, Eyebrow, Chip, Phase, TypeOn, CountUp, DrawArrow } from "../lib/prims";
import { FootageSlot } from "../lib/footage";
import { timing } from "../lib/beats";

const t = timing("b7");

/* --------------------------------------------------------------- the rungs */

const Rung: React.FC<{
  at: number;
  n: string;
  who: string;
  what: string;
  cost: string;
  verdict: React.ReactNode;
  tone: "none" | "watch" | "proved";
  last?: boolean;
}> = ({ at, n, who, what, cost, verdict, tone, last }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 16);
  const kit =
    tone === "proved"
      ? { wash: C.provedWash, edge: C.provedEdge }
      : tone === "watch"
        ? { wash: C.watchWash, edge: C.watchEdge }
        : { wash: C.sunk, edge: C.hair };
  return (
    <div style={{ opacity: p, transform: `translateY(${(1 - p) * 16}px)` }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 22,
          padding: "22px 26px",
          borderRadius: R.r2,
          background: kit.wash,
          border: `1px solid ${kit.edge}`,
        }}
      >
        <Mono size={20} color={C.dimmer} style={{ width: 28, fontWeight: 700 }}>
          {n}
        </Mono>
        <div style={{ width: 530 }}>
          <div
            style={{
              fontFamily: F.ui,
              fontSize: 27,
              color: C.fg,
              fontWeight: 600,
              letterSpacing: -0.7,
              whiteSpace: "nowrap",
            }}
          >
            {who}
          </div>
          <div style={{ marginTop: 4 }}>
            <Mono size={17} color={C.dimmer}>
              {what}
            </Mono>
          </div>
        </div>
        <Mono size={18} color={C.dimmer} style={{ width: 160, whiteSpace: "nowrap" }}>
          {cost}
        </Mono>
        <div style={{ marginLeft: "auto" }}>{verdict}</div>
      </div>

      {/* The escalation itself, drawn downward. */}
      {!last && (
        <svg width="40" height="34" style={{ marginLeft: 44, display: "block" }}>
          <DrawArrow d="M 14 2 V 30" at={at + 16} dur={12} color={C.line} width={1.6} id={`e${n}`} />
        </svg>
      )}
    </div>
  );
};

/** Where 0.52 sits. The same two thresholds as the previous beat. */
const Band: React.FC<{ at: number; v: number }> = ({ at, v }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 16);
  const W = 230;
  return (
    <div style={{ opacity: p, width: W }}>
      <div style={{ position: "relative", height: 10, borderRadius: 999, background: C.sunk }}>
        <div
          style={{
            position: "absolute",
            left: `${0.45 * 100}%`,
            width: `${(0.75 - 0.45) * 100}%`,
            top: 0,
            bottom: 0,
            background: "rgba(16,36,54,.10)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: `${v * 100}%`,
            top: -4,
            width: 3,
            height: 18,
            borderRadius: 2,
            background: C.fg,
          }}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7 }}>
        <Mono size={15} color={C.pendingText}>
          0.45
        </Mono>
        <Mono size={15} color={C.dimmer}>
          can't tell
        </Mono>
        <Mono size={15} color={C.provedText}>
          0.75
        </Mono>
      </div>
    </div>
  );
};

/* ---------------------------------------------------------------- the refit */

/** Points in the probe's space. Deterministic, so the boundary means something. */
const PTS = Array.from({ length: 46 }, (_, i) => {
  const a = Math.sin(i * 12.9898) * 43758.5453;
  const b = Math.sin(i * 78.233) * 12345.6789;
  const u = a - Math.floor(a);
  const v = b - Math.floor(b);
  // Two loose clusters, with a handful of points in between - which is why a
  // boundary can be improved at all.
  const pos = i % 2 === 0;
  return {
    x: (pos ? 0.62 : 0.28) + (u - 0.5) * 0.3,
    y: (pos ? 0.32 : 0.7) + (v - 0.5) * 0.3,
    pos,
  };
});

const Probe: React.FC<{ at: number }> = ({ at }) => {
  const f = useCurrentFrame();
  const W = 420;
  const H = 300;
  const p = inOut(f, at, 16);
  // The only thing that changes. Before: the zero-shot prior's boundary.
  // After: the refit, nudged by one new label.
  const m = inOut(f, at + 34, 30);
  const a0 = -0.62;
  const a1 = -0.86;
  const a = a0 + (a1 - a0) * m;
  const b0 = 0.86;
  const b1 = 0.95;
  const b = b0 + (b1 - b0) * m;

  const px = (u: number) => 18 + u * (W - 36);
  const py = (v: number) => 18 + v * (H - 36);

  return (
    <div
      style={{
        width: W,
        height: H,
        position: "relative",
        opacity: p,
        borderRadius: R.r2,
        background: C.glassHi,
        border: `1px solid ${C.hair}`,
        overflow: "hidden",
      }}
    >
      <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
        {[1, 2, 3].map((i) => (
          <g key={i} stroke="rgba(16,36,54,.05)" strokeWidth="1">
            <line x1={(i * W) / 4} x2={(i * W) / 4} y1="0" y2={H} />
            <line x1="0" x2={W} y1={(i * H) / 4} y2={(i * H) / 4} />
          </g>
        ))}

        {/* The old boundary stays, faint, so the move is measurable. */}
        <line
          x1={px(0)}
          y1={py(b0)}
          x2={px(1)}
          y2={py(b0 + a0)}
          stroke={C.line}
          strokeWidth="1.4"
          strokeDasharray="5 5"
          opacity={m > 0.05 ? 0.8 : 0}
        />
        <line
          x1={px(0)}
          y1={py(b)}
          x2={px(1)}
          y2={py(b + a)}
          stroke={C.proved}
          strokeWidth="2.6"
          strokeLinecap="round"
        />

        {PTS.map((pt, i) => (
          <circle
            key={i}
            cx={px(pt.x)}
            cy={py(pt.y)}
            r="4.5"
            fill={pt.pos ? C.proved : C.dimmer}
            opacity={inOut(f, at + 6 + i, 10) * 0.75}
          />
        ))}

        {/* The one new label. Ringed, because it is the whole input. */}
        <circle
          cx={px(0.44)}
          cy={py(0.44)}
          r="7"
          fill={C.watch}
          opacity={inOut(f, at + 26, 14)}
        />
        <circle
          cx={px(0.44)}
          cy={py(0.44)}
          r={9 + 4 * Math.abs(Math.sin(f / 15))}
          fill="none"
          stroke={C.watch}
          strokeWidth="1.5"
          opacity={inOut(f, at + 26, 14) * 0.5}
        />
      </svg>
      <div style={{ position: "absolute", left: 14, bottom: 12 }}>
        <Mono size={15} color={C.dimmer}>
          linear probe · 1152 → 1
        </Mono>
      </div>
    </div>
  );
};

export const S7Cant: React.FC = () => {
  const f = useCurrentFrame();

  const ASK = t("unsure") - 12;
  const REFIT = t("becomesLabel") - 12;

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      {/* ---- it escalates instead of guessing ---- */}
      {f < ASK + 14 && (
        <Phase from={0} to={ASK} scale={1.28}>
          <div style={{ width: 1160 }}>
            <Eyebrow at={t("cantTell")}>it doesn't guess</Eyebrow>

            <Rung
              at={t("cantTell") + 4}
              n="1"
              who="the probe, on the frame it already has"
              
              what="one dot product · no extra compute"
              cost="free"
              tone="none"
              verdict={<Band at={t("doesntGuess")} v={0.52} />}
            />
            <Rung
              at={t("fourFrames")}
              n="2"
              who="Nemotron 3.5 Super VL"
              what="4 frames · Nebius Token Factory"
              cost="once, not per frame"
              tone="watch"
              last
              verdict={
                <div style={{ textAlign: "right" }}>
                  <div style={{ opacity: inOut(f, t("fourFrames") + 30, 16) }}>
                    <Mono size={23} color={C.watchText} style={{ fontWeight: 700 }}>
                      “a pushup, mid-rep”
                    </Mono>
                  </div>
                  <div style={{ marginTop: 6, opacity: inOut(f, t("fourFrames") + 40, 16) }}>
                    <Mono size={18} color={C.dimmer}>
                      confident · 0.91
                    </Mono>
                  </div>
                </div>
              }
            />

            {/* The four frames, so "four" is a quantity and not a word. */}
            <div
              style={{
                marginTop: 26,
                marginLeft: 76,
                display: "flex",
                gap: 12,
                alignItems: "center",
              }}
            >
              {[0, 1, 2, 3].map((i) => {
                const p = inOut(f, t("fourFrames") + 8 + i * 5, 14);
                return (
                  <div
                    key={i}
                    style={{
                      width: 118,
                      height: 70,
                      borderRadius: 6,
                      background: "#0D1B26",
                      border: `1px solid ${C.watchEdge}`,
                      opacity: p,
                      transform: `translateY(${(1 - p) * 10}px)`,
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    <Mono size={15} color={C.onDarkDim}>
                      t−{3 - i}
                    </Mono>
                  </div>
                );
              })}
              <span style={{ marginLeft: 10, opacity: inOut(f, t("fourFrames") + 30, 16) }}>
                <Mono size={18} color={C.dimmer}>
                  the only frames that leave the machine
                </Mono>
              </span>
            </div>
          </div>
        </Phase>
      )}

      {/* ---- and when nothing can read it, it asks ---- */}
      {f >= ASK - 4 && f < REFIT + 14 && (
        <Phase from={ASK} to={REFIT} scale={1.16}>
          <div style={{ width: 1480, display: "flex", gap: 52, alignItems: "center" }}>
            <FootageSlot
              shot={4}
              note="loaded barbell, plates not legible"
              at={t("unsure")}
              w={620}
              h={400}
            />

            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {[
                  { at: t("unsure"), k: "the probe", v: "0.52 · can't tell" },
                  { at: t("unsure") + 20, k: "Nemotron 3.5 VL", v: "unsure" },
                  { at: t("noCamera"), k: "any camera", v: "cannot read a plate edge-on" },
                ].map((r) => {
                  const p = inOut(f, r.at, 15);
                  return (
                    <div
                      key={r.k}
                      style={{
                        opacity: p,
                        transform: `translateX(${(1 - p) * -12}px)`,
                        display: "flex",
                        justifyContent: "space-between",
                        padding: "13px 18px",
                        borderRadius: R.r,
                        background: C.sunk,
                        border: `1px solid ${C.hair}`,
                      }}
                    >
                      <Mono size={19} color={C.dimmer}>
                        {r.k}
                      </Mono>
                      <Mono size={19} color={C.badText} style={{ fontWeight: 600 }}>
                        {r.v}
                      </Mono>
                    </div>
                  );
                })}
              </div>

              {/* So it asks. One question, one field, and it is the product's
                  own assistant surface rather than a mock-up of one. */}
              <Rise at={t("asksYou")} style={{ marginTop: 28 }} y={22}>
                <div
                  style={{
                    padding: 26,
                    borderRadius: R.r2,
                    background: C.glassTop,
                    border: `2px solid ${C.pendingEdge}`,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <Chip label="pact asks" tone="pending" mono size={17} />
                    <Mono size={17} color={C.dimmer}>
                      once · then never again for this machine
                    </Mono>
                  </div>
                  <div
                    style={{
                      marginTop: 16,
                      fontFamily: F.display,
                      fontSize: 36,
                      fontWeight: 600,
                      color: C.fg,
                      letterSpacing: -1,
                    }}
                  >
                    How much weight is on the bar?
                  </div>
                  <div
                    style={{
                      marginTop: 18,
                      padding: "14px 20px",
                      borderRadius: R.r,
                      background: C.glassHi,
                      border: `1px solid ${C.line}`,
                    }}
                  >
                    <TypeOn
                      text="60 kg"
                      at={t("asksYou") + 22}
                      cps={9}
                      style={{
                        fontFamily: F.ui,
                        fontSize: 32,
                        color: C.fg,
                        fontWeight: 600,
                      }}
                    />
                  </div>
                </div>
              </Rise>
            </div>
          </div>
        </Phase>
      )}

      {/* ---- the answer becomes a label, and only the probe moves ---- */}
      {f >= REFIT - 4 && (
        <Phase from={REFIT} scale={1.1}>
          <div style={{ width: 1540 }}>
            <Eyebrow at={t("becomesLabel")}>your answer becomes a label</Eyebrow>

            <div style={{ display: "flex", gap: 48, alignItems: "flex-start" }}>
              <div>
                <Probe at={t("becomesLabel")} />
                <div style={{ marginTop: 14, display: "flex", gap: 18 }}>
                  <Mono size={17} color={C.dimmer}>
                    ·· prior
                  </Mono>
                  <Mono size={17} color={C.provedText}>
                    — refit
                  </Mono>
                </div>
              </div>

              <div style={{ flex: 1 }}>
                {/* What the refit actually did, with the rule that keeps it
                    honest: it has to beat the holdout or it is thrown away. */}
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {[
                    { at: t("becomesLabel") + 8, k: "labels for this skill", v: "22 → 23" },
                    { at: t("becomesLabel") + 22, k: "regularised toward", v: "the zero-shot prior" },
                  ].map((r) => {
                    const p = inOut(f, r.at, 14);
                    return (
                      <div
                        key={r.k}
                        style={{
                          opacity: p,
                          transform: `translateX(${(1 - p) * -12}px)`,
                          display: "flex",
                          justifyContent: "space-between",
                          padding: "13px 18px",
                          borderRadius: R.r,
                          background: C.sunk,
                          border: `1px solid ${C.hair}`,
                        }}
                      >
                        <Mono size={19} color={C.dimmer}>
                          {r.k}
                        </Mono>
                        <Mono size={19} color={C.fg} style={{ fontWeight: 600 }}>
                          {r.v}
                        </Mono>
                      </div>
                    );
                  })}

                  <div
                    style={{
                      opacity: inOut(f, t("becomesLabel") + 34, 16),
                      display: "flex",
                      alignItems: "center",
                      gap: 18,
                      padding: "16px 18px",
                      borderRadius: R.r,
                      background: C.provedWash,
                      border: `1px solid ${C.provedEdge}`,
                    }}
                  >
                    <Mono size={19} color={C.dimmer} style={{ flex: 1 }}>
                      holdout accuracy
                    </Mono>
                    <Mono size={19} color={C.dimmer}>
                      0.81 →
                    </Mono>
                    <Mono size={26} color={C.provedText} style={{ fontWeight: 700 }}>
                      <CountUp
                        to={0.89}
                        at={t("becomesLabel") + 40}
                        dur={28}
                        decimals={2}
                      />
                    </Mono>
                    <Chip label="kept" tone="proved" mono size={16} />
                  </div>

                  <div style={{ opacity: inOut(f, t("becomesLabel") + 54, 16), marginLeft: 2 }}>
                    <Mono size={17} color={C.dimmer}>
                      a refit that doesn't beat it is discarded
                    </Mono>
                  </div>
                </div>

                {/* The two things that did not move. */}
                <div style={{ marginTop: 30, display: "flex", gap: 16 }}>
                  {[
                    { n: "C-RADIOv3-B", d: "encoder" },
                    { n: "Nemotron 3.5 Super VL", d: "teacher" },
                  ].map((mdl, i) => {
                    const p = inOut(f, t("modelsNeverChange") + i * 10, 16);
                    return (
                      <div
                        key={mdl.n}
                        style={{
                          flex: 1,
                          opacity: p,
                          transform: `translateY(${(1 - p) * 12}px)`,
                          padding: "16px 20px",
                          borderRadius: R.r,
                          background: C.sunk,
                          border: `1px dashed ${C.line}`,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <LockIcon />
                          <Mono size={18} color={C.dim} style={{ fontWeight: 700 }}>
                            frozen
                          </Mono>
                        </div>
                        <div
                          style={{
                            marginTop: 8,
                            fontFamily: F.ui,
                            fontSize: 22,
                            color: C.fg,
                            fontWeight: 500,
                          }}
                        >
                          {mdl.n}
                        </div>
                        <div style={{ marginTop: 2 }}>
                          <Mono size={16} color={C.dimmer}>
                            {mdl.d}
                          </Mono>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <Rise at={t("sharpens")} style={{ marginTop: 30 }} y={18}>
              <div
                style={{
                  fontFamily: F.display,
                  fontSize: 40,
                  fontWeight: 600,
                  color: C.fg,
                  letterSpacing: -1.2,
                  textAlign: "center",
                }}
              >
                The models never change. The detector on top{" "}
                <span style={{ color: C.provedText }}>sharpens.</span>
              </div>
            </Rise>
          </div>
        </Phase>
      )}
    </AbsoluteFill>
  );
};

const LockIcon: React.FC = () => (
  <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke={C.dim} strokeWidth="1.7">
    <rect x="4" y="9" width="12" height="8.5" rx="2" />
    <path d="M7 9V6.5a3 3 0 0 1 6 0V9" strokeLinecap="round" />
  </svg>
);
