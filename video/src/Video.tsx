/**
 * The cut.
 *
 * Nine scenes, hard-cut on the beat, each carrying its own voiceover line.
 *
 * Durations are fitted to the MEASURED length of each recorded line, not to a
 * word count: VO_S below is what ffprobe reports for the files in public/vo,
 * and a scene is its line plus a lead-in and a tail, floored at whatever its
 * animation needs to finish and be read. Timing a cut to an estimate and then
 * dropping real audio on it is how scenes end up talking over their own
 * punchlines.
 *
 * Re-record a line and the only thing to change is its number in VO_S.
 */

import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { GROUND, F, C, FPS } from "./lib/theme";
import { loadFonts } from "./lib/fonts";

import { S1Bug } from "./scenes/S1Bug";
import { S2Type } from "./scenes/S2Type";
import { S3Plan } from "./scenes/S3Plan";
import { S4Live } from "./scenes/S4Live";
import { S5Tree } from "./scenes/S5Tree";
import { S6Count } from "./scenes/S6Count";
import { S7Ladder } from "./scenes/S7Ladder";
import { S8Change } from "./scenes/S8Change";
import { S9Close } from "./scenes/S9Close";
import { Grain } from "./lib/grain";
import { Backdrop, Chrome } from "./lib/backdrop";
import { ScenePush } from "./lib/prims";

loadFonts();

/** Measured length of each line in public/vo, in seconds. */
const VO_S = {
  b1: 21.14,
  b2: 6.02,
  b3: 29.71,
  b4: 15.77,
  b5: 14.21,
  b6: 12.14,
  b7: 18.90,
  b8: 18.34,
  b9: 12.40,
} as const;

/** Silence before the line starts, so the picture establishes first. */
export const LEAD = Math.round(0.6 * FPS);

/**
 * Per-scene length in frames.
 *
 * Each is max(line + lead + tail, what the animation needs). Where the second
 * term wins the scene holds in silence on purpose - beat 8 ends on the cost
 * cards with nothing said over them, which is the strongest place in the film
 * for the voice to stop.
 */
const SCENE_F = {
  s1: 690,
  s2: 240,
  s3: 948,
  s4: 528,
  s5: 480,
  s6: 420,
  s7: 621,
  s8: 606,
  s9: 426,
} as const;

const keys = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"] as const;

/** Start frames, derived so a duration change can never desync the cut. */
export const CUT = (() => {
  const out = {} as Record<(typeof keys)[number], readonly [number, number]>;
  let at = 0;
  for (const k of keys) {
    out[k] = [at, SCENE_F[k]] as const;
    at += SCENE_F[k];
  }
  return out;
})();

export const TOTAL = keys.reduce((n, k) => n + SCENE_F[k], 0);

const Beat: React.FC<{
  span: readonly [number, number];
  vo: keyof typeof VO_S;
  chapter: string;
  n: number;
  children: React.ReactNode;
}> = ({ span, vo, chapter, n, children }) => (
  <Sequence from={span[0]} durationInFrames={span[1]} layout="none">
    {/* The push is on scene content only. The chrome stays locked to the
        frame, which is what makes the move read as a camera rather than as
        the whole picture breathing. */}
    <ScenePush dur={span[1]}>{children}</ScenePush>
    <Chrome chapter={chapter} index={n} total={9} />
    <Sequence from={LEAD} layout="none">
      <Audio src={staticFile(`vo/${vo}.mp3`)} />
    </Sequence>
  </Sequence>
);

export const Pact: React.FC = () => (
  <AbsoluteFill
    style={{
      background: GROUND,
      fontFamily: F.ui,
      color: C.fg,
      // Antialiasing on a light ground: without this, 150px display type
      // renders visibly chunkier in headless Chrome than in the studio.
      WebkitFontSmoothing: "antialiased",
    }}
  >
    <Backdrop />

    <Beat span={CUT.s1} vo="b1" chapter="the problem" n={1}>
      <S1Bug />
    </Beat>
    <Beat span={CUT.s2} vo="b2" chapter="you say it" n={2}>
      <S2Type />
    </Beat>
    <Beat span={CUT.s3} vo="b3" chapter="it breaks it down" n={3}>
      <S3Plan />
    </Beat>
    <Beat span={CUT.s4} vo="b4" chapter="fifty cost what one costs" n={4}>
      <S4Live />
    </Beat>
    <Beat span={CUT.s5} vo="b5" chapter="most of it never happens" n={5}>
      <S5Tree />
    </Beat>
    <Beat span={CUT.s6} vo="b6" chapter="then it counts" n={6}>
      <S6Count />
    </Beat>
    <Beat span={CUT.s7} vo="b7" chapter="when it can't tell" n={7}>
      <S7Ladder />
    </Beat>
    <Beat span={CUT.s8} vo="b8" chapter="one system, any goal" n={8}>
      <S8Change />
    </Beat>
    <Beat span={CUT.s9} vo="b9" chapter="the pact" n={9}>
      <S9Close />
    </Beat>

    <Grain />
  </AbsoluteFill>
);
