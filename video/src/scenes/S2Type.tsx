/**
 * Beat 2 - you type it, or you say it. 0:18 to 0:31.
 *
 * The slowest beat in the film at 125 words a minute, on purpose. The pitch
 * is that setup is one sentence, and the only way to land that is to let the
 * audience watch the sentence being typed in real time and then stop.
 *
 * "No dataset, no training, no code" used to be three words struck through,
 * which asks the viewer to already know what that would have cost. So the
 * three things now appear as the artefacts they are - a labelled set, a
 * training run, a checkpoint to serve - and get struck off. Showing the work
 * you are NOT doing is the only way that line means anything to someone who
 * has never had to do it.
 *
 * No counts on those cards. Any number there would be invented, and one
 * invented figure would undermine every measured one in the film.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, F, T, R, s } from "../lib/theme";
import { Pane, TypeOn, Rise, Mono, inOut } from "../lib/prims";

/** The console's mic. Violet, pulsing, because violet means watching. */
const Mic: React.FC<{ at: number }> = ({ at }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 16);
  const pulse = 0.5 + 0.5 * Math.sin((f - at) / 9);
  return (
    <div
      style={{
        position: "relative",
        width: 72,
        height: 72,
        borderRadius: 999,
        display: "grid",
        placeItems: "center",
        background: C.watchWash,
        border: `1px solid ${C.watchEdge}`,
        opacity: p,
        transform: `scale(${0.9 + p * 0.1})`,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: -10,
          borderRadius: 999,
          border: `2px solid ${C.watch}`,
          opacity: p * (1 - pulse) * 0.5,
          transform: `scale(${1 + pulse * 0.22})`,
        }}
      />
      <svg width="32" height="32" viewBox="0 0 20 20">
        <rect
          x="7"
          y="2.5"
          width="6"
          height="9.5"
          rx="3"
          fill="none"
          stroke={C.watchText}
          strokeWidth="1.6"
        />
        <path
          d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5"
          fill="none"
          stroke={C.watchText}
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
};

/** A grid of frames somebody would have had to sit and label. */
const Dataset: React.FC = () => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 34px)", gap: 5 }}>
    {Array.from({ length: 18 }, (_, i) => (
      <div
        key={i}
        style={{
          height: 24,
          borderRadius: 3,
          position: "relative",
          background: "repeating-linear-gradient(135deg, #1B2B37 0 6px, #16242F 6px 12px)",
          border: `1px solid ${C.line}`,
        }}
      >
        <span
          style={{
            position: "absolute",
            right: 3,
            bottom: 3,
            width: 6,
            height: 6,
            borderRadius: 999,
            background: i % 3 === 0 ? C.proved : C.bad,
            opacity: 0.85,
          }}
        />
      </div>
    ))}
  </div>
);

/** A loss curve. The shape is the whole story; no axis values are claimed. */
const Training: React.FC = () => (
  <svg width="228" height="112" style={{ display: "block" }}>
    <line x1="2" x2="226" y1="104" y2="104" stroke={C.hair} strokeWidth="1.5" />
    <line x1="2" x2="2" y1="6" y2="104" stroke={C.hair} strokeWidth="1.5" />
    <path
      d="M 6 16 C 50 70, 70 84, 110 90 S 180 97, 224 99"
      fill="none"
      stroke={C.dimmer}
      strokeWidth="2.5"
      strokeLinecap="round"
    />
    {[0.22, 0.46, 0.7].map((x, i) => (
      <line
        key={i}
        x1={6 + x * 218}
        x2={6 + x * 218}
        y1="6"
        y2="104"
        stroke={C.hair}
        strokeWidth="1"
        strokeDasharray="3 5"
      />
    ))}
  </svg>
);

/** A checkpoint, and somewhere to serve it from. */
const Deploy: React.FC = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            width: 74,
            height: 20,
            borderRadius: 3,
            background: C.sunk,
            border: `1px solid ${C.line}`,
          }}
        />
      ))}
    </div>
    <svg width="34" height="14">
      <path
        d="M0 7 H26 M20 2 L26 7 L20 12"
        fill="none"
        stroke={C.dimmer}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
    <div
      style={{
        width: 84,
        height: 72,
        borderRadius: 999,
        background: C.sunk,
        border: `1px solid ${C.line}`,
        display: "grid",
        placeItems: "center",
      }}
    >
      <Mono size={14} color={C.dimmer}>
        serve
      </Mono>
    </div>
  </div>
);

/** One thing you do not have to do, struck off as it is named. */
const Skipped: React.FC<{
  at: number;
  title: string;
  children: React.ReactNode;
}> = ({ at, title, children }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 15);
  const cut = inOut(f, at + 13, 17);
  return (
    <div
      style={{
        position: "relative",
        opacity: p * (1 - cut * 0.42),
        transform: `translateY(${(1 - p) * 18}px)`,
        width: 300,
        padding: 24,
        borderRadius: R.r2,
        background: C.glass,
        border: `1px solid ${C.hair}`,
      }}
    >
      <div style={{ height: 116, display: "flex", alignItems: "center" }}>{children}</div>
      <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.hair}` }}>
        <Mono size={19} color={C.dim}>
          {title}
        </Mono>
      </div>
      {/* The strike. Drawn across the whole card, not just the words. */}
      <div
        style={{
          position: "absolute",
          left: 18,
          right: 18,
          top: "50%",
          height: 3,
          borderRadius: 2,
          background: C.proved,
          transform: `scaleX(${cut})`,
          transformOrigin: "left center",
        }}
      />
    </div>
  );
};

/** Scene length, so the handoff can start relative to the end of it. */
const LEN = 240;

export const S2Type: React.FC = () => {
  const f = useCurrentFrame();
  const HANDOFF = inOut(f, LEN - 13, 13);

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      {/*
        The handoff. Beat 3 opens on the same sentence, so this beat does not
        cut away from it - it hands it over. Over the last twelve frames the
        pane recedes and rises toward where the next scene will put the text,
        and beat 3's goal line settles in from slightly larger. The cut lands
        in the middle of one continuous move, so the sentence reads as the
        same object rather than as two shots of the same words.
      */}
      <div
        style={{
          width: 1180,
          transform: `translateY(${-28 * HANDOFF}px) scale(${1 - 0.07 * HANDOFF})`,
          opacity: 1 - 0.25 * HANDOFF,
        }}
      >
        <Pane raised pad={36} style={{ width: "100%" }}>
          <Mono size={T.micro} color={C.dimmer}>
            What do you want to track?
          </Mono>
          <div style={{ height: 18 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 26 }}>
            <div
              style={{
                flex: 1,
                minHeight: 86,
                display: "flex",
                alignItems: "center",
                padding: "0 26px",
                borderRadius: R.r,
                background: C.glassHi,
                border: `1px solid ${C.line}`,
              }}
            >
              {/* Typed at the speed the voice reads it, so the sentence
                  finishes on the word rather than three seconds early. */}
              <TypeOn
                text="I want to do 20 pushups every morning"
                at={s(3.3)}
                cps={13}
                style={{
                  fontFamily: F.ui,
                  fontSize: 36,
                  color: C.fg,
                  fontWeight: 500,
                  letterSpacing: -0.9,
                }}
              />
            </div>
            <Mic at={s(1.5)} />
          </div>
          <Rise at={s(1.9)} style={{ marginTop: 16 }}>
            <Mono size={T.micro} color={C.watchText}>
              or hold the mic and just say it
            </Mono>
          </Rise>
        </Pane>

        <Rise at={s(6.5)} style={{ marginTop: 40, textAlign: "center" }}>
          <span
            style={{
              fontFamily: F.display,
              fontSize: 42,
              color: C.fg,
              fontWeight: 600,
              letterSpacing: -1.2,
            }}
          >
            That's the whole setup.
          </span>
        </Rise>

        {/* What it would otherwise have taken. Named, drawn, struck off. */}
        <div
          style={{
            marginTop: 30,
            display: "flex",
            gap: 26,
            justifyContent: "center",
          }}
        >
          <Skipped at={s(7.5)} title="no dataset">
            <Dataset />
          </Skipped>
          <Skipped at={s(8.3)} title="no training">
            <Training />
          </Skipped>
          <Skipped at={s(9.1)} title="no code">
            <Deploy />
          </Skipped>
        </div>
      </div>
    </AbsoluteFill>
  );
};
