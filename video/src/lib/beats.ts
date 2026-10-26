/**
 * Where every phrase actually falls in the recorded narration.
 *
 * Measured with silencedetect against the files in public/vo, not estimated
 * from word counts. The previous cut timed its visuals to guesses and then
 * had elements landing a second or two off the words they illustrate - which
 * reads as sloppiness even when nobody can say why.
 *
 * Times are seconds from the START OF THE LINE. Scenes convert with `at()`,
 * which adds the lead-in, so a scene asks for "the frame that says pixels"
 * rather than for a number somebody worked out once.
 *
 * Re-record a line and these move. Regenerate with:
 *   npx remotion ffmpeg -i public/vo/bN.mp3 \
 *     -af "silencedetect=noise=-38dB:d=0.22" -f null NUL
 */

import { FPS } from "./theme";

/** Silence before the narration starts, in frames. Matches LEAD in Video.tsx. */
export const LEAD_F = 18;

/** Phrase start times, seconds into the line. */
export const PHRASE = {
  b1: {
    goals: 0.0,
    deciding: 1.6,
    keepingTrack: 3.57,
    hackathon: 4.89,
    builtOne: 7.41,
    onTop: 10.08,
    frontier: 11.7,
    perCamera: 16.99,
    almostNothing: 18.06,
  },
  demo: {
    wholeThing: 0.0,
    running: 1.34,
    giveGoal: 2.08,
    worksOut: 3.18,
    startsWatching: 4.88,
    everyCamera: 6.13,
    goDoIt: 7.71,
    fillsItself: 9.19,
    heresHow: 10.71,
  },
  b2: {
    youStart: 0.0,
    typeIt: 1.48,
    orSayIt: 2.19,
    sentence: 3.53,
  },
  b3: {
    breaksDown: 0.0,
    inARoom: 2.56,
    pushupPosition: 3.77,
    twentyOfThem: 5.62,
    beforeNoon: 6.51,
    pixels: 7.57,
    words: 9.52,
    dontCompare: 11.27,
    sameSpace: 12.58,
    encoder: 14.83,
    frameNumbers: 16.7,
    sentenceNumbers: 19.42,
    twoPoints: 24.05,
    howClose: 25.61,
  },
  b4: {
    oneComparison: 0.0,
    fiftyThings: 3.49,
    shared: 7.58,
    cameFrom: 8.71,
    oneTree: 11.34,
    insteadOfFifty: 13.59,
  },
  b5: {
    hierarchy: 0.0,
    stillRoom: 2.03,
    walkIn: 4.65,
    passes: 5.79,
    wakes: 7.41,
    asleep: 9.15,
    neverScored: 10.9,
    asHard: 12.0,
  },
  b6: {
    canCount: 0.0,
    upAndDown: 1.58,
    oneEntry: 2.67,
    notAFlicker: 3.7,
    notTwice: 4.99,
    doesntCount: 6.76,
    saysWhy: 8.53,
    tooShort: 9.72,
    neverConfident: 10.56,
  },
  b7: {
    cantTell: 0.0,
    doesntGuess: 1.85,
    fourFrames: 3.29,
    unsure: 6.99,
    noCamera: 8.74,
    weightOnBar: 10.57,
    asksYou: 12.01,
    becomesLabel: 13.15,
    modelsNeverChange: 15.16,
    sharpens: 16.89,
  },
  b8: {
    anyGoal: 0.0,
    sinkClear: 1.92,
    inverted: 3.31,
    anyStream: 6.87,
    phone: 8.1,
    screenShare: 9.02,
    board: 10.2,
    gym: 11.76,
    loggedIt: 14.62,
    nobodyTyped: 16.52,
  },
  b9: {
    fewThings: 0.0,
    aRule: 3.11,
    noVideo: 4.43,
    stillExplain: 5.89,
    promise: 8.81,
    keepsIt: 10.61,
  },
} as const;

/** A phrase's start, as a frame number inside its scene. */
export const at = <K extends keyof typeof PHRASE>(
  beat: K,
  phrase: keyof (typeof PHRASE)[K],
): number => Math.round((PHRASE[beat][phrase] as number) * FPS) + LEAD_F;

/** Shorthand for a scene that only ever reads its own beat. */
export const timing =
  <K extends keyof typeof PHRASE>(beat: K) =>
  (phrase: keyof (typeof PHRASE)[K]): number =>
    at(beat, phrase);
