/**
 * The presenter: Sai's recorded read, as one continuous take.
 *
 * Full frame for the opening line, shrinks into a corner bubble on
 * "it's keeping track", grows back to full frame for "You've already made the
 * promise", then fades out on "Pact is the part that keeps it" to leave the mark.
 * The voice is the same take, cleaned and levelled, played as one track so the
 * delivery is never chopped between beats.
 */
import React from "react";
import { AbsoluteFill, Audio, Easing, Freeze, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";

/** Frame at which the recording's t=0 plays. */
export const REC_AT = 18;

export const SHRINK = 124 - 14; // starts just before "it's keeping track"
export const GROW = 4584 - 12;     // just before "You've already made the promise"
const OUT = 4689;            // "and Pact is the part that keeps it"
const MOVE = 20;
/** Last frame of the recording; held if the voice runs a moment past it. */
const LAST = 4668;
const FADE = 14;

// Bubble geometry on the 1920x1080 frame.
const D = 200;
const BX = 1920 - 56 - D;
const BY = 1080 - 86 - D;
// The square of the source frame shown in the bubble: head and shoulders.
const CROP = { x: 695, y: 195, side: 700 };

const ease = Easing.bezier(0.65, 0, 0.35, 1);

export const Presenter: React.FC = () => {
  const f = useCurrentFrame();
  const toBubble = interpolate(f, [SHRINK, SHRINK + MOVE], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const toFull = interpolate(f, [GROW, GROW + MOVE], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const b = toBubble * (1 - toFull); // 0 = full frame, 1 = bubble
  const opacity = interpolate(f, [OUT, OUT + FADE], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  if (opacity <= 0) return null;

  const s = 1 + (D / CROP.side - 1) * b;
  const box = {
    left: BX * b,
    top: BY * b,
    width: 1920 + (D - 1920) * b,
    height: 1080 + (D - 1080) * b,
  };
  const inner = { left: -CROP.x * s * b, top: -CROP.y * s * b, width: 1920 * s, height: 1080 * s };

  const video = <OffthreadVideo src={staticFile("me.mp4")} muted style={{ width: "100%", height: "100%" }} />;

  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity }}>
      <div
        style={{
          position: "absolute",
          ...box,
          overflow: "hidden",
          borderRadius: (D / 2) * b,
          boxShadow: b > 0.01 ? `0 ${18 * b}px ${48 * b}px rgba(15,23,42,${0.28 * b}), 0 0 0 ${4 * b}px rgba(255,255,255,0.95)` : "none",
          background: "#0b1220",
        }}
      >
        <div style={{ position: "absolute", ...inner }}>
          <Freeze frame={Math.max(0, Math.min(f - REC_AT, LAST))}>{video}</Freeze>
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** The cleaned voice, one continuous track. */
export const Voice: React.FC = () => (
  <Sequence from={REC_AT} layout="none">
    <Audio src={staticFile("voice.flac")} />
  </Sequence>
);
