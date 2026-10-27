/**
 * Beat 8 - one system, any goal. 2:11 to 2:31.
 *
 * "One system, any goal. Keep the sink clear - same pieces, except now firing
 *  is the failure. And any stream. A phone. A screen share. A thirty-dollar
 *  board. We pointed it at a phone recording a gym session, and it logged the
 *  whole workout. Nobody typed anything in."
 *
 * The previous version of this scene ended on three cost cards counting from
 * $421 to $37 to $0 - built for a cost line that beat 8 no longer has. They
 * were a good graphic making an argument the narration had stopped making.
 *
 * The line makes two claims and the scene makes exactly those two. First that
 * a limit goal is the SAME pieces with the conclusion flipped, which is shown
 * by putting one set of sub-goals under two verdicts rather than by saying so.
 * Then that the stream can be anything, which is three sources arriving on
 * their own words. The gym closes it, because an unprompted workout log is
 * the strongest thing the project has.
 */

import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { C, F, R } from "../lib/theme";
import { Rise, Mono, inOut, Eyebrow, Chip, Phase } from "../lib/prims";
import { FootageSlot } from "../lib/footage";
import { timing } from "../lib/beats";

const t = timing("b8");

/** One sub-goal, drawn identically on both sides of the inversion. */
const Piece: React.FC<{ at: number; label: string; kind: string }> = ({ at, label, kind }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 14);
  return (
    <div
      style={{
        opacity: p,
        transform: `translateY(${(1 - p) * 10}px)`,
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "12px 18px",
        borderRadius: R.r,
        background: C.sunk,
        border: `1px solid ${C.hair}`,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 999, background: C.dimmer }} />
      <span style={{ flex: 1, fontFamily: F.ui, fontSize: 21, color: C.fg, fontWeight: 500 }}>
        {label}
      </span>
      <Mono size={15} color={C.dimmer}>
        {kind}
      </Mono>
    </div>
  );
};

/** The same pieces read two ways. Only the conclusion differs. */
const Verdict: React.FC<{
  at: number;
  title: string;
  reading: string;
  chip: string;
  bad?: boolean;
}> = ({ at, title, reading, chip, bad }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 16);
  const k = bad
    ? { t: C.badText, w: C.badWash, e: C.badEdge }
    : { t: C.provedText, w: C.provedWash, e: C.provedEdge };
  return (
    <div
      style={{
        opacity: p,
        transform: `translateY(${(1 - p) * 14}px)`,
        width: 380,
        padding: 22,
        borderRadius: R.r2,
        background: k.w,
        border: `2px solid ${k.e}`,
      }}
    >
      <Mono size={16} color={C.dimmer}>
        {title}
      </Mono>
      <div
        style={{
          fontFamily: F.ui,
          fontSize: 23,
          fontWeight: 500,
          color: C.fg,
          margin: "8px 0 14px",
          letterSpacing: -0.4,
        }}
      >
        {reading}
      </div>
      <Chip label={chip} tone={bad ? "bad" : "proved"} mono size={18} />
    </div>
  );
};

/** One place a stream can come from. */
const Source: React.FC<{ at: number; label: string; note: string }> = ({ at, label, note }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 15);
  return (
    <div
      style={{
        opacity: p,
        transform: `translateY(${(1 - p) * 16}px) scale(${0.96 + p * 0.04})`,
        width: 300,
        padding: 24,
        borderRadius: R.r2,
        background: C.glass,
        border: `1px solid ${C.watchEdge}`,
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontFamily: F.ui,
          fontSize: 27,
          fontWeight: 600,
          color: C.fg,
          letterSpacing: -0.6,
        }}
      >
        {label}
      </div>
      <div style={{ marginTop: 8 }}>
        <Mono size={16} color={C.watchText}>
          {note}
        </Mono>
      </div>
    </div>
  );
};

export const S8Any: React.FC = () => {
  const f = useCurrentFrame();

  const STREAMS = t("anyStream") - 10;
  const GYM = t("gym") - 10;
  /** Scene frames at which each real rep in the clip bottoms out (12 reps, shown at 3.5x). */
  const REP_F = [430, 447, 466, 483, 502, 521, 539, 559, 579, 598, 617, 638];

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      {/* ---- the inversion ---- */}
      {f < STREAMS + 14 && (
        <Phase from={0} to={STREAMS} scale={1.12}>
          <div style={{ width: 1340 }}>
            <Eyebrow at={t("anyGoal")}>one system, any goal</Eyebrow>

            <div style={{ display: "flex", gap: 44, alignItems: "flex-start" }}>
              <SinkShot at={t("sinkClear")} fire={t("sinkClear") + 16} until={STREAMS} />

              <div style={{ flex: 1 }}>
                <div style={{ marginBottom: 18 }}>
                  <Mono size={18} color={C.dimmer}>
                    the same two sub-goals
                  </Mono>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, width: 784 }}>
                  <Piece at={t("sinkClear") + 8} label="someone at the sink" kind="gate" />
                  <Piece at={t("sinkClear") + 16} label="dishes in the sink" kind="object" />
                </div>

                {/* Read as a target it is a success; read as a limit the same
                    firing is the failure. Nothing beneath them changed. */}
                <div style={{ display: "flex", gap: 24, marginTop: 28 }}>
                  <Verdict
                    at={t("inverted")}
                    title="as a target"
                    reading="it fired"
                    chip="done"
                  />
                  <Verdict
                    at={t("inverted") + 22}
                    title="as a limit"
                    reading="it fired"
                    chip="failed"
                    bad
                  />
                </div>
              </div>
            </div>
          </div>
        </Phase>
      )}

      {/* ---- any stream ---- */}
      {f >= STREAMS - 4 && f < GYM + 14 && (
        <Phase from={STREAMS} to={GYM} scale={1.34}>
          <div style={{ textAlign: "center" }}>
            <Eyebrow at={t("anyStream")}>and any stream</Eyebrow>
            <div style={{ display: "flex", gap: 28, justifyContent: "center", marginTop: 10 }}>
              <Source at={t("phone")} label="a phone" note="browser camera" />
              <Source at={t("screenShare")} label="a screen share" note="the same wire" />
              <Source at={t("board")} label="a $30 board" note="ESP32 · via the bridge" />
            </div>
          </div>
        </Phase>
      )}

      {/* ---- the gym ---- */}
      {f >= GYM - 4 && (
        <Phase from={GYM} scale={1.12}>
          <div style={{ width: 1560, display: "flex", gap: 48, alignItems: "center" }}>
            <div style={{ position: "relative" }}>
              <FootageSlot
                shot={5}
                note="phone recording a gym session"
                at={t("gym")}
                w={620}
                h={380}
                src="latpull.mp4"
              />
              <div style={{ position: "absolute", left: 14, top: 14, opacity: inOut(f, t("gym") + 6, 14) }}>
                <Chip label="phone · whole set at 3.5×" tone="none" mono size={16} style={{ background: "rgba(255,255,255,.92)", color: C.fg }} />
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <Rise at={t("gym") + 10}>
                <div
                  style={{
                    fontFamily: F.display,
                    fontSize: 40,
                    fontWeight: 600,
                    color: C.fg,
                    letterSpacing: -1.1,
                    lineHeight: 1.3,
                  }}
                >
                  We pointed it at a phone
                  <br />
                  recording a gym session.
                </div>
              </Rise>

              {/* The log writing itself, one line per thing it worked out. */}
              <div style={{ marginTop: 26, display: "flex", flexDirection: "column", gap: 10 }}>
                {[
                  { at: t("loggedIt"), k: "machine", v: "lat pulldown" },
                  { at: t("loggedIt") + 14, k: "reps", v: String(REP_F.filter((r) => f >= r).length) },
                  { at: t("loggedIt") + 28, k: "weight", v: "57 kg · asked" },
                ].map((r) => {
                  const p = inOut(f, r.at, 14);
                  return (
                    <div
                      key={r.k}
                      style={{
                        opacity: p,
                        transform: `translateX(${(1 - p) * -14}px)`,
                        display: "flex",
                        justifyContent: "space-between",
                        width: 440,
                        padding: "12px 18px",
                        borderRadius: R.r,
                        background: C.provedWash,
                        border: `1px solid ${C.provedEdge}`,
                      }}
                    >
                      <Mono size={19} color={C.dimmer}>
                        {r.k}
                      </Mono>
                      <Mono size={19} color={C.provedText} style={{ fontWeight: 700 }}>
                        {r.v}
                      </Mono>
                    </div>
                  );
                })}
              </div>

              <Rise at={t("nobodyTyped")} style={{ marginTop: 28 }}>
                <div
                  style={{
                    fontFamily: F.display,
                    fontSize: 38,
                    fontWeight: 700,
                    color: C.fg,
                    letterSpacing: -1.1,
                  }}
                >
                  Nobody typed anything in.
                </div>
              </Rise>
            </div>
          </div>
        </Phase>
      )}
    </AbsoluteFill>
  );
};

/**
 * The kitchen camera: Sai's sink, as a still, pushed in slowly so it reads as
 * a feed rather than a photo. The box lands on the dishes when the
 * "dishes in the sink" sub-goal arrives, and moves with the push-in.
 */
const SinkShot: React.FC<{ at: number; fire: number; until: number }> = ({ at, fire, until }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 18);
  const fired = inOut(f, fire, 14);
  const zoom = 1 + 0.06 * Math.min(1, Math.max(0, (f - at) / Math.max(1, until - at)));
  return (
    <div
      style={{
        width: 470, height: 330, borderRadius: R.r2, overflow: "hidden", position: "relative",
        opacity: p, transform: `scale(${0.985 + p * 0.015})`, background: "#0D1B26",
        boxShadow: "0 1px 2px rgba(13,27,38,.05), 0 16px 40px -14px rgba(13,27,38,.20)",
      }}
    >
      <div style={{ position: "absolute", inset: 0, transform: `scale(${zoom})`, transformOrigin: "50% 50%" }}>
        <Img src={staticFile("footage/sink.jpg")} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        <div
          style={{
            position: "absolute", left: 86, top: 60, width: 210, height: 240, borderRadius: 18,
            border: `2.5px solid ${C.bad}`, opacity: fired,
            boxShadow: `0 0 0 ${5 * fired}px rgba(224,36,36,.16)`,
          }}
        />
      </div>
      <div style={{ position: "absolute", left: 14, top: 14, display: "flex", alignItems: "center", gap: 8,
                    padding: "5px 11px", borderRadius: 999, background: "rgba(13,27,38,.62)" }}>
        <span style={{ width: 8, height: 8, borderRadius: 8, background: C.bad }} />
        <Mono size={14} color={C.onDark}>CAM 2 · KITCHEN</Mono>
      </div>
      <div style={{ position: "absolute", right: 14, bottom: 14, opacity: fired }}>
        <Chip label="dishes in the sink · fired" tone="bad" mono size={15} style={{ background: "rgba(255,255,255,.94)" }} />
      </div>
    </div>
  );
};
