/**
 * Beat 6 - then it counts. 1:36 to 1:50.
 *
 * "It can also count. One up and down, one entry. It won't count a flicker,
 *  and it won't count twice. And when something doesn't count, it says why.
 *  Too short, or never confident enough."
 *
 * The one scene that is a simulation rather than a storyboard.
 *
 * A confidence curve is authored, and then the state machine from
 * perception/pact_perception/machine.py is RUN over it at module load, at a
 * counter's real settings: enter 0.75, exit 0.45, dwell 0.05 s, exit 0.30 s,
 * min_cycle 0.70 s, sampled at 8 Hz. Every row of the ledger is that run's
 * output, so the counter cannot disagree with the curve above it.
 *
 * Sampling at 8 Hz rather than per video frame is the detail that makes the
 * rejections honest. One sample interval is 0.125 s, already longer than a
 * counter's 0.05 s dwell, so dwell is never the binding constraint -
 * promotion costs exactly two samples, one to open candidacy and one that has
 * to still be above enter. Which is why the curve is drawn with its samples
 * marked: the machine only ever sees the dots, and a spike that fits between
 * two dots is a thing that did not happen.
 *
 * An earlier version of this scene used a 0.50 s dwell and rejected a flicker
 * for being shorter than it. That is not what a counter does - a counter's
 * dwell is deliberately below one sample interval, because a measured 400 ms
 * dwell rejected half of all real squats - and the near-miss it showed, a peak
 * that never reached enter at all, produces no event in the real machine
 * because nothing ever enters candidacy. Both are fixed here.
 *
 * What the curve is built to contain, each landing on its own phrase:
 *
 *   a clean rep                          #1, counted
 *   a spike above enter for one sample   not counted, gone by the next
 *   two peaks whose trough only falls
 *     to 0.73, never reaching exit       ONE entry, held through
 *   a peak at 0.76 that sags into the
 *     band and stays there               not counted, never back to 0.75
 *
 * The third is the whole reason there are two thresholds instead of one, and
 * it is shown rather than asserted: the dip carries the number that decided it.
 */

import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import { C, R, FPS } from "../lib/theme";
import { Mono, inOut, Eyebrow, Chip, Fit } from "../lib/prims";
import { timing } from "../lib/beats";

const t = timing("b6");

const LEN_F = 377;
const LEN_S = LEN_F / FPS;

/* -------------------------------------------- a counter's own numbers, real */

const ENTER = 0.75;
const EXIT = 0.45;
const DWELL_S = 0.05;
const EXIT_S = 0.3;
const MIN_CYCLE_S = 0.7;
const HZ = 8;
const DT = 1 / HZ;
const FLOOR = 0.16;

/* ---------------------------------------------------------------- the curve */

type Bump = { t: number; peak: number; sig: number };

const BUMPS: Bump[] = [
  { t: 2.31, peak: 0.93, sig: 0.343 }, // one up and down
  { t: 4.125, peak: 0.82, sig: 0.085 }, // a flicker, narrower than a sample gap
  { t: 5.6, peak: 0.92, sig: 0.4 }, // and the pair that must not count twice:
  { t: 6.3, peak: 0.9, sig: 0.4 }, //   their trough never reaches exit
  { t: 7.99, peak: 0.94, sig: 0.343 },
  { t: 10.27, peak: 0.76, sig: 0.42 }, // crosses once, then sags and stays
];

const conf = (time: number): number =>
  BUMPS.reduce(
    (m, b) =>
      Math.max(m, FLOOR + (b.peak - FLOOR) * Math.exp(-((time - b.t) ** 2) / (2 * b.sig ** 2))),
    FLOOR,
  );

/* ------------------------------------ the state machine, run over the curve */

type Entry =
  | { f: number; kind: "count"; n: number; peak: number }
  | { f: number; kind: "rejected"; held: number; samples: number; peak: number };

const { log, trough } = (() => {
  const log: Entry[] = [];
  let phase: "idle" | "candidate" | "active" = "idle";
  let since = 0;
  let peak = 0;
  let below: number | null = null;
  let count = 0;
  let last: number | null = null;

  // The interior dip, which only counts as a dip if the curve climbs back
  // over enter afterwards. The final descent out of a rep is not a trough.
  let dip = 1;
  let trough = { v: 1, t: 0 };

  for (let s = 0; s * DT < LEN_S; s++) {
    const time = s * DT;
    const c = conf(time);

    if (phase === "idle") {
      if (c >= ENTER) {
        phase = "candidate";
        since = time;
        peak = c;
      } else {
        peak = 0;
      }
      continue;
    }

    if (phase === "candidate") {
      const held = time - since;
      if (c < EXIT) {
        log.push({
          f: Math.round(time * FPS),
          kind: "rejected",
          held,
          samples: Math.round(held / DT) + 1,
          peak,
        });
        phase = "idle";
        peak = 0;
        continue;
      }
      peak = Math.max(peak, c);
      // Promotion needs dwell AND the score still over enter at that moment,
      // and not inside the refractory window since the last count.
      const tooSoon = last !== null && time - last < MIN_CYCLE_S;
      if (held >= DWELL_S && c >= ENTER && !tooSoon) {
        count += 1;
        phase = "active";
        since = time;
        below = null;
        last = time;
        dip = 1;
        log.push({ f: Math.round(time * FPS), kind: "count", n: count, peak });
      }
      continue;
    }

    // Active. A dip changes nothing; only exit_s under exit closes the session.
    if (c >= EXIT) {
      below = null;
      if (c >= ENTER) {
        if (dip < 1 && dip < trough.v) trough = { v: dip, t: time };
        dip = 1;
      } else if (c < dip) {
        dip = c;
      }
    } else if (below === null) {
      below = time;
    } else if (time - below >= EXIT_S) {
      phase = "idle";
      peak = 0;
      below = null;
      dip = 1;
    }
  }
  return { log, trough };
})();

/* ------------------------------------------------------------------- chart */

const W = 1000;
const H = 400;
const PAD = 24;
const x = (time: number) => (time / LEN_S) * W;
const y = (c: number) => H - PAD - c * (H - PAD * 2);

const SAMPLES = Array.from({ length: Math.ceil(LEN_S / DT) }, (_, i) => i * DT);

const Chart: React.FC<{ at: number }> = ({ at }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 16);
  const nowS = Math.min(f, LEN_F) / FPS;

  // Only the part that has happened is drawn. A curve already complete at
  // frame zero is a chart; one that arrives is a reading.
  const pts: string[] = [];
  for (let i = 0; i <= nowS; i += 1 / FPS) pts.push(`${x(i).toFixed(1)},${y(conf(i)).toFixed(1)}`);

  const c = conf(nowS);

  return (
    <div style={{ width: W, opacity: p }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 18, marginBottom: 10 }}>
        <Mono size={18} color={C.dimmer}>
          confidence · someone in a pushup position
        </Mono>
        <span style={{ marginLeft: "auto", display: "flex", gap: 20 }}>
          <Mono size={18} color={C.dimmer}>
            now <span style={{ color: C.fg, fontWeight: 700 }}>{c.toFixed(2)}</span>
          </Mono>
          <Mono size={18} color={c >= ENTER ? C.provedText : C.dimmer}>
            {c >= ENTER ? "above enter" : c >= EXIT ? "in the band" : "below exit"}
          </Mono>
        </span>
      </div>

      {/* The settings this run used. Every one is a counter's real default,
          and the dwell sitting under one sample interval is the reason
          promotion costs two samples rather than one. */}
      <div style={{ display: "flex", gap: 26, marginTop: 2, marginBottom: 4, opacity: inOut(f, at + 20, 16) }}>
        {[
          ["sampled at", `${HZ} Hz`],
          ["dwell", `${DWELL_S.toFixed(2)} s`],
          ["exit after", `${EXIT_S.toFixed(2)} s`],
          ["min cycle", `${MIN_CYCLE_S.toFixed(2)} s`],
        ].map(([k, v]) => (
          <span key={k} style={{ display: "flex", gap: 8 }}>
            <Mono size={16} color={C.dimmer}>
              {k}
            </Mono>
            <Mono size={16} color={C.dim} style={{ fontWeight: 700 }}>
              {v}
            </Mono>
          </span>
        ))}
      </div>

      <div style={{ position: "relative", width: W, height: H, margin: "86px 0" }}>
        <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
          <rect width={W} height={H} rx={R.r} fill={C.glassHi} stroke={C.hair} />

          {/* The band between the two thresholds: the region where nothing
              changes, which is the entire reason there are two of them. */}
          <rect
            x="0"
            y={y(ENTER)}
            width={W}
            height={y(EXIT) - y(ENTER)}
            fill="rgba(16,36,54,.028)"
          />
          <line
            x1="0"
            x2={W}
            y1={y(ENTER)}
            y2={y(ENTER)}
            stroke={C.proved}
            strokeWidth="1.4"
            strokeDasharray="7 6"
            opacity="0.75"
          />
          <line
            x1="0"
            x2={W}
            y1={y(EXIT)}
            y2={y(EXIT)}
            stroke={C.pending}
            strokeWidth="1.4"
            strokeDasharray="7 6"
            opacity="0.75"
          />

          <polyline
            points={pts.join(" ")}
            fill="none"
            stroke={C.watch}
            strokeWidth="2.4"
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity="0.5"
          />

          {/* What the machine actually sees. Eight a second, and nothing in
              between, which is why the spike at 4.4 s is not a rep. */}
          {SAMPLES.map((s) =>
            s <= nowS ? (
              <circle
                key={s}
                cx={x(s)}
                cy={y(conf(s))}
                r="2.6"
                fill={conf(s) >= ENTER ? C.proved : C.watch}
                opacity={conf(s) >= ENTER ? 1 : 0.7}
              />
            ) : null,
          )}

          {/* Where it resolved something. */}
          {log.map((e) =>
            f >= e.f ? (
              <line
                key={e.kind + e.f}
                x1={x(e.f / FPS)}
                x2={x(e.f / FPS)}
                y1={PAD}
                y2={H - PAD}
                stroke={e.kind === "count" ? C.proved : C.bad}
                strokeWidth="1.2"
                strokeDasharray="3 4"
                opacity={inOut(f, e.f, 10) * 0.5}
              />
            ) : null,
          )}

          <circle cx={x(nowS)} cy={y(c)} r="6" fill={C.watch} />
          <circle
            cx={x(nowS)}
            cy={y(c)}
            r={6 + 5 * Math.abs(Math.sin(f / 14))}
            fill="none"
            stroke={C.watch}
            strokeWidth="1.4"
            opacity="0.4"
          />
        </svg>

        <div style={{ position: "absolute", left: 12, top: y(ENTER) - 24 }}>
          <Mono size={16} color={C.provedText}>
            enter 0.75
          </Mono>
        </div>
        <div style={{ position: "absolute", left: 12, top: y(EXIT) + 6 }}>
          <Mono size={16} color={C.pendingText}>
            exit 0.45
          </Mono>
        </div>

        {/* "It won't count a flicker." */}
        <Callout
          at={t("notAFlicker")}
          left={x(4.375)}
          top={-78}
          leader={78 + y(0.82) - 10}
          tone="bad"
          lines={["one sample above enter", "gone by the next"]}
        />

        {/* "and it won't count twice" - the dip the machine refused to treat
            as the end of a rep, with the number that decided it. */}
        <Callout
          at={t("notTwice") + 24}
          left={x(trough.t)}
          top={H + 22}
          leader={-(H + 22 - y(trough.v) - 10)}
          tone="proved"
          lines={[`dipped to ${trough.v.toFixed(2)}`, "never reached exit · same rep"]}
        />

        {/* "or never confident enough" */}
        <Callout
          at={t("neverConfident")}
          left={x(10.5)}
          top={-78}
          leader={78 + y(0.76) - 10}
          tone="bad"
          lines={["peaked at 0.76, then sagged", "never back over enter"]}
        />
      </div>

    </div>
  );
};

const Callout: React.FC<{
  at: number;
  left: number;
  top: number;
  lines: string[];
  tone: "bad" | "proved";
  /** Dashed connector to the point this is about. Positive draws downward. */
  leader?: number;
}> = ({ at, left, top, lines, tone, leader }) => {
  const f = useCurrentFrame();
  if (f < at) return null;
  const p = inOut(f, at, 14);
  const col = tone === "bad" ? C.badText : C.provedText;
  const edge = tone === "bad" ? C.badEdge : C.provedEdge;
  const wash = tone === "bad" ? C.badWash : C.provedWash;
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        transform: `translate(-50%, 0) translateY(${(1 - p) * 8}px)`,
        opacity: p,
        padding: "8px 13px",
        borderRadius: R.r,
        // Opaque, not a wash: these sit over a plot and a translucent label
        // with a curve showing through it is unreadable at any size.
        background: C.glassTop,
        boxShadow: `inset 0 0 0 1px ${edge}, inset 3px 0 0 ${col}`,
        whiteSpace: "nowrap",
      }}
    >
      {leader !== undefined && (
        <span
          style={{
            position: "absolute",
            left: "50%",
            top: leader > 0 ? "100%" : undefined,
            bottom: leader > 0 ? undefined : "100%",
            height: Math.abs(leader) * p,
            borderLeft: `1.5px dashed ${edge}`,
          }}
        />
      )}
      {lines.map((l, i) => (
        <div key={l} style={{ marginTop: i ? 2 : 0 }}>
          <Mono size={16} color={i ? C.dimmer : col} style={{ fontWeight: i ? 400 : 700 }}>
            {l}
          </Mono>
        </div>
      ))}
    </div>
  );
};

/* ------------------------------------------------------------------ ledger */

const stamp = (fr: number) => {
  const sec = 14 * 60 + 8 + Math.round(fr / FPS);
  const mm = String(Math.floor(sec / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  return `07:${mm}:${ss}`;
};

const Ledger: React.FC = () => {
  const f = useCurrentFrame();
  const shown = log.filter((e) => f >= e.f);
  const counted = shown.filter((e) => e.kind === "count").length;

  return (
    <div style={{ width: 470 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 14, marginBottom: 18 }}>
        <Mono size={64} color={C.provedText} style={{ fontWeight: 700, lineHeight: 1 }}>
          {counted}
        </Mono>
        <Mono size={26} color={C.dimmer} style={{ paddingBottom: 6 }}>
          / 20 reps
        </Mono>
        <span style={{ marginLeft: "auto", paddingBottom: 8 }}>
          <Chip label="counter" tone="watch" mono size={17} />
        </span>
      </div>

      {/* Grows downward like a log, newest last. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {shown.slice(-7).map((e) => {
          const p = inOut(f, e.f, 12);
          const ok = e.kind === "count";
          return (
            <div
              key={e.kind + e.f}
              style={{
                opacity: p,
                transform: `translateX(${(1 - p) * -12}px)`,
                padding: "11px 15px",
                borderRadius: R.r,
                background: ok ? C.provedWash : C.sunk,
                border: `1px solid ${ok ? C.provedEdge : C.hair}`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <Mono
                  size={18}
                  color={ok ? C.provedText : C.dimmer}
                  style={{ fontWeight: 700, width: 34 }}
                >
                  {ok ? `#${e.n}` : "—"}
                </Mono>
                <Mono size={17} color={C.dimmer}>
                  {stamp(e.f)}
                </Mono>
                <span style={{ marginLeft: "auto" }}>
                  <Mono size={17} color={ok ? C.provedText : C.badText} style={{ fontWeight: 600 }}>
                    {ok ? "counted" : "not counted"}
                  </Mono>
                </span>
              </div>
              <div style={{ marginTop: 4, marginLeft: 46 }}>
                <Mono size={16} color={C.dimmer}>
                  {e.kind === "count"
                    ? `peak ${e.peak.toFixed(2)} · two samples over enter`
                    : e.samples <= 2
                      ? `too short · one sample over enter`
                      : `never confident enough · ${e.held.toFixed(2)} s in the band, needed 0.75`}
                </Mono>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const S6Counts: React.FC = () => {
  const f = useCurrentFrame();

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <Fit s={1.08}>
      <div style={{ width: 1560 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <Eyebrow at={t("canCount")}>one up and down, one entry</Eyebrow>
          <div style={{ opacity: inOut(f, t("doesntCount"), 16), marginBottom: 22 }}>
            <Mono size={18} color={C.dimmer}>
              and when something doesn't count, it says why
            </Mono>
          </div>
        </div>

        <div style={{ display: "flex", gap: 50, alignItems: "flex-start" }}>
          <Chart at={t("canCount")} />
          <Ledger />
        </div>
      </div>
      </Fit>
      {/* A quiet tick for every count, a muted blip for every rejection:
          the same machine output the ledger is written from. */}
      {log.map((e, i) => (
        <Sequence key={`sfx${i}`} from={e.f} layout="none">
          <Audio src={staticFile(e.kind === "count" ? "sfx/tick.wav" : "sfx/nope.wav")} volume={e.kind === "count" ? 0.16 : 0.12} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
