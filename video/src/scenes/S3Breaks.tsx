/**
 * Beat 3 - it breaks it down. 0:31 to 1:01.
 *
 * "Nemotron breaks it into sub-goals. Someone in a room. Someone in a pushup
 *  position. Twenty of them, before noon. But a camera gives you pixels, and a
 *  sub-goal is words. Those don't compare. Unless you put them in the same
 *  space. That's the NVIDIA encoder. It turns the frame into a list of
 *  numbers, and turns the sentence into a list of numbers of exactly the same
 *  kind. Two points on one map. And asking whether this is a pushup is just
 *  asking how close they are."
 *
 * The longest beat and the one the rest of the film leans on, so it gets four
 * phases and they are built in the order the argument is made:
 *
 *   the plan        one sentence becomes three sub-goals on a spine
 *   the problem     pixels on one side, words on the other, no shared axis
 *   the encoder     both go in, and the same kind of thing comes out
 *   the map         which is why "is this a pushup" is a distance
 *
 * The map is the payoff and it is drawn literally: the sentences of several
 * unrelated sub-goals sit on it too, so the frame landing nearest to "a pushup
 * position" is something you watch happen rather than something you are told.
 * That is also the honest picture of what the system does - a nearest
 * neighbour in a space somebody else trained.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, F, R } from "../lib/theme";
import { Rise, Mono, inOut, Eyebrow, Chip, Phase, DrawArrow } from "../lib/prims";
import { FootageSlot } from "../lib/footage";
import { timing } from "../lib/beats";

const t = timing("b3");

/** The 1152-d vectors, same every render. Real-looking, not real. */
const seeded = (seed: number, n: number): number[] =>
  Array.from({ length: n }, (_, i) => {
    const x = Math.sin((seed + i * 7.31) * 12.9898) * 43758.5453;
    return (x - Math.floor(x) - 0.5) * 0.094;
  });

const fmt = (v: number) => (v < 0 ? "" : " ") + v.toFixed(4);

const SUBGOALS = [
  { at: t("inARoom"), label: "someone in a room", kind: "gate", tone: "watch" as const },
  { at: t("pushupPosition"), label: "someone in a pushup position", kind: "action", tone: "watch" as const },
  { at: t("twentyOfThem"), label: "20 of them", kind: "counter", tone: "watch" as const },
];

/** A row on the plan spine. The elbow is drawn, not a border trick. */
const Node: React.FC<{
  at: number;
  label: string;
  kind: string;
  last?: boolean;
  trailing?: React.ReactNode;
}> = ({ at, label, kind, last, trailing }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 16);
  return (
    <div style={{ display: "flex", alignItems: "stretch", height: 70 }}>
      {/* The spine, and the elbow into this row. */}
      <svg width="54" height="70" style={{ flexShrink: 0, overflow: "visible" }}>
        <line
          x1="14"
          y1="0"
          x2="14"
          y2={last ? 35 : 70}
          stroke={C.line}
          strokeWidth="1.5"
          strokeDasharray="70"
          strokeDashoffset={70 * (1 - p)}
        />
        <path
          d="M14 35 H 50"
          fill="none"
          stroke={C.line}
          strokeWidth="1.5"
          strokeDasharray="36"
          strokeDashoffset={36 * (1 - p)}
        />
      </svg>
      <div
        style={{
          flex: 1,
          opacity: p,
          transform: `translateX(${(1 - p) * -12}px)`,
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "0 22px",
          margin: "6px 0",
          borderRadius: R.r,
          background: C.watchWash,
          border: `1px solid ${C.watchEdge}`,
        }}
      >
        <span style={{ width: 9, height: 9, borderRadius: 999, background: C.watch }} />
        <span
          style={{
            flex: 1,
            fontFamily: F.ui,
            fontSize: 28,
            color: C.fg,
            fontWeight: 500,
            letterSpacing: -0.6,
          }}
        >
          {label}
        </span>
        {trailing}
        <Mono size={18} color={C.watchText}>
          {kind}
        </Mono>
      </div>
    </div>
  );
};

/** A strip of the vector. Values arrive left to right as it is produced. */
const Strip: React.FC<{ seed: number; at: number; tone: "watch" | "proved" }> = ({
  seed,
  at,
  tone,
}) => {
  const f = useCurrentFrame();
  const v = seeded(seed, 5);
  const edge = tone === "watch" ? C.watchEdge : C.provedEdge;
  const text = tone === "watch" ? C.watchText : C.provedText;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "12px 16px",
        borderRadius: R.r,
        background: C.glassHi,
        border: `1px solid ${edge}`,
        whiteSpace: "nowrap",
      }}
    >
      <Mono size={17} color={C.dimmer} style={{ marginRight: 4 }}>
        [
      </Mono>
      {v.map((n, i) => {
        const p = inOut(f, at + i * 3, 10);
        return (
          <span key={i} style={{ opacity: p }}>
            <Mono size={19} color={text} style={{ fontWeight: 600 }}>
              {fmt(n)}
            </Mono>
          </span>
        );
      })}
      <span style={{ opacity: inOut(f, at + 20, 12), display: "flex", gap: 8 }}>
        <Mono size={19} color={C.dimmer}>
          …
        </Mono>
        <Mono size={17} color={C.dimmer}>
          ] 1152
        </Mono>
      </span>
    </div>
  );
};

/**
 * The map. Seven sub-goal sentences from across the system, plus the frame.
 *
 * The positions are a 2-D stand-in for 1152 dimensions, which is the one
 * honest lie in the film: everything else on screen is a real number from the
 * real pipeline, and a 1152-d space cannot be drawn.
 */
const SENTENCES = [
  { x: 0.16, y: 0.22, label: "a tidy kitchen", sim: 0.071 },
  { x: 0.78, y: 0.16, label: "someone sitting", sim: 0.118 },
  { x: 0.86, y: 0.52, label: "a phone in a hand", sim: 0.094 },
  { x: 0.22, y: 0.70, label: "dishes in the sink", sim: 0.082 },
  { x: 0.52, y: 0.30, label: "someone in a room", sim: 0.163 },
  { x: 0.64, y: 0.73, label: "a pushup position", sim: 0.284 },
  { x: 0.33, y: 0.47, label: "an empty room", sim: 0.060 },
];
const FRAME_PT = { x: 0.565, y: 0.63 };

const Map2D: React.FC<{ at: number }> = ({ at }) => {
  const f = useCurrentFrame();
  const W = 700;
  const H = 440;
  const px = (p: { x: number; y: number }) => [34 + p.x * (W - 68), 28 + p.y * (H - 56)];
  const [fx, fy] = px(FRAME_PT);
  const near = SENTENCES[5];
  const [nx, ny] = px(near);

  return (
    <div
      style={{
        width: W,
        height: H,
        position: "relative",
        borderRadius: R.r2,
        background: C.glassHi,
        border: `1px solid ${C.hair}`,
        overflow: "hidden",
      }}
    >
      <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
        {/* A faint lattice, so distance on this map reads as measurable. */}
        {[1, 2, 3, 4, 5].map((i) => (
          <g key={i} stroke="rgba(16,36,54,.055)" strokeWidth="1">
            <line x1={(i * W) / 6} x2={(i * W) / 6} y1="0" y2={H} />
            <line x1="0" x2={W} y1={(i * H) / 6} y2={(i * H) / 6} />
          </g>
        ))}

        {/* Every other sentence is also a point here. The frame is measured
            against all of them; only one comes back close. */}
        {SENTENCES.map((s, i) => {
          if (i === 5) return null;
          const [sx, sy] = px(s);
          const p = inOut(f, at + 26 + i * 2, 14);
          return (
            <line
              key={s.label}
              x1={fx}
              y1={fy}
              x2={sx}
              y2={sy}
              stroke={C.dimmer}
              strokeWidth="1.4"
              strokeDasharray="5 6"
              opacity={p * 0.75}
            />
          );
        })}

        <g opacity={inOut(f, at + 44, 16)}>
          <DrawArrow
            d={`M ${fx} ${fy} L ${nx} ${ny}`}
            at={at + 44}
            dur={16}
            color={C.proved}
            width={2.4}
            head={false}
            id="near"
          />
        </g>
      </svg>

      {SENTENCES.map((s, i) => {
        const [sx, sy] = px(s);
        const p = inOut(f, at + 6 + i * 3, 14);
        const hot = i === 5;
        return (
          <div
            key={s.label}
            style={{
              position: "absolute",
              left: sx,
              top: sy,
              transform: `translate(-50%, -50%) scale(${0.8 + p * 0.2})`,
              opacity: p,
              display: "flex",
              alignItems: "center",
              gap: 8,
              whiteSpace: "nowrap",
            }}
          >
            <span
              style={{
                width: hot ? 11 : 7,
                height: hot ? 11 : 7,
                borderRadius: 999,
                background: hot ? C.proved : C.dimmer,
                flexShrink: 0,
              }}
            />
            <Mono size={hot ? 18 : 16} color={hot ? C.provedText : C.dimmer}>
              {s.label}
            </Mono>
          </div>
        );
      })}

      {/* The frame, as a point. Violet, because it is the thing being watched. */}
      <div
        style={{
          position: "absolute",
          left: fx,
          top: fy,
          transform: "translate(-50%, -50%)",
          opacity: inOut(f, at, 16),
        }}
      >
        <div
          style={{
            width: 15,
            height: 15,
            borderRadius: 999,
            background: C.watch,
            boxShadow: `0 0 0 ${4 + 3 * Math.abs(Math.sin((f - at) / 22))}px ${C.watchWash}`,
          }}
        />
        {/* Name the point: without it the violet dot is just a dot. */}
        <div style={{ position: "absolute", right: 16, bottom: 12, whiteSpace: "nowrap", opacity: inOut(f, at + 8, 14),
                      padding: "4px 10px", borderRadius: 999, background: C.watchWash, border: `1px solid ${C.watchEdge}` }}>
          <Mono size={17} color={C.watchText}>this frame</Mono>
        </div>
      </div>

      {/* The winning distance, written on the line that won. */}
      <div style={{ position: "absolute", left: (fx + nx) / 2 + 14, top: (fy + ny) / 2 - 16, opacity: inOut(f, at + 56, 14),
                    whiteSpace: "nowrap" }}>
        <Mono size={16} color={C.provedText}>closest · 0.284</Mono>
      </div>
    </div>
  );
};

export const S3Breaks: React.FC = () => {
  const f = useCurrentFrame();

  const PIX = t("pixels") - 12;
  const ENC = t("encoder") - 14;
  const MAP = t("twoPoints") - 14;

  // The two boxes close the gap when the line says they can be compared.
  const close = inOut(f, t("sameSpace"), 24);

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      {/* ---- the plan ---- */}
      {f < PIX + 14 && (
        <Phase from={0} to={PIX} scale={1.28}>
          <div style={{ width: 1180 }}>
            {/* The sentence beat 2 was typing, now a header rather than a field. */}
            <Rise at={0} y={14}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 18,
                  padding: "20px 26px",
                  borderRadius: R.r2,
                  background: C.glassTop,
                  border: `1px solid ${C.hair}`,
                }}
              >
                <Mono size={17} color={C.dimmer}>
                  goal
                </Mono>
                <span
                  style={{
                    fontFamily: F.ui,
                    fontSize: 32,
                    color: C.fg,
                    fontWeight: 500,
                    letterSpacing: -0.7,
                  }}
                >
                  I want to do 20 pushups every morning
                </span>
              </div>
            </Rise>

            <Rise at={t("breaksDown") + 4} style={{ marginTop: 18, marginLeft: 54 }}>
              <Chip label="Nemotron 3 Super 120B · planner" tone="watch" mono size={19} />
            </Rise>

            <div style={{ marginTop: 10 }}>
              {SUBGOALS.map((s, i) => (
                <Node
                  key={s.label}
                  at={s.at}
                  label={s.label}
                  kind={s.kind}
                  last={i === SUBGOALS.length - 1}
                  trailing={
                    i === 2 ? (
                      <span style={{ opacity: inOut(f, t("beforeNoon"), 14) }}>
                        <Chip label="window · before 12:00" tone="pending" mono size={17} />
                      </span>
                    ) : undefined
                  }
                />
              ))}
            </div>
          </div>
        </Phase>
      )}

      {/* ---- pixels, and words ---- */}
      {f >= PIX - 4 && f < ENC + 14 && (
        <Phase from={PIX} to={ENC} scale={1.14}>
          <div style={{ width: 1500 }}>
            <Eyebrow at={t("pixels")}>two things that don't compare</Eyebrow>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 60 - close * 26,
              }}
            >
              {/* What the camera gives you. */}
              <div style={{ transform: `translateX(${close * 40}px)` }}>
                <FootageSlot shot={2} note="pushups, full set, side on" at={t("pixels")} w={520} h={320} src="pushups.mp4" />
                <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between" }}>
                  <Mono size={19} color={C.dimmer}>
                    1 frame
                  </Mono>
                  <Mono size={19} color={C.dimmer}>
                    1920 × 1080 px
                  </Mono>
                </div>
              </div>

              {/* The verdict between them, which is what changes. */}
              <div style={{ textAlign: "center", width: 180, flexShrink: 0 }}>
                <div
                  style={{
                    fontFamily: F.display,
                    fontSize: 72,
                    fontWeight: 300,
                    color: close > 0.5 ? C.provedText : C.badText,
                    opacity: inOut(f, t("dontCompare"), 14),
                    lineHeight: 1,
                  }}
                >
                  {close > 0.5 ? "≟" : "≠"}
                </div>
                <div style={{ marginTop: 14, opacity: inOut(f, t("dontCompare") + 6, 14) }}>
                  <Mono size={18} color={close > 0.5 ? C.provedText : C.dimmer}>
                    {close > 0.5 ? "same space" : "no shared axis"}
                  </Mono>
                </div>
              </div>

              {/* What a sub-goal is. */}
              <div style={{ transform: `translateX(${close * -40}px)`, width: 520 }}>
                <div
                  style={{
                    height: 320,
                    display: "flex",
                    alignItems: "center",
                    padding: "0 34px",
                    borderRadius: R.r2,
                    background: C.glassTop,
                    border: `1px solid ${C.hair}`,
                    opacity: inOut(f, t("words"), 16),
                  }}
                >
                  <span
                    style={{
                      fontFamily: F.ui,
                      fontSize: 42,
                      color: C.fg,
                      fontWeight: 500,
                      letterSpacing: -1.1,
                      lineHeight: 1.25,
                    }}
                  >
                    “someone in a
                    <br />
                    pushup position”
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 14,
                    display: "flex",
                    justifyContent: "space-between",
                    opacity: inOut(f, t("words"), 16),
                  }}
                >
                  <Mono size={19} color={C.dimmer}>
                    1 sub-goal
                  </Mono>
                  <Mono size={19} color={C.dimmer}>
                    5 words
                  </Mono>
                </div>
              </div>
            </div>
          </div>
        </Phase>
      )}

      {/* ---- the encoder ---- */}
      {f >= ENC - 4 && f < MAP + 14 && (
        <Phase from={ENC} to={MAP} scale={1.04}>
          <div style={{ width: 1620 }}>
            <Eyebrow at={t("encoder")}>one encoder, two doors</Eyebrow>

            <div style={{ display: "flex", alignItems: "center", gap: 34 }}>
              {/* Both inputs. */}
              <div style={{ width: 330, display: "flex", flexDirection: "column", gap: 30 }}>
                <Rise at={t("encoder") + 4} y={16}>
                  <div style={{ position: "relative" }}>
                    <FootageSlot
                      shot={2}
                      note="the same frame"
                      at={t("encoder") + 4}
                      w={330}
                      h={186}
                      radius={R.r}
                      src="pushups.mp4"
                    />
                    <div style={{ position: "absolute", left: 12, bottom: 10 }}>
                      <Mono size={17} color={C.onDarkDim}>
                        the frame
                      </Mono>
                    </div>
                  </div>
                </Rise>
                <Rise at={t("encoder") + 10} y={16}>
                  <div
                    style={{
                      height: 186,
                      borderRadius: R.r,
                      background: C.glassTop,
                      border: `1px solid ${C.hair}`,
                      display: "grid",
                      placeItems: "center",
                      padding: "0 22px",
                      textAlign: "center",
                    }}
                  >
                    <span style={{ fontFamily: F.ui, fontSize: 26, color: C.fg, fontWeight: 500 }}>
                      “someone in a pushup position”
                    </span>
                  </div>
                </Rise>
              </div>

              <svg width="86" height="400" style={{ flexShrink: 0 }}>
                <DrawArrow d="M 6 96 H 76" at={t("frameNumbers") - 10} dur={12} color={C.line} id="i1" />
                <DrawArrow d="M 6 312 H 76" at={t("sentenceNumbers") - 10} dur={12} color={C.line} id="i2" />
              </svg>

              {/* The one model both go through. The vision tower and the text
                  tower ship together, which is the whole reason this works. */}
              <Rise at={t("encoder")} y={20}>
                <div
                  style={{
                    width: 350,
                    padding: 32,
                    borderRadius: R.r2,
                    background: C.glassTop,
                    border: `2px solid ${C.provedEdge}`,
                  }}
                >
                  <Mono size={17} color={C.dimmer}>
                    NVIDIA
                  </Mono>
                  <div
                    style={{
                      fontFamily: F.display,
                      fontSize: 34,
                      fontWeight: 700,
                      color: C.fg,
                      letterSpacing: -1,
                      margin: "4px 0 16px",
                    }}
                  >
                    C-RADIOv3-B
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                    {[
                      { k: "vision tower", v: "frame → 1152-d" },
                      { k: "text tower", v: "words → 1152-d" },
                      { k: "runs on", v: "Nebius AI Cloud" },
                    ].map((r, i) => (
                      <div
                        key={r.k}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 12,
                          opacity: inOut(f, t("encoder") + 16 + i * 7, 14),
                        }}
                      >
                        <Mono size={17} color={C.dimmer} style={{ whiteSpace: "nowrap" }}>
                          {r.k}
                        </Mono>
                        <Mono size={17} color={C.provedText} style={{ whiteSpace: "nowrap" }}>
                          {r.v}
                        </Mono>
                      </div>
                    ))}
                  </div>
                </div>
              </Rise>

              <svg width="86" height="400" style={{ flexShrink: 0 }}>
                <DrawArrow d="M 6 96 H 76" at={t("frameNumbers")} dur={12} color={C.proved} id="o1" />
                <DrawArrow d="M 6 312 H 76" at={t("sentenceNumbers")} dur={12} color={C.proved} id="o2" />
              </svg>

              {/* And out the other side, twice, the same shape. The strips are
                  deliberately aligned on the decimal point. */}
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 46 }}>
                <div>
                  <Strip seed={11} at={t("frameNumbers") + 8} tone="proved" />
                  <div style={{ marginTop: 8, marginLeft: 4 }}>
                    <Mono size={17} color={C.dimmer}>
                      from the frame
                    </Mono>
                  </div>
                </div>
                <div>
                  <Strip seed={47} at={t("sentenceNumbers") + 8} tone="proved" />
                  <div style={{ marginTop: 8, marginLeft: 4 }}>
                    <Mono size={17} color={C.dimmer}>
                      from the sentence · exactly the same kind
                    </Mono>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Phase>
      )}

      {/* ---- two points on one map ---- */}
      {f >= MAP - 4 && (
        <Phase from={MAP} scale={1.16}>
          <div style={{ width: 1500, display: "flex", gap: 56, alignItems: "center" }}>
            <Map2D at={t("twoPoints")} />

            <div style={{ flex: 1 }}>
              <Rise at={t("howClose")} y={20}>
                <div
                  style={{
                    fontFamily: F.display,
                    fontSize: 44,
                    fontWeight: 600,
                    color: C.fg,
                    letterSpacing: -1.3,
                    lineHeight: 1.25,
                  }}
                >
                  Is this a pushup?
                </div>
              </Rise>
              <Rise at={t("howClose") + 14} y={18}>
                <div
                  style={{
                    marginTop: 12,
                    fontFamily: F.display,
                    fontSize: 36,
                    fontWeight: 500,
                    color: C.dim,
                    letterSpacing: -1,
                  }}
                >
                  is just: how close are they?
                </div>
              </Rise>

              <div style={{ marginTop: 30, display: "flex", flexDirection: "column", gap: 10 }}>
                {[
                  { k: "nearest", v: "a pushup position", tone: C.provedText },
                  { k: "similarity", v: "0.284", tone: C.provedText },
                  { k: "next nearest", v: "someone in a room · 0.163", tone: C.dim },
                ].map((r, i) => {
                  const p = inOut(f, t("howClose") + 26 + i * 10, 14);
                  return (
                    <div
                      key={r.k}
                      style={{
                        opacity: p,
                        transform: `translateX(${(1 - p) * -12}px)`,
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 20,
                        padding: "12px 18px",
                        borderRadius: R.r,
                        background: C.sunk,
                        border: `1px solid ${C.hair}`,
                      }}
                    >
                      <Mono size={19} color={C.dimmer}>
                        {r.k}
                      </Mono>
                      <Mono size={19} color={r.tone} style={{ fontWeight: 600 }}>
                        {r.v}
                      </Mono>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </Phase>
      )}
    </AbsoluteFill>
  );
};
