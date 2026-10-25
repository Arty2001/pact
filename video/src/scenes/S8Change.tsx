/**
 * Beat 8 - now change the sentence. 2:12 to 2:40.
 *
 * The use-case montage, and the only place the pace is allowed to accelerate.
 * Cards land about every 1.5 seconds, then the scene slows for the gym and
 * stops dead on the one line worth remembering.
 *
 * The stat cards are the money claim and every figure in them is measured and
 * in the repo: a frontier model on every frame at the rate a rep needs is
 * $421 a day per camera, the self-hosted encoder is flat at $37 a day however
 * many cameras and goals are on it, and the marginal cost of goal fifty is
 * nothing measurable. No invented numbers anywhere in this scene.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { C, F, T, R, s } from "../lib/theme";
import { Rise, Mono, inOut, Eyebrow, Chip, Pane, CountUp, Phase } from "../lib/prims";
import { FootageSlot } from "../lib/footage";

const Case: React.FC<{
  at: number;
  sentence: string;
  kind: string;
  tone: "proved" | "bad" | "pending";
  verdict: string;
  shot: number;
  note: string;
}> = ({ at, sentence, kind, tone, verdict, shot, note }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 14);
  return (
    <div
      style={{
        opacity: p,
        transform: `translateY(${(1 - p) * 20}px) scale(${0.97 + p * 0.03})`,
        width: 460,
      }}
    >
      <FootageSlot shot={shot} note={note} at={at} w={460} h={250} />
      <div style={{ marginTop: 16 }}>
        <div
          style={{
            fontFamily: F.ui,
            fontSize: 27,
            color: C.fg,
            fontWeight: 500,
            letterSpacing: -0.6,
            minHeight: 68,
          }}
        >
          "{sentence}"
        </div>
        <div style={{ display: "flex", gap: 12, marginTop: 10 }}>
          <Chip label={kind} tone="none" mono size={18} />
          <Chip label={verdict} tone={tone} mono size={18} />
        </div>
      </div>
    </div>
  );
};

const Stat: React.FC<{
  at: number;
  value: React.ReactNode;
  label: string;
  tone?: "proved" | "none";
}> = ({ at, value, label, tone = "none" }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 18);
  return (
    <div
      style={{
        opacity: p,
        transform: `translateY(${(1 - p) * 18}px)`,
        textAlign: "center",
        flex: 1,
      }}
    >
      <div
        style={{
          fontFamily: F.mono,
          fontSize: 82,
          fontWeight: 700,
          letterSpacing: -3,
          color: tone === "proved" ? C.provedText : C.fg,
          lineHeight: 1.05,
        }}
      >
        {value}
      </div>
      <div style={{ marginTop: 10 }}>
        <Mono size={20} color={C.dim}>
          {label}
        </Mono>
      </div>
    </div>
  );
};

/** Scene length, so the handoff can be timed from the end. */
const LEN = 606;

export const S8Change: React.FC = () => {
  const f = useCurrentFrame();
  // Beat 9 opens on the registry those numbers were about, so the cards
  // recede toward it rather than cutting.
  const HANDOFF = inOut(f, LEN - 14, 14);

  /**
   * Fitted to the recorded line. The voice names the sink, then the bins and
   * the pills, then the gym, then lands on "nobody wrote code for any of
   * this" and stops - and only THEN do the cost cards arrive, in silence.
   *
   * The numbers used to run under the gym sentence, which had the voice
   * talking about a workout over a chart about money. Putting them after the
   * line gives the claim and its proof in that order and gives the voice
   * somewhere to stop.
   */
  const SINK = s(1.6);
  const BINS = s(8.6);
  const PILLS = s(10.4);
  const GYM = s(12.0);
  const PUNCH = s(16.0);
  const STATS = s(22.6);

  const montageOut = 1 - inOut(f, PUNCH - s(0.8), 14);
  const punchOut = 1 - inOut(f, STATS - s(0.8), 14);

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      {/* The montage. */}
      {f < PUNCH + 12 && (
        <Phase from={0} to={PUNCH - s(0.8)}>
          <div style={{ width: 1560 }}>
            <Eyebrow at={2}>same system. different sentence.</Eyebrow>
            <div style={{ display: "flex", gap: 44 }}>
              <Case
                at={SINK}
                sentence="Keep the sink clear"
                kind="limit"
                tone="bad"
                verdict="firing = failure"
                shot={7}
                note="dirty sink, filling up"
              />
              <Case
                at={BINS}
                sentence="Bins out on Tuesday"
                kind="target"
                tone="proved"
                verdict="done · camera"
                shot={8}
                note="bins by the door"
              />
              <Case
                at={PILLS}
                sentence="Has Dad taken his pills?"
                kind="target"
                tone="pending"
                verdict="waiting"
                shot={8}
                note="pill box on a counter"
              />
            </div>

            {/* The gym, slower, after the three fast ones. */}
            <Rise at={GYM} style={{ marginTop: 44 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
                <FootageSlot
                  shot={9}
                  note="gym — a machine, a set, the weight pin"
                  at={GYM}
                  w={520}
                  h={200}
                />
                <div>
                  <div
                    style={{
                      fontFamily: F.display,
                      fontSize: 40,
                      fontWeight: 600,
                      color: C.fg,
                      letterSpacing: -1,
                      lineHeight: 1.3,
                    }}
                  >
                    We pointed it at a gym
                    <br />
                    and it logged a whole workout.
                  </div>
                  <div style={{ display: "flex", gap: 12, marginTop: 18 }}>
                    <Chip label="which machine" tone="watch" mono size={19} />
                    <Chip label="8 reps" tone="proved" mono size={19} />
                    <Chip label="weight? → asked" tone="pending" mono size={19} />
                  </div>
                </div>
              </div>
            </Rise>
          </div>
        </Phase>
      )}

      {/* The numbers. Measured, every one of them. */}
      {/* The numbers, in silence, after the voice has stopped. */}
      {f >= STATS - 4 && (
        <Phase from={STATS} style={{ transform: `scale(${1 - 0.08 * HANDOFF})`, opacity: 1 - 0.4 * HANDOFF }}>
          <div style={{ width: 1500 }}>
            <Eyebrow at={STATS + 2}>what the shape of the cost looks like</Eyebrow>
            <Pane pad={52}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 30 }}>
                <Stat
                  at={STATS + 8}
                  value={<CountUp to={421} at={STATS + 10} dur={34} prefix="$" />}
                  label="a frontier model, every frame"
                />
                <div
                  style={{
                    alignSelf: "center",
                    fontFamily: F.mono,
                    fontSize: 46,
                    color: C.dimmer,
                    opacity: inOut(f, STATS + 22, 14),
                  }}
                >
                  →
                </div>
                <Stat
                  at={STATS + 26}
                  value={<CountUp to={37} at={STATS + 28} dur={30} prefix="$" />}
                  label="self-hosted encoder, flat"
                  tone="proved"
                />
                <div
                  style={{
                    alignSelf: "center",
                    fontFamily: F.mono,
                    fontSize: 46,
                    color: C.dimmer,
                    opacity: inOut(f, STATS + 40, 14),
                  }}
                >
                  +
                </div>
                <Stat
                  at={STATS + 44}
                  value="$0"
                  label="for the fiftieth goal"
                  tone="proved"
                />
              </div>
            </Pane>
            <Rise at={STATS + 64} style={{ marginTop: 26, textAlign: "center" }}>
              <Mono size={21} color={C.dimmer}>
                measured, per camera per day
              </Mono>
            </Rise>
          </div>
        </Phase>
      )}

      {/* The punch. One line, alone, landing as the voice lands it. */}
      {f >= PUNCH - 4 && f < STATS + 12 && (
        <Phase from={PUNCH} to={STATS - s(0.8)}>
          <div style={{ textAlign: "center", maxWidth: 1340 }}>
            <div
              style={{
                fontFamily: F.display,
                fontSize: 78,
                fontWeight: 700,
                color: C.fg,
                letterSpacing: -2.8,
                lineHeight: 1.12,
              }}
            >
              Nobody wrote code for any of this.
            </div>
            <Rise at={PUNCH + 26} style={{ marginTop: 28 }}>
              <div
                style={{
                  fontFamily: F.ui,
                  fontSize: 38,
                  color: C.dim,
                  fontWeight: 400,
                  letterSpacing: -0.9,
                }}
              >
                No new detector. No new feature. Just a different sentence.
              </div>
            </Rise>
          </div>
        </Phase>
      )}
    </AbsoluteFill>
  );
};
