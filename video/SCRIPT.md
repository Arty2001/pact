# Pact — launch film

**2:58.6** · 5359 frames @ 30fps · 1920×1080
Ten beats, hard-cut. Narration is a scratch read (`edge-tts`, `en-US-AndrewNeural`, rate `-6%`) and is meant to be replaced.

Everything in the cut is timed to the **measured** phrase boundaries of the recorded lines, extracted with `ffmpeg silencedetect` and stored in [src/lib/beats.ts](src/lib/beats.ts). Re-record a line and that file is the only thing to update.

---

## The script

Say it as written. The pauses are load-bearing — every element on screen is cued off a phrase boundary, so a line read faster or slower than the recorded scratch will drift away from its graphic.

### 1 · the problem — `0:00 → 0:23`

> Everyone has goals.
> The hard part was never deciding. It's keeping track.
> So for the Nebius and NVIDIA hackathon, we built a personal assistant that watches, and keeps you on top of them.
> But sending frames of your day into a frontier model runs hundreds of dollars a day, per camera.
> So Pact is designed to do it for almost nothing.

Five ambitions arrive, each ticking a **decided** column and leaving a **tracked** column empty. Then the cost stream: frames leaving a camera with indices, a `POST /v1/chat/completions` panel, a billed ledger at `+$0.00061`, and the ladder you can check — `$0.00061 × 8 fps = $0.0049/s → ×3600 = $17.54/hr → ×24 = $421/day`. Lands on the mark.

### 2 · running — `0:23 → 0:36`

> Here's the whole thing, running.
> You give it a goal. It works out what to watch for, and starts watching.
> Every camera you've got.
> Then you go and do it.
> It fills itself in.
> Here's how.

**The only beat made of the real product rather than drawings of it.** The film used to go straight from a problem to an explanation of embeddings, which tells a non-technical viewer how it works before ever showing them *that* it works. This is the moment to point at.

A browser window holding the screen capture, and a column beside it that fills in as the narration names each thing — said out loud · 3 sub-goals · watching · 2 cameras · done 20/20. At *"then you go and do it"* the room footage drops into the corner of the screen that is watching it, which is the whole claim in one frame. It closes on `1,284 scores → 3 events · everything else stayed quiet`.

**Two cameras are on the wall on purpose.** The product runs the whole skill set against each camera independently, with its own state per camera, and a goal settles from whichever room satisfies it. The narration names it in three words and the picture carries the rest — beat 9 is where the capability gets explained.

**"Here's how" is load-bearing.** Beat 3 types the same sentence this beat has just shown being spoken. Without the handoff line that reads as an edit error; with it, beat 3 becomes a rewind — you've seen it work, now we go back and go slowly.

### 3 · you say it — `0:36 → 0:44`

> You start with a goal. Type it, or say it out loud.
> I want to do twenty pushups every morning.

An empty field, held empty for a second and a half. Two routes light up on their own words. The sentence types at 17.6 cps so it finishes exactly on "morning", then the pane recedes into beat 3.

### 4 · it breaks it down — `0:44 → 1:16`

> Nemotron breaks it into sub-goals.
> Someone in a room. Someone in a pushup position. Twenty of them, before noon.
> But a camera gives you pixels, and a sub-goal is words. Those don't compare.
> Unless you put them in the same space.
> That's the NVIDIA encoder. It turns the frame into a list of numbers, and turns the sentence into a list of numbers of exactly the same kind.
> Two points on one map.
> And asking whether this is a pushup is just asking how close they are.

The longest beat and the one everything else leans on. Four phases: the plan on a drawn spine (gate / action / counter, plus a `window · before 12:00` chip) → pixels and words side by side with `≠` and *no shared axis* → **C-RADIOv3-B** with two doors, both outputs 1152-d and aligned on the decimal point → the map, where seven other sub-goal sentences are also points, and the frame lands nearest `a pushup position` at `0.284` with `someone in a room` second at `0.163`.

### 5 · fifty cost what one costs — `1:16 → 1:34`

> Every sub-goal becomes a simple comparison between embeddings.
> Watching for fifty things costs barely more than watching for one.
> We also made sure to be smart about which sub-goals are being watched.
> We reuse sub-goals from other goals, so everything stacks into one clean tree of goals and sub-goals.

A ledger in operations, not milliseconds: `1 × encode the frame — a C-RADIOv3-B forward pass`, `50 × score a sub-goal — one dot product, 1152 multiply-adds each`. Total added by fifty sub-goals: **57,600 multiply-adds**. Fifty things cost what one thing costs, plus 57,600 multiply-adds.

No latency figure is shown, deliberately — nobody has timed a forward pass on the machine this gets judged on, and an invented millisecond is the fastest way to lose a technical room. Multiply-adds are exact.

Then the tree **merges on screen**. Three goals declare eight sub-goals; three of them are the same gate, so the duplicates travel to one position and fade as they land, the goals move out to their own column, and the surviving gate keeps three lines to the three goals using it. `declared 8 → scored 6`.

### 6 · most of it never happens — `1:34 → 1:50`

> And that tree has a hierarchy. A still room doesn't even send a frame.
> When you walk in, one sub-goal passes and wakes the one beneath it.
> Everything else stays asleep, never scored.
> It only works as hard as it needs to.

One continuous shot. The tree stays; the new element is a strip marking **every frame the engine actually sent**, generated from the real schedule — `idle_hz 0.5`, then 2 Hz once a gate is open. The marks go from 2 s apart to 0.5 s apart and the density change is visible from across a room. Three of five rows never leave *asleep*.

### 7 · then it counts — `1:50 → 2:04`

> It can also count. One up and down, one entry.
> It won't count a flicker, and it won't count twice.
> And when something doesn't count, it says why.
> Too short, or never confident enough.

The only scene that is a simulation. A confidence curve is authored, and the state machine from `perception/pact_perception/machine.py` is then **run over it** at a counter's real settings — `enter 0.75`, `exit 0.45`, `dwell 0.05 s`, `exit 0.30 s`, `min_cycle 0.70 s`, sampled at **8 Hz**. Every ledger row on the right is that run's output, so the counter cannot disagree with the curve above it.

The 8 Hz matters: one sample interval is 0.125 s, already longer than a counter's 0.05 s dwell, so dwell is never the binding constraint and promotion costs exactly two samples. That is why the curve is drawn with its samples marked — the machine only sees the dots, and a spike that fits between two dots is a thing that did not happen.

What the curve contains, each landing on its own phrase: a clean rep → `#1 counted` · a spike above enter for one sample → `not counted · gone by the next` · two peaks whose trough only falls to `0.73`, never reaching exit → **one** entry, held through · a peak at `0.76` that sags into the band for `0.63 s` → `not counted · never confident enough, needed 0.75`.

### 8 · when it can't tell — `2:04 → 2:24`

> When it can't tell on its own, it doesn't guess.
> Four frames go to Nemotron three point five Super V L.
> When even that's unsure, or no camera could read it, like the weight on a bar, it asks you.
> Your answer becomes a new label.
> The models never change, but the detector on top sharpens.

An escalation drawn as one. Rung 1 is the probe at `0.52`, shown sitting inside the same band beat 6 just established. Rung 2 is the VL teacher on **four** frames — drawn as four frames, `t−3 … t−0`, captioned *the only frames that leave the machine*.

Then the barbell, where no camera can win, and Pact asks one question. The answer becomes label 23 of 23, the probe refits **regularised toward the zero-shot prior**, holdout goes `0.81 → 0.89` and is `kept` — *a refit that doesn't beat it is discarded*. The two model cards sit underneath, stamped **frozen**, and do not move.

### 9 · one system, any goal — `2:24 → 2:44`

> Now this one system can track any type of goal.
> Keep the sink clear. Now the sub-goal firing is the failure.
> And you can add as many video streams as you want. A phone. A screen share. A thirty dollar board.
> We pointed it at our phone recording a whole gym workout, and it logged the entire session, without me putting anything in manually.

The inversion first: one set of sub-goal rows under two verdicts — *as a target → done*, *as a limit → failed*. Nothing underneath them changed. Then three sources arriving on their own words. Then the gym, with the log writing itself: `machine · lat pulldown`, `reps · 8`, `weight · 60 kg · asked`. Ends on **Nobody typed anything in.**

### 10 · the pact — `2:44 → 2:59`

> Every goal is a few things a camera can see, and a rule about them.
> No video is kept. Every goal it settled is still there to explain.
> You already made the promise. Pact is the part that keeps it.

The reduction: three things a camera can see `+` the rule over them (`gate passes → action held ≥ 0.50 s → counter reaches 20 → before 12:00`). Then the two facts that only sound contradictory: `the frame — discarded` (struck through) against `1152 floats — 4.6 KB` and `the verdict — 1 row` — a day of one camera at 0.5 Hz being about 200 MB of numbers and no video at all — beside the full trail behind one settled goal with its timestamps and confidences. Then the mark.

---

## Shots to film

Five clips to film, plus one screen capture. Every slot already renders at its final size and position with its shot number on it, so a frame grab of the current render **is** the brief.

Drop a file into `video/public/footage/` and pass `src` to the matching `FootageSlot` — nothing else about the scene changes. `startFrom` (seconds) trims the head if you overshoot.

| # | What | Needed | Used at |
|---|---|---|---|
| **1** | **Living room, empty → someone walks in.** Locked off on a tripod, wide enough to see a whole body on the floor. **~5 s of genuinely empty room**, then someone walks in and starts doing pushups. Keep rolling. | **20 s** | 640×400 for all of beat 5; again at 342×216 inside the beat-1 cost stream |
| **2** | **Pushups, full set, side on.** Side profile, whole body in frame, floor visible. Several clean reps. Good light, no one else moving in shot. | **15 s** | 520×320, beat 3 |
| **3** | **Dirty sink, filling up.** Static, slightly above, looking down into the basin. Dishes clearly visible and clearly dirty. | **10 s** | 520×320, beat 8 |
| **4** | **Loaded barbell, plates not legible.** Deliberately a shot where you *cannot* read the weight — plates edge-on, or the number face-down. This is the point of the shot. | **12 s** | 620×400, beat 7 |
| **5** | **Gym session, shot on a phone.** Phone propped against something, one machine, someone doing a visible set of about 8 reps. Lat pulldown if you can — the on-screen log says `lat pulldown`, `8 reps`, `60 kg`, so match the machine and the rep count or tell me and I'll change the log. | **15 s** | 620×380, beat 8 |
| **6** | **Screen capture of pact.lanvar.ai — a real session.** 1920×1080, clean browser window, no bookmarks bar, notifications off. See the full brief below. | **the whole session** | 1120×630 in a browser frame, beat 2 |

**For all five:** 1920×1080 or better, 30 fps or higher, landscape, no camera movement, no on-screen text, no music. They are played muted. Shoot more than the duration listed — handles make trimming free.

Shot 1 is the one that matters most: beat 5's entire argument is the room being empty and then not, so the empty stretch at the head has to be real and still.


### Shot 6 in detail — the screen capture

This is the beat that makes the film legible to a non-technical judge, so it's worth doing properly. Record the **whole real session**, however long it takes — I'll cut about 13 seconds out of it. Don't perform it short.

1. Start with the site open and no camera publishing.
2. **Click the mic and say the goal out loud** rather than typing it. The transcript appearing in the assistant bar is a stronger consumer moment than typing, and it's a feature the film otherwise only mentions.
3. Let the goal land and the three sub-goals write themselves into the skills panel.
4. **Add two cameras** — scan the QR with a phone for one, and use a laptop for the other. Two feeds side by side on the wall, with the green ring on whichever one the chart is following, is the multi-camera story told without a word.
5. Leave it running while someone does the pushups in frame.
6. Let it finish and the goal go green.

Worth getting in frame at some point: **the event log**. It's showing real near-miss rows in the engine's own words — `held 659 ms · needed 3.0 s — dropped below exit before dwell` — which is the single most persuasive thing on the page and the live proof of what beat 7 draws.

---

## Rendering

```bash
cd video
npm run studio          # scrub it
npm run preview         # half scale, fast
npm run render          # out/pact.mp4, CRF 16
```

Narration is regenerated from [vo/lines.py](vo/lines.py) with `vo/generate.py`, which retries and then checks each file's duration against its word count — `edge-tts` returns truncated audio often enough that an unguarded run will silently ship a half-second beat.
