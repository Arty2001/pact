/**
 * The video's design tokens, lifted from public/pact.css rather than invented.
 *
 * Three rules carry over from the product and they are the whole motion
 * language, so they are worth restating here:
 *
 *   Green is a signal, never a surface.
 *   Hue carries one meaning: green proved, violet watching, amber pending.
 *   Surfaces are glass over a two-bloom ground.
 *
 * A fourth rule exists only in the video: the accent marks the NEW idea, the
 * winning number and the call to action. Everything describing the old way
 * is drawn in neutrals and never in hue.
 */

export const C = {
  bg: "#EDF1F4",
  bloomA: "rgba(118, 185, 0, .13)",
  bloomB: "rgba(97, 78, 250, .10)",

  glass: "rgba(255, 255, 255, .58)",
  glassHi: "rgba(255, 255, 255, .76)",
  glassTop: "rgba(255, 255, 255, .85)",
  sunk: "rgba(16, 36, 54, .045)",

  hair: "rgba(16, 36, 54, .07)",
  line: "rgba(16, 36, 54, .13)",
  ring: "rgba(16, 36, 54, .09)",

  fg: "#0D1B26",
  dim: "#4C6271",
  dimmer: "#7C91A1",

  proved: "#76B900",
  provedText: "#3C6500",
  provedWash: "rgba(118, 185, 0, .14)",
  provedEdge: "rgba(118, 185, 0, .36)",

  watch: "#614EFA",
  watchText: "#3B29C2",
  watchWash: "rgba(97, 78, 250, .11)",
  watchEdge: "rgba(97, 78, 250, .32)",

  pending: "#FF9900",
  pendingText: "#875200",
  pendingWash: "rgba(255, 153, 0, .15)",
  pendingEdge: "rgba(255, 153, 0, .38)",

  bad: "#E02424",
  badText: "#B01717",
  badWash: "rgba(224, 36, 36, .10)",
  badEdge: "rgba(224, 36, 36, .32)",

  onDark: "#F2F6F9",
  onDarkDim: "#A6B8C5",
  provedOnDark: "#BFF230",
} as const;

export const F = {
  ui: '"Inter", ui-sans-serif, system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, Menlo, monospace',
  display: '"Hanken Grotesk", "Inter", ui-sans-serif, sans-serif',
} as const;

export const R = { r: 8, r2: 14, r3: 20 } as const;

export const LIFT =
  "0 1px 2px rgba(13, 27, 38, .05), 0 3px 10px -3px rgba(13, 27, 38, .07)";
export const LIFT2 =
  "0 1px 2px rgba(13, 27, 38, .05), 0 16px 40px -14px rgba(13, 27, 38, .20)";
export const INNER = "inset 0 1px 0 rgba(255, 255, 255, .7)";

/** The ground. Fixed blooms, so motion crosses the light rather than dragging it. */
export const GROUND = `radial-gradient(1120px 640px at 6% -10%, ${C.bloomA}, transparent 60%), radial-gradient(940px 720px at 104% 8%, ${C.bloomB}, transparent 58%), ${C.bg}`;

/**
 * One easing curve for everything that is not a timer.
 *
 * cubic-bezier(0.16, 1, 0.3, 1): a hard out with no bounce. Bounce reads as
 * consumer software and this is instrumentation; the personality lives in the
 * typography and the cuts instead.
 */
export const EASE = [0.16, 1, 0.3, 1] as const;
/** For things leaving. Exits are faster than entrances, always. */
export const EASE_IN = [0.7, 0, 0.84, 0] as const;

/** 30fps throughout. Seconds to frames, so scene code can read in seconds. */
export const FPS = 30;
export const s = (seconds: number) => Math.round(seconds * FPS);

/** Type scale. Minimum 48px headline, 28px label, per the quality bar. */
export const T = {
  mega: 150,
  hero: 104,
  title: 72,
  head: 54,
  sub: 36,
  body: 30,
  label: 26,
  micro: 21,
} as const;
