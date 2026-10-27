import React from "react";
import { Composition } from "remotion";
import { Pact, TOTAL } from "./Video";
import { FPS } from "./lib/theme";
import { Thumb } from "./Thumb";

/**
 * Length is derived from the scene table in Video.tsx, which is itself fitted
 * to the measured voiceover. Hard-coding it here is how a re-recorded line
 * ends up truncated in the render and nowhere else.
 */
export const RemotionRoot: React.FC = () => (
  <>
  <Composition id="Thumb" component={Thumb} durationInFrames={1} fps={FPS} width={1920} height={1080} />
  <Composition
    id="Pact"
    component={Pact}
    durationInFrames={TOTAL}
    fps={FPS}
    width={1920}
    height={1080}
  />
  </>
);
