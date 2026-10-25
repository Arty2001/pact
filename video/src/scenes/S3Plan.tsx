/**
 * Beat 3 - it breaks it down, and the two become comparable. 0:31 to 1:03.
 *
 * The longest beat in the film and the only genuinely hard idea in it, so it
 * is built the way a good explainer is built: do not state the answer, make
 * the problem force it.
 *
 * Five phases, each one a clause of the voiceover:
 *
 *   plan     the goal becomes a handful of small things to watch for
 *   gap      a frame is pixels, a sub-goal is words - and they do not compare
 *   encoder  the one thing that can put both into the same space
 *   vectors  each side becomes a list of numbers of exactly the same kind
 *   map      two points, and the question collapses into a distance
 *
 * The gap is the important one. If the audience does not feel that pixels and
 * words are incommensurable, the encoder is just another box in a diagram.
 * So the scene spends four seconds on a broken connection with a question
 * mark in it, and only then offers the way out.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { C, F, T, R, s } from "../lib/theme";
import { Rise, Mono, SkillRow, inOut, outIn, Eyebrow, Phase, MorphBox } from "../lib/prims";
import { FootageSlot } from "../lib/footage";

const DIMS = 28;

/** A vector, drawn as a strip. Deterministic, so it never flickers. */
const Vector: React.FC<{ at: number; seed: number; color: string; w: number }> = ({
  at,
  seed,
  color,
  w,
}) => {
  const f = useCurrentFrame();
  const bw = w / DIMS;
  const h = 56;
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      {Array.from({ length: DIMS }, (_, i) => {
        const p = inOut(f, at + i * 1.2, 11);
        const v = (Math.sin((i + 1) * seed * 1.7) + 1) / 2;
        const bh = (0.2 + v * 0.8) * h;
        return (
          <rect
            key={i}
            x={i * bw + 1}
            y={(h - bh) / 2}
            width={bw - 2.5}
            height={bh * p}
            rx={1.5}
            fill={color}
            opacity={0.32 + v * 0.68}
          />
        );
      })}
    </svg>
  );
};

/** The model plate. Named, credited, on screen long enough to read. */
export const ModelPlate: React.FC<{
  at: number;
  model: string;
  where: string;
  style?: React.CSSProperties;
}> = ({ at, model, where, style }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 18);
  const spin = (f - at) * 1.6;
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 16,
        padding: "16px 24px",
        borderRadius: R.r2,
        background: C.watchWash,
        border: `1px solid ${C.watchEdge}`,
        opacity: p,
        transform: `translateY(${(1 - p) * 14}px)`,
        ...style,
      }}
    >
      <svg width="26" height="26" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
        <circle cx="12" cy="12" r="9" fill="none" stroke={C.watchEdge} strokeWidth="2.4" />
        <circle
          cx="12"
          cy="12"
          r="9"
          fill="none"
          stroke={C.watch}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeDasharray="14 43"
          transform={`rotate(${spin} 12 12)`}
        />
      </svg>
      <div style={{ lineHeight: 1.3 }}>
        <div style={{ fontFamily: F.mono, fontSize: 22, fontWeight: 700, color: C.watchText }}>
          {model}
        </div>
        <div style={{ fontFamily: F.mono, fontSize: 17, color: C.dim }}>{where}</div>
      </div>
    </div>
  );
};

/**
 * The map: a flat projection of the space, with the frame and every sub-goal
 * placed on it.
 *
 * The positions are fixed rather than computed - this is a picture of an idea,
 * not a plot of real embeddings, and pretending otherwise with a scatter of
 * invented coordinates would be the one dishonest frame in the film. What it
 * shows is true: near means similar, and the question is a distance.
 */
const Map2D: React.FC<{ at: number }> = ({ at }) => {
  const f = useCurrentFrame();
  const W = 580;
  const H = 400;

  const others = [
    { x: 0.17, y: 0.26, label: "at the sink" },
    { x: 0.80, y: 0.21, label: "reading" },
    { x: 0.26, y: 0.79, label: "at the fridge" },
    { x: 0.73, y: 0.86, label: "on the sofa" },
  ];
  const skill = { x: 0.52, y: 0.49 };
  const frame = { x: 0.68, y: 0.64 };

  const px = (v: number) => 30 + v * (W - 60);
  const py = (v: number) => 26 + v * (H - 52);

  const line = inOut(f, at + 44, 20);

  return (
    <div style={{ position: "relative", width: W, height: H }}>
      <svg width={W} height={H} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <rect
          x="8"
          y="8"
          width={W - 16}
          height={H - 16}
          rx={R.r2}
          fill={C.sunk}
          stroke={C.hair}
          opacity={inOut(f, at, 16)}
        />
        {/* Everything else the room could look like, placed and faint. */}
        {others.map((o, i) => (
          <g key={o.label} opacity={inOut(f, at + 10 + i * 4, 14) * 0.55}>
            <circle cx={px(o.x)} cy={py(o.y)} r="6" fill={C.dimmer} />
            <text
              x={px(o.x)}
              y={py(o.y) - 14}
              textAnchor="middle"
              style={{ fontFamily: F.mono, fontSize: 15, fill: C.dimmer }}
            >
              {o.label}
            </text>
          </g>
        ))}

        {/* The distance. The whole idea, drawn as a line with a number on it. */}
        <line
          x1={px(skill.x)}
          y1={py(skill.y)}
          x2={px(skill.x) + (px(frame.x) - px(skill.x)) * line}
          y2={py(skill.y) + (py(frame.y) - py(skill.y)) * line}
          stroke={C.fg}
          strokeWidth="2.5"
          strokeDasharray="5 5"
        />

        <g opacity={inOut(f, at + 24, 14)}>
          <circle cx={px(skill.x)} cy={py(skill.y)} r="11" fill={C.proved} />
        </g>
        <g opacity={inOut(f, at + 34, 14)}>
          <circle cx={px(frame.x)} cy={py(frame.y)} r="11" fill={C.watch} />
        </g>
      </svg>

      <div
        style={{
          position: "absolute",
          left: px(skill.x) - 150,
          top: py(skill.y) - 52,
          width: 300,
          textAlign: "center",
          opacity: inOut(f, at + 26, 14),
        }}
      >
        <Mono size={16} color={C.provedText}>
          "a person in a pushup position"
        </Mono>
      </div>
      <div
        style={{
          position: "absolute",
          left: px(frame.x) - 100,
          top: py(frame.y) + 20,
          width: 200,
          textAlign: "center",
          opacity: inOut(f, at + 36, 14),
        }}
      >
        <Mono size={16} color={C.watchText}>
          this frame
        </Mono>
      </div>
    </div>
  );
};

export const S3Plan: React.FC = () => {
  const f = useCurrentFrame();

  const GAP = s(9.0);
  const ENC = s(14.6);
  const VEC = s(19.2);
  const MAP = s(25.6);

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      {/* ---- phase 1: the plan ---- */}
      {f < GAP + 14 && (
        <Phase from={0} to={GAP - 12}>
          <div style={{ width: 1280 }}>
            {/* Caught from beat 2: settles in from larger rather than
                rising from below, so it reads as the same text arriving. */}
            <div
              style={{
                transform: `scale(${1.16 - 0.16 * inOut(f, 0, 16)})`,
                transformOrigin: "left center",
                opacity: inOut(f, 0, 12),
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 24 }}>
                <Mono size={T.micro} color={C.dimmer}>
                  goal
                </Mono>
                <div
                  style={{
                    fontFamily: F.ui,
                    fontSize: 30,
                    color: C.fg,
                    fontWeight: 500,
                    letterSpacing: -0.7,
                  }}
                >
                  "I want to do 20 pushups every morning"
                </div>
              </div>
            </div>

            <ModelPlate
              at={s(0.8)}
              model="Nemotron 3 Super 120B"
              where="Nebius Token Factory"
              style={{ marginBottom: 26 }}
            />

            <Eyebrow at={s(2.2)}>breaks it into sub-goals</Eyebrow>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <SkillRow at={s(3.2)} label="someone in a room" kind="gate" tone="watch" width={820} />
              <SkillRow
                at={s(5.2)}
                label="someone in a pushup position"
                kind="counter"
                tone="proved"
                indent={56}
                width={876}
              />
              <SkillRow
                at={s(7.2)}
                label="twenty of them, before noon"
                kind="rule"
                tone="none"
                width={820}
              />
            </div>
          </div>
        </Phase>
      )}

      {/*
        One continuous stage from the gap to the map.

        These used to be three cut phases, which asked the audience to rebuild
        the relationship each time: the boxes vanished and strips appeared
        somewhere else, and nothing said they were the same two things. Now the
        frame and the sentence are single objects that travel and transform -
        they converge from opposite sides of the frame into two strips of the
        same width, which is the argument drawn as a movement.
      */}
      {f >= GAP - 4 && (
        <Phase from={GAP} travel={22}>
          <div style={{ position: "relative", width: 1640, height: 700 }}>
            {/* The encoder, once it exists. */}
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: 0,
                display: "flex",
                justifyContent: "center",
              }}
            >
              <ModelPlate
                at={ENC}
                model="C-RADIO v3-B · NVIDIA"
                where="self-hosted on Nebius AI Cloud"
              />
            </div>

            {/* The break, while there is still a break. */}
            <div
              style={{
                position: "absolute",
                left: 700,
                top: 210,
                width: 240,
                textAlign: "center",
                opacity: inOut(f, GAP + 18, 14) * outIn(f, ENC - 10, 12),
              }}
            >
              <svg width="240" height="90" style={{ overflow: "visible" }}>
                <line x1="10" x2="86" y1="45" y2="45" stroke={C.line} strokeWidth="2.5" strokeDasharray="6 6" />
                <line x1="154" x2="230" y1="45" y2="45" stroke={C.line} strokeWidth="2.5" strokeDasharray="6 6" />
                <text x="120" y="58" textAnchor="middle" style={{ fontFamily: F.mono, fontSize: 42, fill: C.bad, fontWeight: 700 }}>?</text>
              </svg>
              <Mono size={18} color={C.badText}>
                these don't compare
              </Mono>
            </div>

            {/* The frame: pixels on the left, becoming a strip. */}
            <MorphBox
              at={VEC}
              from={[110, 130, 420, 262]}
              to={[70, 320, 520, 56]}
              radius={[14, 4]}
              before={
                <FootageSlot shot={5} note="pixels" at={GAP} w={420} h={262} radius={R.r2} />
              }
              after={<Vector at={VEC + 14} seed={5.1} color={C.watch} w={520} />}
            />
            <div
              style={{
                position: "absolute",
                left: 110,
                top: 404,
                width: 420,
                textAlign: "center",
                opacity: outIn(f, VEC, 12),
              }}
            >
              <Mono size={20} color={C.watchText}>
                a frame is pixels
              </Mono>
            </div>

            {/* The sentence: words on the right, travelling to meet it. */}
            <MorphBox
              at={VEC}
              from={[1110, 130, 420, 262]}
              to={[70, 440, 520, 56]}
              radius={[14, 4]}
              bg={[C.provedWash, "transparent"]}
              border={[C.provedEdge, "transparent"]}
              before={
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "0 26px",
                    fontFamily: F.ui,
                    fontSize: 30,
                    fontWeight: 500,
                    color: C.fg,
                    letterSpacing: -0.7,
                    lineHeight: 1.35,
                    textAlign: "center",
                  }}
                >
                  "someone in a pushup position"
                </div>
              }
              after={<Vector at={VEC + 14} seed={2.3} color={C.proved} w={520} />}
            />
            <div
              style={{
                position: "absolute",
                left: 1110,
                top: 404,
                width: 420,
                textAlign: "center",
                opacity: outIn(f, VEC, 12),
              }}
            >
              <Mono size={20} color={C.provedText}>
                a sub-goal is words
              </Mono>
            </div>

            {/* What they are once they have both arrived. */}
            <div style={{ position: "absolute", left: 70, top: 286, opacity: inOut(f, VEC + 22, 14) }}>
              <Mono size={17} color={C.watchText}>
                the frame
              </Mono>
            </div>
            <div style={{ position: "absolute", left: 70, top: 406, opacity: inOut(f, VEC + 26, 14) }}>
              <Mono size={17} color={C.provedText}>
                the sub-goal's sentence
              </Mono>
            </div>
            <div style={{ position: "absolute", left: 70, top: 516, opacity: inOut(f, VEC + 40, 16) }}>
              <Mono size={19} color={C.dim}>
                1,152 numbers each · same space · same ruler
              </Mono>
            </div>

            {/* The map. */}
            <div style={{ position: "absolute", left: 1000, top: 150 }}>
              {f >= MAP - 4 && <Map2D at={MAP} />}
            </div>

            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: 606,
                textAlign: "center",
                opacity: inOut(f, MAP + 50, 16),
              }}
            >
              <span
                style={{
                  fontFamily: F.display,
                  fontSize: 36,
                  fontWeight: 500,
                  color: C.dim,
                  letterSpacing: -0.9,
                }}
              >
                "Is this a pushup?" is now{" "}
                <span style={{ color: C.fg, fontWeight: 600 }}>"how close are they?"</span>
              </span>
            </div>
          </div>
        </Phase>
      )}
    </AbsoluteFill>
  );
};
