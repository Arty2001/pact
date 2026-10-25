/**
 * The ground, and the chrome around it.
 *
 * The scenes were previously floating in flat near-white, which read as
 * unfinished however good the content was: two thirds of every frame was
 * doing nothing. This is the layer that makes the empty parts of the canvas
 * deliberate.
 *
 * Four things, in order of how much they matter:
 *
 *   A measurement grid, very faint, with heavier rules on a 300px module. It
 *   gives the eye something to register scale against, which is what makes a
 *   centred block read as placed rather than as adrift.
 *
 *   The product's two blooms, stronger than the CSS uses them. On a web page
 *   they sit behind text at a tenth strength; on a 1920-wide frame that is
 *   invisible, and H.264 crushes what little survives.
 *
 *   A vignette, so the frame has edges and the content has somewhere to be.
 *
 *   Corner brackets and a chapter rule, which is the instrumentation feel the
 *   product's own stylesheet asks for - this is a reference monitor, not a
 *   consumer app.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { C, F } from "./theme";
import { inOut } from "./prims";

const MINOR = 60;
const MAJOR = 300;

export const Backdrop: React.FC = () => (
  <AbsoluteFill style={{ pointerEvents: "none" }}>
    {/* The grid. Two weights, so scale is readable without the lines ever
        competing with content. */}
    <svg width="1920" height="1080" style={{ position: "absolute", inset: 0 }}>
      <defs>
        <pattern id="minor" width={MINOR} height={MINOR} patternUnits="userSpaceOnUse">
          <path
            d={`M ${MINOR} 0 L 0 0 0 ${MINOR}`}
            fill="none"
            stroke="rgba(16,36,54,.040)"
            strokeWidth="1"
          />
        </pattern>
        <pattern id="major" width={MAJOR} height={MAJOR} patternUnits="userSpaceOnUse">
          <path
            d={`M ${MAJOR} 0 L 0 0 0 ${MAJOR}`}
            fill="none"
            stroke="rgba(16,36,54,.075)"
            strokeWidth="1"
          />
        </pattern>
        <radialGradient id="vig" cx="50%" cy="46%" r="76%">
          <stop offset="55%" stopColor="rgba(16,36,54,0)" />
          <stop offset="100%" stopColor="rgba(16,36,54,.105)" />
        </radialGradient>
      </defs>
      <rect width="1920" height="1080" fill="url(#minor)" />
      <rect width="1920" height="1080" fill="url(#major)" />

      {/* Crosses on the major intersections. A surveyor's mark, not a dot
          field - it reads as measurement rather than as decoration. */}
      {[0, 1, 2, 3, 4, 5, 6].map((cx) =>
        [0, 1, 2, 3].map((cy) => {
          const x = cx * MAJOR + 60;
          const y = cy * MAJOR + 90;
          return (
            <g key={`${cx}-${cy}`} stroke="rgba(16,36,54,.12)" strokeWidth="1">
              <line x1={x - 5} x2={x + 5} y1={y} y2={y} />
              <line x1={x} x2={x} y1={y - 5} y2={y + 5} />
            </g>
          );
        }),
      )}

      <rect width="1920" height="1080" fill="url(#vig)" />
    </svg>
  </AbsoluteFill>
);

/**
 * Persistent chrome: corner brackets, the chapter, the mark, and a hairline
 * that shows how far through the film you are.
 *
 * Deliberately not a timecode. A timecode reads as a rough cut; a chapter
 * reads as a finished thing with structure.
 */
export const Chrome: React.FC<{
  chapter: string;
  index: number;
  total: number;
}> = ({ chapter, index, total }) => {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const p = inOut(f, 8, 24);
  const through = Math.min(1, f / durationInFrames);

  const B = 46;
  const M = 44;
  const bracket = (x: number, y: number, sx: number, sy: number) => (
    <path
      d={`M ${x + sx * B} ${y} H ${x} V ${y + sy * B}`}
      fill="none"
      stroke="rgba(16,36,54,.19)"
      strokeWidth="1.5"
    />
  );

  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: p }}>
      <svg width="1920" height="1080" style={{ position: "absolute", inset: 0 }}>
        {bracket(M, M, 1, 1)}
        {bracket(1920 - M, M, -1, 1)}
        {bracket(M, 1080 - M, 1, -1)}
        {bracket(1920 - M, 1080 - M, -1, -1)}
      </svg>

      {/* Chapter, bottom left. The only persistent words on screen. */}
      <div
        style={{
          position: "absolute",
          left: M + 22,
          bottom: M + 14,
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}
      >
        <span
          style={{
            fontFamily: F.mono,
            fontSize: 17,
            color: C.dimmer,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {String(index).padStart(2, "0")}
          <span style={{ opacity: 0.5 }}>/{String(total).padStart(2, "0")}</span>
        </span>
        <span style={{ width: 22, height: 1, background: "rgba(16,36,54,.18)" }} />
        <span
          style={{
            fontFamily: F.mono,
            fontSize: 17,
            letterSpacing: 2.6,
            textTransform: "uppercase",
            color: C.dimmer,
          }}
        >
          {chapter}
        </span>
      </div>

      {/* The mark, bottom right. Small, and the same every frame. */}
      <div
        style={{
          position: "absolute",
          right: M + 22,
          bottom: M + 12,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <svg width="17" height="17" viewBox="0 0 20 20">
          <path
            d="M10 1.4 17.4 5.7v8.6L10 18.6 2.6 14.3V5.7z"
            fill="none"
            stroke={C.proved}
            strokeWidth="1.6"
            opacity={0.62}
          />
        </svg>
        <span
          style={{
            fontFamily: F.display,
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: -0.4,
            color: C.dimmer,
          }}
        >
          pact
        </span>
      </div>

      {/* How far through. One hairline, flush to the bottom edge. */}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2 }}>
        <div style={{ position: "absolute", inset: 0, background: "rgba(16,36,54,.07)" }} />
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${through * 100}%`,
            background: C.proved,
            opacity: 0.55,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
