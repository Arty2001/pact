/**
 * Footage slots.
 *
 * The cut is built before the footage exists, which is deliberate: timing a
 * video to clips you have not shot yet is how a shoot ends up serving an edit
 * instead of the other way round. Every slot renders a labelled placeholder
 * at the exact size and position the real clip will occupy, with the shot
 * number from the shot list on it, so the storyboard is also the shot brief.
 *
 * To drop a clip in: put the file in `public/footage/` and pass `src`. The
 * placeholder disappears and nothing else about the scene changes.
 */

import React from "react";
import { OffthreadVideo, staticFile, useCurrentFrame } from "remotion";
import { C, F, R } from "./theme";
import { inOut } from "./prims";

export const FootageSlot: React.FC<{
  shot: number;
  note: string;
  at: number;
  w: number;
  h: number;
  src?: string;
  /** Seconds into the clip to start, once there is a clip. */
  startFrom?: number;
  style?: React.CSSProperties;
  radius?: number;
}> = ({ shot, note, at, w, h, src, startFrom = 0, style, radius = R.r2 }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 18);

  return (
    <div
      style={{
        width: w,
        height: h,
        borderRadius: radius,
        overflow: "hidden",
        position: "relative",
        opacity: p,
        transform: `scale(${0.985 + p * 0.015})`,
        background: "#0D1B26",
        boxShadow: "0 1px 2px rgba(13,27,38,.05), 0 16px 40px -14px rgba(13,27,38,.20)",
        ...style,
      }}
    >
      {src ? (
        <OffthreadVideo
          src={staticFile(`footage/${src}`)}
          startFrom={startFrom}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
          muted
        />
      ) : (
        <Placeholder shot={shot} note={note} w={w} h={h} />
      )}
    </div>
  );
};

/**
 * What a slot looks like before the shoot.
 *
 * Deliberately not a grey box: it carries the shot number and the direction,
 * so a frame grab of the animatic is something you can hand to whoever is
 * holding the camera.
 */
const Placeholder: React.FC<{ shot: number; note: string; w: number; h: number }> = ({
  shot,
  note,
  w,
  h,
}) => {
  const f = useCurrentFrame();
  const sweep = ((f * 1.6) % (w + 260)) - 130;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        background:
          "repeating-linear-gradient(135deg, #12222E 0 14px, #0D1B26 14px 28px)",
      }}
    >
      {/* A slow sweep, so a placeholder never reads as a frozen render. */}
      <div
        style={{
          position: "absolute",
          left: sweep,
          top: 0,
          width: 130,
          height: "100%",
          background:
            "linear-gradient(90deg, transparent, rgba(97,78,250,.14), transparent)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 10,
          border: `2px dashed rgba(166,184,197,.3)`,
          borderRadius: R.r,
        }}
      />
      <div
        style={{
          fontFamily: F.mono,
          fontSize: Math.max(15, Math.min(22, w / 26)),
          letterSpacing: 2.6,
          color: "#A6B8C5",
          textTransform: "uppercase",
          zIndex: 1,
        }}
      >
        Shot {shot}
      </div>
      <div
        style={{
          fontFamily: F.ui,
          fontSize: Math.max(15, Math.min(26, w / 22)),
          color: "#F2F6F9",
          fontWeight: 500,
          maxWidth: w * 0.78,
          textAlign: "center",
          lineHeight: 1.35,
          zIndex: 1,
        }}
      >
        {note}
      </div>
    </div>
  );
};

/** A camera-watching frame border. Violet, because violet means watching. */
export const WatchFrame: React.FC<{ at: number; inset?: number }> = ({ at, inset = 0 }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 14);
  const pulse = 0.45 + 0.55 * Math.abs(Math.sin((f - at) / 26));
  return (
    <div
      style={{
        position: "absolute",
        inset,
        border: `2px solid ${C.watch}`,
        borderRadius: R.r2,
        opacity: p * pulse * 0.85,
        pointerEvents: "none",
      }}
    />
  );
};
