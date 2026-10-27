/**
 * Sound effects: few, quiet, and each tied to something already on screen.
 * The voice sits at -20 LUFS; every effect here is kept well under it.
 * (Scene 6 places its own ticks, from its state-machine log.)
 */
import React from "react";
import { Audio, Sequence, staticFile } from "remotion";
import { at } from "./beats";
import { SHRINK, GROW } from "./presenter";

type Cut = Record<"s1" | "s2" | "s3" | "s4" | "s5" | "s6" | "s7" | "s8" | "s9", readonly [number, number]>;

export const Sfx: React.FC<{ cut: Cut }> = ({ cut }) => {
  const list: { f: number; src: string; vol: number }[] = [
    { f: SHRINK - 4, src: "whoosh_soft", vol: 0.16 },                             // you shrink into the bubble
    { f: cut.s1[0] + at("b1", "almostNothing") - 10, src: "chime", vol: 0.1 },  // the logo first appears
    { f: cut.s3[0] + at("b3", "twoPoints") + 44, src: "tick", vol: 0.14 },      // the map finds its closest match
    { f: cut.s4[0] + at("b4", "oneTree") - 6, src: "whoosh", vol: 0.13 },       // the tree merges
    { f: cut.s7[0] + at("b7", "becomesLabel") + 42, src: "chime", vol: 0.1 },   // refit kept
    { f: cut.s8[0] + at("b8", "nobodyTyped"), src: "chime", vol: 0.1 },         // nobody typed anything in
    { f: GROW - 4, src: "whoosh_soft", vol: 0.14 },                               // you grow back to full frame
    { f: cut.s9[0] + at("b9", "keepsIt"), src: "reveal", vol: 0.26 },           // the mark
  ];
  return (
    <>
      {list.map((s, i) => (
        <Sequence key={i} from={s.f} layout="none">
          <Audio src={staticFile(`sfx/${s.src}.wav`)} volume={s.vol} />
        </Sequence>
      ))}
    </>
  );
};
