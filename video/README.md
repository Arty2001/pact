# video

The 2:52 launch film, built in Remotion. Nine scenes, hard-cut, 1920×1080 at 30fps.

Everything is a pure function of the frame number. No CSS transitions, no
timers: Remotion renders frame N by mounting the tree at frame N, so anything
keeping its own clock renders as a still on every frame and silently drops out
of the file. That failure never shows in the studio, only in the render.

```bash
npm install
npm run studio      # scrub, edit, see changes live
npm run render      # out/pact.mp4
npm run preview     # half scale, for a fast look
```

---

## The presenter cut

The film now carries Sai's recorded read instead of the scratch voiceover.

- `public/me.mp4` is the on-camera take (compressed to fit under GitHub's 100 MB
  limit) and `public/voice.flac` is its audio, denoised and levelled to -20 LUFS.
  `src/lib/presenter.tsx` plays them as one continuous take: full frame for the
  opening line, a corner bubble through the graphics, full frame again for the close.
- `src/lib/beats.ts` holds the phrase times measured from that read, so every
  scene is cued to Sai's words. Scene lengths in `Video.tsx` come from the same read.
- Footage in `public/footage/` is pre-cut so frame 0 of each file is frame 0 of
  its scene: the walk-in lands on "when you walk in", the pushups stop on the frame
  the encoder is shown, and the lat pulldown log counts the clip's 12 real reps.
  Shot 3 (the sink) is a still photo, `public/footage/sink.jpg`, pushed in slowly.
- `src/lib/sfx.tsx` places a handful of quiet sound effects from `public/sfx/`.
- `npx remotion still Thumb out/thumbnail.png` renders the thumbnail.

The `public/vo/*.mp3` scratch track is no longer used by the cut.

---

## Dropping your footage in

Every shot in the video is a `FootageSlot`. Until a clip exists it draws a
labelled placeholder carrying its shot number and direction, at exactly the
size and position the real clip will occupy — so a frame grab of the animatic
doubles as the shot brief.

1. Put the file in `public/footage/`.
2. Pass `src` to that slot.

```tsx
<FootageSlot shot={7} note="dirty sink, filling up" at={30} w={460} h={250}
             src="sink.mp4" startFrom={90} />
```

Nothing else about the scene changes. `startFrom` is in frames.

| Shot | Scene | What | Where |
|---|---|---|---|
| 4 | S1, S5 | Living room, locked off — empty, then you walk in | Your front room |
| 5 | S4, S6 | Pushups, full set, same frame, no cuts | Your front room |
| 7 | S8 | Dirty sink filling up over an evening | Your kitchen |
| 8 | S8 | Bins by the door; a pill box on a counter | Home |
| 9 | S8 | Gym — a machine, a set, the weight pin | Gym |

Shoot locked off and shoot long. A fixed frame is what the product actually
is, it means no 2D tracking when the overlay goes on, and twenty minutes of a
sink cuts down to four good seconds. Shoot the empty room first: scenes 1 and
5 only read if the audience sees nothing happening before something does.

---

## The design system

`src/lib/theme.ts` is lifted from `public/pact.css` rather than invented, so
the film and the product are one identity. Three rules carry over and they are
the whole motion language:

- **Green is a signal, never a surface.** `#76B900` marks the new idea, the
  winning number and the call to action. Nothing else.
- **Hue carries one meaning.** Green proved, Nebius violet watching, amber
  pending, red breached. Nothing in the film uses hue decoratively.
- **Surfaces are glass** over a fixed two-bloom ground.

One rule exists only here: anything describing the old way is drawn in
neutrals, so the first hue in the video arrives with the product.

---

## Structure

| File | What |
|---|---|
| `src/Video.tsx` | The cut. `CUT` holds every scene's start and duration |
| `src/lib/theme.ts` | Colours, type scale, easing, seconds-to-frames |
| `src/lib/prims.tsx` | `TypeOn` `WordsOn` `CountUp` `Rise` `Chip` `SkillRow` `DrawArrow` `Pane` |
| `src/lib/footage.tsx` | `FootageSlot`, `WatchFrame` |
| `src/scenes/S1…S9` | One file per beat, each with its timings at the top |

Scene durations come from the script's word counts at the pace each beat is
marked for, so the timeline *is* the script. Change a beat's length here and
in the script table together, or they drift.

---

## Voiceover

There is a **scratch track** in `public/vo/b1.mp3` … `b9.mp3`, one file per
beat, synthesised so the cut can be judged on whether the ideas land in the
time they are given. It is meant to be replaced by a real read.

The text lives in `vo/lines.py`. Regenerate after editing it:

```bash
uvx --with edge-tts python vo/generate.py
```

Spellings there are tuned for the synthesiser, not the page — "three point
five", "seven fourteen". A model name read as a decimal is the fastest way to
make a technical video sound wrong.

### Replacing it with your voice

Record one file per beat and keep the names. Then measure them and put the
numbers into `VO_S` in `Video.tsx`:

```bash
for B in b1 b2 b3 b4 b5 b6 b7 b8 b9; do
  npx remotion ffprobe -v error -show_entries format=duration \
    -of csv=p=0 public/vo/$B.mp3
done
```

Scene lengths are derived from `VO_S` plus a lead-in and a tail, floored at
whatever each animation needs to finish and be read — so correcting those nine
numbers refits the whole cut. **Do not hard-code the composition length**;
`Root.tsx` takes it from `TOTAL`.

One file per beat rather than one long track, deliberately: a line can be
re-recorded without re-cutting the film, and each scene's length is fitted to
its own line.

### Where the timings came from

Scene internals are keyed to the recorded read, not to the word count. Beat 5
has the gate passing two seconds in because that is when the voice says "you
walk in"; beat 8 holds its cost cards until after the voice has stopped, so
the claim and its proof arrive in that order. If you re-record at a different
pace, scrub each scene and move the constants at the top of its file.

---

## Rendering notes

Remotion's bundled Chrome Headless Shell could not be downloaded on this
machine, so `remotion.config.ts` points at the installed Chrome. Override with
`PACT_CHROME`, or delete that call once `npx remotion browser ensure` works on
your network.

CRF is 16 — visually lossless for flat vector fields, which band badly at the
default. YouTube re-encodes anyway, so upload the highest quality you have.

All Remotion packages are pinned to one exact version. A minor skew between
the core and the native compositor fails the render with an unhelpful message.
