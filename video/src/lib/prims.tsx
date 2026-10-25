/**
 * Primitives. Every one is a pure function of the frame.
 *
 * No CSS transitions, no setTimeout, no requestAnimationFrame. Remotion
 * renders frame N by mounting the tree at frame N, so anything that keeps its
 * own clock renders as a still on every frame and silently drops out of the
 * video. This is the single easiest way to ship a broken render, so the rule
 * is absolute: if it moves, it reads useCurrentFrame().
 */

import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, spring, useVideoConfig } from "remotion";
import { C, EASE, EASE_IN, F, R, LIFT, LIFT2, INNER, T } from "./theme";

const ease = { easing: (t: number) => bez(EASE[0], EASE[1], EASE[2], EASE[3], t) };
const easeIn = { easing: (t: number) => bez(EASE_IN[0], EASE_IN[1], EASE_IN[2], EASE_IN[3], t) };

/** Cubic bezier solved by bisection. Exact enough at 30fps, and dependency-free. */
function bez(x1: number, y1: number, x2: number, y2: number, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let lo = 0;
  let hi = 1;
  let u = t;
  for (let i = 0; i < 24; i++) {
    u = (lo + hi) / 2;
    const x = 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
    if (x < t) lo = u;
    else hi = u;
  }
  return 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
}

/** 0 to 1 over [from, from+dur), eased out. The workhorse. */
export const inOut = (frame: number, from: number, dur: number) =>
  interpolate(frame, [from, from + dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    ...ease,
  });

/** 1 to 0 over [from, from+dur), eased in. Exits are faster than entrances. */
export const outIn = (frame: number, from: number, dur: number) =>
  interpolate(frame, [from, from + dur], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    ...easeIn,
  });

/** Rise and fade in one call, since almost everything enters that way. */
export const Rise: React.FC<{
  at: number;
  dur?: number;
  y?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ at, dur = 16, y = 22, children, style }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, dur);
  return (
    <div style={{ opacity: p, transform: `translateY(${(1 - p) * y}px)`, ...style }}>
      {children}
    </div>
  );
};

/** A slow push-in across a whole scene. 2 to 5 percent, never more. */
export const Push: React.FC<{
  dur: number;
  amount?: number;
  children: React.ReactNode;
}> = ({ dur, amount = 0.03, children }) => {
  const f = useCurrentFrame();
  const scale = interpolate(f, [0, dur], [1, 1 + amount], {
    extrapolateRight: "clamp",
  });
  return (
    <div style={{ width: "100%", height: "100%", transform: `scale(${scale})` }}>
      {children}
    </div>
  );
};

/** Text revealed character by character. Used for anything the user "types". */
export const TypeOn: React.FC<{
  text: string;
  at: number;
  cps?: number;
  caret?: boolean;
  style?: React.CSSProperties;
}> = ({ text, at, cps = 26, caret = true, style }) => {
  const f = useCurrentFrame();
  const n = Math.max(0, Math.min(text.length, Math.floor(((f - at) / 30) * cps)));
  const done = n >= text.length;
  const blink = Math.floor(f / 15) % 2 === 0;
  return (
    <span style={style}>
      {text.slice(0, n)}
      {caret && f >= at && (!done || blink) ? (
        <span
          style={{
            display: "inline-block",
            width: 3,
            height: "0.95em",
            background: C.watch,
            marginLeft: 3,
            transform: "translateY(0.12em)",
            opacity: done && !blink ? 0 : 1,
          }}
        />
      ) : null}
    </span>
  );
};

/** Words appearing one at a time. Calmer than per-character for headlines. */
export const WordsOn: React.FC<{
  text: string;
  at: number;
  every?: number;
  style?: React.CSSProperties;
}> = ({ text, at, every = 4, style }) => {
  const f = useCurrentFrame();
  return (
    <span style={style}>
      {text.split(" ").map((w, i) => {
        const p = inOut(f, at + i * every, 14);
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity: p,
              transform: `translateY(${(1 - p) * 14}px)`,
              marginRight: "0.28em",
            }}
          >
            {w}
          </span>
        );
      })}
    </span>
  );
};

/** A number that counts up and lands. Never linear. */
export const CountUp: React.FC<{
  to: number;
  at: number;
  dur?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  style?: React.CSSProperties;
}> = ({ to, at, dur = 34, decimals = 0, prefix = "", suffix = "", style }) => {
  const f = useCurrentFrame();
  const v = inOut(f, at, dur) * to;
  return (
    <span style={{ fontVariantNumeric: "tabular-nums", ...style }}>
      {prefix}
      {v.toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
      {suffix}
    </span>
  );
};

/** A glass pane. The only surface in the system. */
export const Pane: React.FC<{
  children?: React.ReactNode;
  style?: React.CSSProperties;
  raised?: boolean;
  pad?: number;
}> = ({ children, style, raised, pad = 28 }) => (
  <div
    style={{
      background: raised ? C.glassTop : C.glass,
      border: `1px solid ${C.hair}`,
      borderRadius: R.r2,
      boxShadow: `${raised ? LIFT2 : LIFT}, ${INNER}`,
      backdropFilter: "saturate(165%) blur(20px)",
      padding: pad,
      ...style,
    }}
  >
    {children}
  </div>
);

export type Tone = "proved" | "watch" | "pending" | "bad" | "none";

const toneKit = (t: Tone) =>
  t === "proved"
    ? { text: C.provedText, wash: C.provedWash, edge: C.provedEdge, solid: C.proved }
    : t === "watch"
      ? { text: C.watchText, wash: C.watchWash, edge: C.watchEdge, solid: C.watch }
      : t === "pending"
        ? { text: C.pendingText, wash: C.pendingWash, edge: C.pendingEdge, solid: C.pending }
        : t === "bad"
          ? { text: C.badText, wash: C.badWash, edge: C.badEdge, solid: C.bad }
          : { text: C.dim, wash: C.sunk, edge: C.line, solid: C.dimmer };

/** A state chip. Hue carries the meaning; the chip never fills with it. */
export const Chip: React.FC<{
  label: string;
  tone?: Tone;
  mono?: boolean;
  size?: number;
  style?: React.CSSProperties;
}> = ({ label, tone = "none", mono, size = T.micro, style }) => {
  const k = toneKit(tone);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 14px",
        borderRadius: 999,
        background: k.wash,
        border: `1px solid ${k.edge}`,
        color: k.text,
        fontFamily: mono ? F.mono : F.ui,
        fontSize: size,
        fontWeight: 600,
        letterSpacing: mono ? 0 : -0.1,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {tone !== "none" && (
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: 999,
            background: k.solid,
            flexShrink: 0,
          }}
        />
      )}
      {label}
    </span>
  );
};

/** An arrow that draws itself on. Thin stroke, mono label, no flourish. */
export const DrawArrow: React.FC<{
  d: string;
  at: number;
  dur?: number;
  color?: string;
  width?: number;
  dash?: boolean;
  head?: boolean;
  id?: string;
}> = ({ d, at, dur = 18, color = C.line, width = 2, dash, head = true, id = "a" }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, dur);
  const LEN = 2400;
  return (
    <>
      {head && (
        <defs>
          <marker
            id={`h-${id}`}
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="5.5"
            markerHeight="5.5"
            orient="auto-start-reverse"
          >
            <path d="M0 0L10 5L0 10z" fill={color} opacity={p > 0.92 ? 1 : 0} />
          </marker>
        </defs>
      )}
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={width}
        strokeLinecap="round"
        strokeDasharray={dash ? "7 7" : `${LEN}`}
        strokeDashoffset={dash ? 0 : LEN * (1 - p)}
        opacity={dash ? p : 1}
        markerEnd={head ? `url(#h-${id})` : undefined}
      />
    </>
  );
};

/** A line of code or log, revealed as a unit. Code is a hero element. */
export const Mono: React.FC<{
  children: React.ReactNode;
  size?: number;
  color?: string;
  style?: React.CSSProperties;
}> = ({ children, size = T.micro, color = C.dim, style }) => (
  <span
    style={{
      fontFamily: F.mono,
      fontSize: size,
      color,
      fontVariantNumeric: "tabular-nums",
      ...style,
    }}
  >
    {children}
  </span>
);

/**
 * A skill row, as the console draws it. Appears in five scenes, so it is a
 * primitive rather than five near-copies that drift apart.
 */
export const SkillRow: React.FC<{
  label: string;
  kind: string;
  tone?: Tone;
  state?: string;
  tag?: { text: string; tone: Tone };
  indent?: number;
  dimmed?: boolean;
  at: number;
  width?: number;
}> = ({ label, kind, tone = "none", state, tag, indent = 0, dimmed, at, width = 720 }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 16);
  const k = toneKit(tone);
  return (
    <div
      style={{
        opacity: p * (dimmed ? 0.34 : 1),
        transform: `translateY(${(1 - p) * 16}px)`,
        marginLeft: indent,
        width: width - indent,
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "16px 20px",
        borderRadius: R.r,
        background: tone === "none" ? C.sunk : k.wash,
        border: `1px solid ${tone === "none" ? C.hair : k.edge}`,
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: 999,
          background: tone === "none" ? C.dimmer : k.solid,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontFamily: F.ui,
          fontSize: T.label,
          color: C.fg,
          fontWeight: 500,
          flex: 1,
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        {label}
      </span>
      {tag && <Chip label={tag.text} tone={tag.tone} size={17} style={{ padding: "5px 11px" }} />}
      <Mono size={17} color={C.dimmer}>
        {kind}
      </Mono>
      {state && (
        <Mono size={17} color={k.text} style={{ fontWeight: 700 }}>
          {state}
        </Mono>
      )}
    </div>
  );
};

/** Section eyebrow. Mono, uppercase, tracked out. Orients without explaining. */
export const Eyebrow: React.FC<{ children: React.ReactNode; at: number }> = ({
  children,
  at,
}) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 14);
  return (
    <div
      style={{
        opacity: p * 0.9,
        fontFamily: F.mono,
        fontSize: 19,
        letterSpacing: 3.4,
        textTransform: "uppercase",
        color: C.dimmer,
        marginBottom: 22,
      }}
    >
      {children}
    </div>
  );
};

/** A spring, for the one or two elements allowed a little personality. */
export const useWiggle = (at: number, strength = 1) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({
    frame: f - at,
    fps,
    config: { damping: 11, mass: 0.55, stiffness: 150 },
  }) * strength;
};

/**
 * A phase of a scene, entering and leaving with direction.
 *
 * Scenes used to swap phases with opposing opacity fades in the same
 * position, which reads as mush: for a third of a second two unrelated
 * layouts occupy one space at half strength and the eye has nothing to
 * follow. Giving the outgoing phase somewhere to GO - and the incoming one
 * somewhere to come FROM - turns a dissolve into a move, and the eye tracks
 * a move.
 *
 * Everything travels the same way (up and out, in from below), so a scene
 * reads as one continuous upward advance rather than a set of swaps.
 *
 * `from`/`to` are scene frames. `to` omitted means this phase runs to the
 * end of the scene and never leaves.
 */
export const Phase: React.FC<{
  from: number;
  to?: number;
  /** Entrance travel in px. Exits use the same distance, upward. */
  travel?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ from, to, travel = 30, children, style }) => {
  const f = useCurrentFrame();
  const ENTER = 15;
  // Exits are faster than entrances, always.
  const LEAVE = 10;

  if (f < from - 2) return null;
  if (to !== undefined && f > to + LEAVE + 2) return null;

  const enter = inOut(f, from, ENTER);
  const leave = to === undefined ? 0 : inOut(f, to, LEAVE);

  const y = (1 - enter) * travel - leave * travel;
  const opacity = enter * (1 - leave);

  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: "center",
        opacity,
        transform: `translateY(${y}px)`,
        ...style,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

/**
 * The slow push every scene gets.
 *
 * Two to three percent over a scene is below the threshold where anyone
 * notices a zoom and above the one where a frame reads as a still. Without
 * it, a scene whose content has finished animating is literally a static
 * image for several seconds, which is what made the cut feel stiff however
 * good the individual moves were.
 *
 * Scaled from the centre so nothing drifts off an edge, and applied to scene
 * content only - the chrome stays locked to the frame, which is what makes
 * the push read as a camera rather than as a wobble.
 */
export const ScenePush: React.FC<{
  dur: number;
  amount?: number;
  children: React.ReactNode;
}> = ({ dur, amount = 0.025, children }) => {
  const f = useCurrentFrame();
  const scale = interpolate(f, [0, dur], [1, 1 + amount], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: "50% 50%" }}>
      {children}
    </AbsoluteFill>
  );
};

/** A rectangle in a scene's absolute stage: x, y, width, height. */
export type Box = [number, number, number, number];

/**
 * One element becoming another.
 *
 * A hard cut between two shapes makes the audience rebuild the relationship
 * from scratch; a morph hands it to them. So the container travels and
 * resizes continuously while its contents cross-fade inside it - the old
 * content clearing before the new arrives, which is what stops the midpoint
 * reading as two things stacked.
 *
 * Used where the film says one thing becomes another and means it literally:
 * a sentence becoming a vector, a frame becoming a point.
 */
export const MorphBox: React.FC<{
  at: number;
  dur?: number;
  from: Box;
  to: Box;
  radius?: [number, number];
  bg?: [string, string];
  border?: [string, string];
  before: React.ReactNode;
  after: React.ReactNode;
}> = ({
  at,
  dur = 26,
  from,
  to,
  radius = [14, 6],
  bg = ["transparent", "transparent"],
  border = ["transparent", "transparent"],
  before,
  after,
}) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, dur);
  const mix = (a: number, b: number) => a + (b - a) * p;

  // The old content is gone before the new starts, so the box is briefly
  // empty rather than briefly doubled.
  const outOld = 1 - Math.min(1, p / 0.42);
  const inNew = Math.max(0, (p - 0.52) / 0.48);

  return (
    <div
      style={{
        position: "absolute",
        left: mix(from[0], to[0]),
        top: mix(from[1], to[1]),
        width: mix(from[2], to[2]),
        height: mix(from[3], to[3]),
        borderRadius: mix(radius[0], radius[1]),
        background: p < 0.5 ? bg[0] : bg[1],
        border: `1px solid ${p < 0.5 ? border[0] : border[1]}`,
        overflow: "hidden",
      }}
    >
      <div style={{ position: "absolute", inset: 0, opacity: outOld }}>{before}</div>
      <div style={{ position: "absolute", inset: 0, opacity: inNew }}>{after}</div>
    </div>
  );
};
