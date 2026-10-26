/**
 * The demo - "running". 0:23 to 0:36, between the problem and the pushups.
 *
 * "Here's the whole thing, running. You give it a goal. It works out what to
 *  watch for, and starts watching. Every camera you've got. Then you go and do
 *  it. It fills itself in. Here's how."
 *
 * The film used to go straight from a problem to an explanation of embeddings,
 * which means a non-technical viewer is told how it works before ever being
 * shown that it works. There was no moment to point at. This is that moment,
 * and it is deliberately the only beat in the film made of the real product
 * rather than of drawings of it.
 *
 * It ends on "Here's how", which is what makes the repeat that follows read as
 * a rewind rather than a mistake: beat 2 types the same sentence this beat has
 * just shown being spoken, and without the handoff line that looks like an
 * edit error.
 *
 * Two cameras are on the wall on purpose. The product runs the whole skill set
 * against every camera independently, with its own state per camera, and one
 * goal settles from whichever room satisfies it - which is a thing nobody
 * guesses from a single feed. The narration names it once, in three words, and
 * the picture carries the rest. Beat 8 is where the capability gets explained;
 * here it is just true in the background.
 *
 * The column on the right fills in as the narration names each thing, in the
 * product's own vocabulary - the same chips, the same mono, the same green.
 * It is the event log, essentially, and it exists so the viewer has somewhere
 * to look that is legible at this size. A screen capture shown whole at
 * 1180px is not readable, so the column reads it out.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, F, R } from "../lib/theme";
import { Rise, Mono, inOut, Eyebrow } from "../lib/prims";
import { FootageSlot } from "../lib/footage";
import { timing } from "../lib/beats";

const t = timing("demo");

/** The page, in a window, so it reads as the real site and not a mock-up. */
const Browser: React.FC<{ at: number; children: React.ReactNode }> = ({ at, children }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 20);
  return (
    <div
      style={{
        width: 1120,
        opacity: p,
        transform: `translateY(${(1 - p) * 16}px) scale(${0.99 + p * 0.01})`,
        borderRadius: R.r2,
        overflow: "hidden",
        background: C.glassTop,
        border: `1px solid ${C.hair}`,
        boxShadow: "0 1px 2px rgba(13,27,38,.05), 0 24px 60px -18px rgba(13,27,38,.28)",
      }}
    >
      <div
        style={{
          height: 44,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 16px",
          borderBottom: `1px solid ${C.hair}`,
        }}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{ width: 11, height: 11, borderRadius: 999, background: C.line }}
          />
        ))}
        <span
          style={{
            marginLeft: 14,
            padding: "5px 16px",
            borderRadius: 999,
            background: C.sunk,
            border: `1px solid ${C.hair}`,
          }}
        >
          <Mono size={16} color={C.dim}>
            pact.lanvar.ai
          </Mono>
        </span>
      </div>
      {children}
    </div>
  );
};

/** One thing the product just did, in the product's own words. */
const Row: React.FC<{
  at: number;
  k: string;
  v: string;
  tone?: "none" | "watch" | "proved";
}> = ({ at, k, v, tone = "none" }) => {
  const f = useCurrentFrame();
  const p = inOut(f, at, 15);
  const kit =
    tone === "proved"
      ? { wash: C.provedWash, edge: C.provedEdge, text: C.provedText, dot: C.proved }
      : tone === "watch"
        ? { wash: C.watchWash, edge: C.watchEdge, text: C.watchText, dot: C.watch }
        : { wash: C.sunk, edge: C.hair, text: C.dim, dot: C.dimmer };
  return (
    <div
      style={{
        opacity: p,
        transform: `translateX(${(1 - p) * -14}px)`,
        padding: "14px 18px",
        borderRadius: R.r,
        background: kit.wash,
        border: `1px solid ${kit.edge}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: kit.dot,
            flexShrink: 0,
          }}
        />
        <Mono size={17} color={kit.text} style={{ fontWeight: 700 }}>
          {k}
        </Mono>
      </div>
      <div
        style={{
          marginTop: 5,
          marginLeft: 18,
          fontFamily: F.ui,
          fontSize: 20,
          color: C.fg,
          fontWeight: 500,
          letterSpacing: -0.4,
          lineHeight: 1.3,
        }}
      >
        {v}
      </div>
    </div>
  );
};

export const SDemo: React.FC = () => {
  const f = useCurrentFrame();

  // "Then you go and do it" - the only point in the film where the screen and
  // the room are on top of each other, which is the whole claim in one frame.
  const room = inOut(f, t("goDoIt"), 18);

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 1560 }}>
        <Eyebrow at={t("wholeThing")}>the whole thing, running</Eyebrow>

        <div style={{ display: "flex", gap: 40, alignItems: "flex-start" }}>
          <div style={{ position: "relative" }}>
            <Browser at={t("wholeThing")}>
              <FootageSlot
                shot={6}
                note="screen capture — pact.lanvar.ai, a real session"
                at={t("wholeThing") + 6}
                w={1120}
                h={630}
                radius={0}
              />
            </Browser>

            {/* The room, over the corner of the screen that is watching it. */}
            {f >= t("goDoIt") - 4 && (
              <div
                style={{
                  position: "absolute",
                  right: 22,
                  bottom: 22,
                  opacity: room,
                  transform: `translateY(${(1 - room) * 18}px) scale(${0.94 + room * 0.06})`,
                  borderRadius: R.r,
                  overflow: "hidden",
                  boxShadow: "0 18px 44px -12px rgba(13,27,38,.5)",
                  border: `2px solid ${C.watch}`,
                }}
              >
                <FootageSlot
                  shot={2}
                  note="the room"
                  at={t("goDoIt")}
                  w={330}
                  h={186}
                  radius={0}
                />
              </div>
            )}
          </div>

          {/* What just happened, read out, because the capture is not legible
              at this size and the viewer needs somewhere to look. */}
          <div style={{ width: 400, display: "flex", flexDirection: "column", gap: 11 }}>
            <Row
              at={t("giveGoal")}
              k="said out loud"
              v="“I want to do 20 pushups every morning”"
              tone="watch"
            />
            <Row at={t("worksOut")} k="3 sub-goals, written for you" v="gate · action · counter" />
            <Row at={t("startsWatching")} k="watching" v="2 Hz, once the gate is open" tone="watch" />
            <Row at={t("everyCamera")} k="2 cameras" v="one goal, either room" tone="watch" />
            <Row at={t("fillsItself")} k="done · 07:21" v="20 / 20 · nobody logged it" tone="proved" />

            <div
              style={{
                marginTop: 6,
                paddingTop: 16,
                borderTop: `1px solid ${C.hair}`,
                opacity: inOut(f, t("fillsItself") + 22, 16),
              }}
            >
              <Mono size={17} color={C.dimmer}>
                1,284 scores → 3 events
              </Mono>
              <div style={{ marginTop: 5 }}>
                <Mono size={17} color={C.dimmer}>
                  everything else stayed quiet
                </Mono>
              </div>
            </div>
          </div>
        </div>

        <Rise at={t("fillsItself") + 10} style={{ marginTop: 20 }} y={18}>
          <div
            style={{
              fontFamily: F.display,
              fontSize: 44,
              fontWeight: 600,
              color: C.fg,
              letterSpacing: -1.3,
            }}
          >
            It fills itself in.
            {f >= t("heresHow") && (
              <span
                style={{
                  color: C.dimmer,
                  fontWeight: 500,
                  opacity: inOut(f, t("heresHow"), 14),
                }}
              >
                {"  "}Here's how.
              </span>
            )}
          </div>
        </Rise>
      </div>
    </AbsoluteFill>
  );
};
