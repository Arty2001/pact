/**
 * Beat 2 - you start with a goal. 0:22 to 0:30.
 *
 * "You start with a goal. Type it, or say it out loud.
 *  I want to do twenty pushups every morning."
 *
 * Eight seconds, four phrases, and nothing else to say. The previous version
 * of this scene struck through a labelled dataset, a training run and a
 * checkpoint - built for a line about not needing any of them that is no
 * longer in the script. Visuals arguing a point the narration never makes
 * read as noise however good they are on their own.
 *
 * So the scene does exactly what the line does: offers two ways in, takes
 * one, and stops. The field is empty for a second and a half before anything
 * is typed, which is the part that sells "this is the whole setup" - there
 * is visibly nothing else on screen to fill in.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, F, T, R } from "../lib/theme";
import { Pane, TypeOn, Mono, inOut } from "../lib/prims";
import { timing } from "../lib/beats";

const t = timing("b2");

/** Scene length, so the handoff to beat 3 starts from the end. */
const LEN = 240;

/** One of the two ways in, lighting as the narration offers it. */
const Route: React.FC<{
  at: number;
  live: boolean;
  label: string;
  children: React.ReactNode;
}> = ({ at, live, label, children }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 16);
  const lit = live ? inOut(f, at, 14) : 0;
  return (
    <div
      style={{
        opacity: p,
        transform: `translateY(${(1 - p) * 12}px)`,
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "14px 20px",
        borderRadius: 999,
        background: lit > 0.5 ? C.watchWash : C.sunk,
        border: `1px solid ${lit > 0.5 ? C.watchEdge : C.hair}`,
      }}
    >
      <span style={{ opacity: 0.45 + lit * 0.55, display: "flex" }}>{children}</span>
      <Mono size={20} color={lit > 0.5 ? C.watchText : C.dimmer}>
        {label}
      </Mono>
    </div>
  );
};

const KeyIcon: React.FC = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <rect x="2" y="6" width="20" height="13" rx="2.5" strokeWidth="1.6" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 15h10" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const MicIcon: React.FC = () => (
  <svg width="26" height="26" viewBox="0 0 20 20" fill="none" stroke="currentColor">
    <rect x="7" y="2.5" width="6" height="9.5" rx="3" strokeWidth="1.6" />
    <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const S2Say: React.FC = () => {
  const f = useCurrentFrame();

  // Beat 3 opens on this same sentence, so the pane recedes toward where the
  // next scene puts it rather than cutting away from it.
  const handoff = inOut(f, LEN - 13, 13);

  const typing = t("sentence");
  const spoken = f >= t("orSayIt") && f < typing;

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div
        style={{
          width: 1160,
          transformOrigin: "50% 50%",
          transform: `scale(${1.2 - 0.07 * handoff}) translateY(${-26 * handoff}px)`,
          opacity: 1 - 0.25 * handoff,
        }}
      >
        <Pane raised pad={40}>
          <Mono size={T.micro} color={C.dimmer}>
            new goal
          </Mono>
          <div style={{ height: 20 }} />

          {/* Empty, and visibly so, until there is a reason for it not to be. */}
          <div
            style={{
              minHeight: 96,
              display: "flex",
              alignItems: "center",
              padding: "0 28px",
              borderRadius: R.r,
              background: C.glassHi,
              border: `1px solid ${spoken ? C.watchEdge : C.line}`,
            }}
          >
            <TypeOn
              text="I want to do 20 pushups every morning"
              at={typing}
              // 37 characters across the 2.1 seconds the line takes to read,
              // so the sentence finishes on the word rather than before it.
              cps={17.6}
              style={{
                fontFamily: F.ui,
                fontSize: 38,
                color: C.fg,
                fontWeight: 500,
                letterSpacing: -0.9,
              }}
            />
          </div>
        </Pane>

        {/* Two ways in, each lighting as it is offered. */}
        <div style={{ marginTop: 34, display: "flex", gap: 20, justifyContent: "center" }}>
          <Route at={t("typeIt")} live={f >= t("typeIt")} label="type it">
            <KeyIcon />
          </Route>
          <Route at={t("orSayIt")} live={spoken} label="or say it out loud">
            <MicIcon />
          </Route>
        </div>
      </div>
    </AbsoluteFill>
  );
};
