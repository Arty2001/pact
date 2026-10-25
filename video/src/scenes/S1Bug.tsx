/**
 * Beat 1 - everyone has goals. 0:00 to 0:25.
 *
 * Four moments. The opening is about ambition rather than about habit apps
 * being bad: the premise is that people already know what they want, and the
 * thing that fails is the tracking. A habit grid is one of four pieces of
 * evidence for that, not the subject.
 *
 * Then the status quo, shown as the mechanism rather than as a number, and
 * the flip. The first hue in the film arrives with the product.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { C, F, T, R, s } from "../lib/theme";
import { Rise, WordsOn, Mono, inOut, outIn, Eyebrow, Phase } from "../lib/prims";
import { CostStream } from "./parts/CostStream";

const AMBITIONS = [
  "Run in the morning.",
  "Get stronger.",
  "Keep the place clean.",
  "Read before bed.",
  "Call home more.",
];

/** A habit grid. One of four things people keep by hand, not the point. */
const Streak: React.FC = () => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 18px)", gap: 5 }}>
    {Array.from({ length: 28 }, (_, i) => (
      <div
        key={i}
        style={{
          width: 18,
          height: 18,
          borderRadius: 3,
          background: i < 9 ? C.provedWash : C.sunk,
          border: `1px solid ${i < 9 ? C.provedEdge : C.hair}`,
        }}
      />
    ))}
  </div>
);

/** A written log. Lines of a notes app, abstracted to their shape. */
const Log: React.FC = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 9, width: 176 }}>
    {[1, 0.86, 0.94, 0.62, 0.78].map((w, i) => (
      <div
        key={i}
        style={{ height: 10, width: `${w * 100}%`, borderRadius: 2, background: C.sunk }}
      />
    ))}
  </div>
);

/** A spreadsheet. The most common tracker there is. */
const Sheet: React.FC = () => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 34px)", gap: 1 }}>
    {Array.from({ length: 20 }, (_, i) => (
      <div
        key={i}
        style={{
          height: 20,
          background: i < 5 ? C.sunk : "transparent",
          border: `1px solid ${C.hair}`,
        }}
      />
    ))}
  </div>
);

/** Paper. Two ticked, three not, which is how it usually goes. */
const Paper: React.FC = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 11, width: 176 }}>
    {[true, true, false, false, false].map((done, i) => (
      <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 15,
            height: 15,
            borderRadius: 3,
            border: `1.5px solid ${done ? C.provedEdge : C.line}`,
            background: done ? C.provedWash : "transparent",
          }}
        />
        <div style={{ height: 9, flex: 1, borderRadius: 2, background: C.sunk }} />
      </div>
    ))}
  </div>
);

const Manual: React.FC<{ at: number; title: string; children: React.ReactNode }> = ({
  at,
  title,
  children,
}) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 16);
  return (
    <div
      style={{
        opacity: p,
        transform: `translateY(${(1 - p) * 18}px)`,
        width: 258,
        padding: 24,
        borderRadius: R.r2,
        background: C.glass,
        border: `1px solid ${C.hair}`,
      }}
    >
      <div style={{ height: 132, display: "flex", alignItems: "center" }}>{children}</div>
      <div
        style={{
          marginTop: 14,
          paddingTop: 14,
          borderTop: `1px solid ${C.hair}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Mono size={17} color={C.dim}>
          {title}
        </Mono>
        <Mono size={15} color={C.dimmer}>
          by hand
        </Mono>
      </div>
    </div>
  );
};

export const S1Bug: React.FC = () => {
  const f = useCurrentFrame();

  const M2 = s(6.6);
  const M3 = s(12.3);
  const M4 = s(18.0);

  return (
    <AbsoluteFill>
      {/* 1. What people already have. No colour, no product, no problem yet -
          just the thing everyone in the room recognises. */}
      <Phase from={0} to={M2 - 12}>
        <div style={{ textAlign: "center" }}>
          <WordsOn
            text="Everyone has goals."
            at={6}
            every={4}
            style={{
              fontFamily: F.display,
              fontSize: 92,
              fontWeight: 700,
              color: C.fg,
              letterSpacing: -3.4,
            }}
          />
          <div style={{ height: 40 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
            {AMBITIONS.map((a, i) => (
              <Rise key={a} at={34 + i * 11} y={14}>
                <div
                  style={{
                    fontFamily: F.ui,
                    fontSize: T.sub,
                    color: C.dim,
                    fontWeight: 400,
                    letterSpacing: -0.7,
                  }}
                >
                  {a}
                </div>
              </Rise>
            ))}
          </div>
          <Rise at={s(4.6)} y={18} style={{ marginTop: 42 }}>
            <div
              style={{
                fontFamily: F.display,
                fontSize: 38,
                color: C.fg,
                fontWeight: 600,
                letterSpacing: -1,
              }}
            >
              The hard part was never deciding.
            </div>
          </Rise>
        </div>
      </Phase>

      {/* 2. Why it fails. Four things people keep by hand - the habit app is
          one of them, not the subject - and every one of them needs you. */}
      {f >= M2 - 4 && (
        <Phase from={M2} to={M3 - 12}>
          <div style={{ textAlign: "center" }}>
            <Rise at={M2 + 4} y={18}>
              <div
                style={{
                  fontFamily: F.display,
                  fontSize: 64,
                  color: C.fg,
                  fontWeight: 700,
                  letterSpacing: -2.4,
                  marginBottom: 46,
                }}
              >
                None of it tracks itself.
              </div>
            </Rise>

            <div style={{ display: "flex", gap: 26, justifyContent: "center" }}>
              <Manual at={M2 + 56} title="habit app">
                <Streak />
              </Manual>
              <Manual at={M2 + 68} title="notes">
                <Log />
              </Manual>
              <Manual at={M2 + 80} title="spreadsheet">
                <Sheet />
              </Manual>
              <Manual at={M2 + 92} title="paper">
                <Paper />
              </Manual>
            </div>

          </div>
        </Phase>
      )}

      {/* 3. The obvious way, drawn as the mechanism: every frame is a request,
          every request a charge, and the charge compounds. */}
      {f >= M3 - 4 && (
        <Phase from={M3} to={M4 - 10}>
          <div>
            <div style={{ marginLeft: 4 }}>
              <Eyebrow at={M3 + 2}>so we wanted one that just watches</Eyebrow>
            </div>
            <CostStream at={M3 + 8} />
          </div>
        </Phase>
      )}

      {/* 4. The flip. */}
      {f >= M4 - 4 && (
        <Phase from={M4}>
          <div style={{ textAlign: "center" }}>
            <Rise at={M4 + 20} y={30}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 22,
                }}
              >
                <Hex at={M4 + 22} />
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
            <Rise at={M4 + 40} y={20}>
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
                private · always on
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
