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

/** Per-beat lead: frames from the scene cut to the first word, measured from Sai's read. */
export const LEAD_B = {"b1": 18, "demo": 18, "b2": 4, "b3": 4, "b4": 3, "b5": 3, "b6": 4, "b7": 4, "b8": 3, "b9": 4} as const;

/** Phrase start times, seconds into the line. */
export const PHRASE = {
  b1: {
    goals: 0.0,
    deciding: 1.52,
    keepingTrack: 3.52,
    hackathon: 4.88,
    builtOne: 6.96,
    onTop: 9.76,
    frontier: 11.12,
    perCamera: 16.64,
    almostNothing: 17.68,
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
    typeIt: 1.28,
    orSayIt: 1.92,
    sentence: 3.44,
  },
  b3: {
    breaksDown: 0.0,
    inARoom: 2.4,
    pushupPosition: 3.44,
    twentyOfThem: 5.04,
    beforeNoon: 6.0,
    pixels: 6.88,
    words: 8.4,
    dontCompare: 10.16,
    sameSpace: 11.52,
    encoder: 13.69,
    frameNumbers: 15.37,
    sentenceNumbers: 17.45,
    twoPoints: 21.69,
    howClose: 23.61,
  },
  b4: {
    oneComparison: 0.0,
    fiftyThings: 3.84,
    shared: 8.09,
    cameFrom: 9.85,
    oneTree: 12.41,
    insteadOfFifty: 14.57,
  },
  b5: {
    hierarchy: 0.0,
    stillRoom: 2.08,
    walkIn: 4.48,
    passes: 5.44,
    wakes: 6.8,
    asleep: 8.72,
    neverScored: 10.64,
    asHard: 11.84,
  },
  b6: {
    canCount: 0.0,
    upAndDown: 1.36,
    oneEntry: 2.8,
    notAFlicker: 4.0,
    notTwice: 5.36,
    doesntCount: 7.12,
    saysWhy: 8.64,
    tooShort: 9.84,
    neverConfident: 10.8,
  },
  b7: {
    cantTell: 0.0,
    doesntGuess: 1.04,
    fourFrames: 2.4,
    unsure: 7.15,
    noCamera: 8.75,
    weightOnBar: 10.67,
    asksYou: 12.27,
    becomesLabel: 13.39,
    modelsNeverChange: 15.39,
    sharpens: 16.83,
  },
  b8: {
    anyGoal: 0.0,
    sinkClear: 2.16,
    inverted: 3.92,
    anyStream: 7.65,
    phone: 10.69,
    screenShare: 11.65,
    board: 12.77,
    gym: 14.29,
    loggedIt: 17.73,
    nobodyTyped: 19.65,
  },
  b9: {
    fewThings: 0.0,
    aRule: 3.2,
    noVideo: 5.91,
    stillExplain: 7.75,
    promise: 10.95,
    keepsIt: 14.74,
  },
} as const;

/** A phrase's start, as a frame number inside its scene. */
export const at = <K extends keyof typeof PHRASE>(
  beat: K,
  phrase: keyof (typeof PHRASE)[K],
): number => Math.round((PHRASE[beat][phrase] as number) * FPS) + LEAD_B[beat];

/** Shorthand for a scene that only ever reads its own beat. */
export const timing =
  <K extends keyof typeof PHRASE>(beat: K) =>
  (phrase: keyof (typeof PHRASE)[K]): number =>
    at(beat, phrase);
