# Pact — goals, proved by camera

You say you'll do something. The cameras confirm you did.

Type a goal in plain English. Nemotron compiles it into **skills** — 1152
floats each, running on one shared embedding. A state machine turns thousands
of scores an hour into one event. Every question you answer becomes a label,
and the skills sharpen. Two models do all the perception; four of the seven
stages use no model at all.

Built for the **Nebius × NVIDIA hackathon**. Deployed at
[pact.lanvar.ai](https://pact.lanvar.ai).

---

## The idea in one screen

```
  cameras ──▶ one frame every 2 s
      │
      ▼
  L0 MOTION GATE      empty room? stop here.          no model · free
      │               runs in the BROWSER, so an
      │               empty room sends no bytes
      ▼
  EMBED               frame → 1152 numbers            nvidia/C-RADIOv3-B
      │                                               Nebius · 98M params
      ▼
  SKILLS              N dot products on that one      no model · 4.6 KB each
      │               embedding. 50 skills ≈ µs
      ▼
  STATE MACHINES      enter · dwell · exit · cooldown no model · ~90 lines
      │               7,200 scores/hour → 1 event
      ▼
  GOAL RULES          did the sub-goals fire, in      no model · SQL
      │               the right window?
      ▼
  ESCALATE            4 frames + a longer prompt,     Nemotron-3.5-Super-VL
      │               only when stuck. ~0.1%          $0.0006 per call
      ▼
  ASK YOU             one question, pre-filled        you
                      the answer becomes a label ──┐
                                                    │
        the probe refits ◀──────────────────────────┘
```

The models never change. C-RADIO is frozen and Nemotron is frozen. What
improves is the 1152-float vector sitting on top — which is why "it gets
better" is a thing we built rather than a thing we hope for.

---

## Does this actually save anything?

Measured, not estimated.

| | 0.5 fps (every 2 s) | 8 fps (rep counting) |
|---|---|---|
| Every frame to the VLM, per camera | $26/day | $421/day |
| C-RADIO on one L40S, **flat** | $37/day | $37/day |
| Teacher on 0.1% of frames | $0.02/day | $0.28/day |

Read the first column honestly: **at one camera sampling every two seconds,
self-hosting the encoder loses.** Break-even is 1.4 cameras. If that were the
whole story this architecture would be theatre.

Two things make it real. Frame rate: the moment you want to count reps you
need 8 fps, and the naive path goes to $12,600 per camera per month while the
GPU line does not move. And headroom: one L40S embeds roughly 150 frames a
second, so that same $37 carries about 300 cameras at 0.5 fps.

The claim is about the **shape** of the cost curve. Naive is linear in frames
× cameras × goals. This is flat in all three until the GPU saturates, because
a skill is 1152 multiply-adds against an embedding already paid for. Adding
goal fifty costs nothing measurable.

And for the demo it costs less still. Measured end to end on a laptop CPU,
C-RADIO runs a frame in **1164 ms at 256 px** - about 0.9 fps, against the
0.5 Hz a gate samples at. So gates and actions need no GPU at all. Rep
counting at 8 Hz does, which is the honest limit of the cheap path.

(The backbone alone is 217 ms at that resolution. The difference is the
adaptor head and a loaded host, and the end-to-end number is the one worth
planning against.)

---

## What works

| | Status |
|---|---|
| Browser camera / screen → wall | Working |
| Screen share judged against a goal | Working, see [below](#watching-a-screen-rather-than-a-room) |
| QR / one-time code pairing | Working |
| Live device registry over WebSocket | Working |
| RTSP / RTMP / MJPEG / ESP32 ingest | Working, via [the bridge](bridge/) |
| Motion gate in the browser | Working |
| Frame relay → perception | Working |
| C-RADIO embedding, zero-shot skills from text | Working, semantically verified |
| State machines, near-miss diagnostics | Working, 54 tests |
| Goal ledger, instances, settlement | Working |
| Planner: a sentence → skills + a goal rule | Working, reuses existing skills |
| Teacher: escalation to Nemotron VL | Working |
| Probe refitting with before/after holdout | Working |
| Questions with pre-filled answers | Working |

**Not built:** no auth beyond claim codes, no recording, no cloud
transcoding, audio is not published. See the bottom of this file.

---

## Architecture

Three processes, and the boundary between two of them is the whole point.

```
  ┌─ phone / laptop camera ─┐
  │   screen share          │
  └───────────┬─────────────┘
              │  WebRTC (media)          ┌──────── the wall, in any browser
              ▼                          │
      Cloudflare Realtime SFU ───────────┘
              ▲
              │ SDP only, never media
  ┌───────────┴──────────────────────────────────────────────┐
  │  Worker  (src/)                      pact.lanvar.ai      │
  │    /api/sfu/*     proxies SDP, holds the app secret      │
  │    /api/hub/*     Hub DO: what is live right now         │
  │    /api/engine/*  Engine DO: goals, skills, the ledger   │
  │    /api/frames/*  a sampled JPEG, on its way to B        │
  └───────────┬──────────────────────────────────────────────┘
              │  ONE WebSocket. frames down, transitions up.
              │  Perception dials out: no inbound port, no TLS, no CORS.
              ▼
  ┌──────────────────────────────────────────────────────────┐
  │  perception/  (Python)        laptop, or a cheap VM      │
  │    sample → gate → embed → score → state machine         │
  │    escalate → Nemotron VL → label → refit                │
  └──────────────────────────────────────────────────────────┘
```

### The boundary that matters

Perception computes several scores a second per skill. **The control plane
never sees one.** Only state transitions cross the wire — that is the "7,200
scores an hour becomes one event" property expressed as a process split
rather than a convention. If a score *could* be posted, eventually it would
be, and the ledger would drown.

So the design's `observations` table does not live in the Engine. Scores and
the embeddings a label is fitted against stay in perception's own SQLite,
next to the frames. The schema is one logical model split across two stores,
and the Engine keeps the half that is cheap to hold forever.

### Perception dials out

It holds one WebSocket to the Engine, exactly as [`bridge/`](bridge/) does to
the Hub. No inbound port, no public address, no TLS to terminate, no CORS. The
identical process runs on a laptop behind a router and on a cloud VM with
nothing changed but `--hub`. It also sidesteps decoding WebRTC in Python,
which was the riskiest part of the original plan.

### Two Durable Objects, deliberately

The **Hub** keeps no storage at all: "what is live" is derived from the set of
open publisher sockets, so socket-open and device-live are the same fact
recorded once. Nothing to expire, nothing to reconcile.

The **Engine** is the opposite — its whole job is the part that must outlive
every socket. Folding them together would cost the Hub the property that
makes it simple, so they stay apart.

### Watching a screen rather than a room

A publisher can share a screen instead of a camera, and a goal can be about
what is on it: *"study Python for an hour"* rather than *"brush my teeth"*.
The plumbing is identical — same tap, same relay, same state machines — but
four of the assumptions underneath it are about rooms, and each one fails
quietly rather than loudly on a screen.

**Every skill declares a surface.** `camera`, `screen`, or `any`, and a skill
only ever scores frames from its own. The reason is not that a screen skill
scored against a bathroom camera returns a wrong answer — it returns a low
one, which looks like the thing simply not happening. It is that scoring also
*calibrates*: `bias` and `temperature` are fitted from whatever frames a skill
has seen, so mixing surfaces means a sink detector learns its idea of an
ordinary frame partly from screenshots of a code editor, and drifts in a way
nothing reports. `any` is the default, so every skill written before this
existed behaves exactly as it did.

**A still screen is not an empty room.** The motion gate rests on an
assumption that is true of a room and false of a screen: that stillness means
nothing is happening. Reading a document for twenty minutes is motionless and
is exactly the behaviour a goal wants to credit, so gating it would make the
system go quiet during the thing it is watching. A screen is therefore never
hard-gated. It falls back to a five-second heartbeat in the publisher, which
is a slowdown rather than a blindfold — roughly a fifth the cost of an active
screen instead of zero cost and zero information.

**The cheap layer cannot read, and the split is the design rather than a
limitation.** C-RADIO recognises the *look* of a screen — an editor, a
spreadsheet, a video player, a terminal — and cannot tell one file from
another. So the gate names a recognisable kind of screen and the child names
the specific thing, and when the child is undecided the teacher, which can
read, settles it. Its verdict becomes a label like any other, so the question
gets cheaper the more often it is asked. The planner is told this explicitly,
because a screen gate written as *"VS Code with main.py open"* is a detector
that can never fire.

**Escalation needs legible frames.** 640px in the browser and 512px at the
teacher are right for a camera and quietly wrong for a screen: at that size a
1920px desktop's body text is a grey smear, so the one component that could
tell Python from JavaScript answers UNSURE forever — and that reads as a model
that cannot do the task rather than as a picture that never held the answer.
Screens upload at 1280px and reach the teacher at 1024px. A teacher call on a
screen costs roughly four times the input tokens of one on a camera, which is
affordable only because escalation is rare.

Screen actions also get different timings, for a reason the camera defaults
get backwards. A camera action has a 60-second cooldown so one trip to the
bathroom is not recorded as three. An accumulating screen goal sums sessions
rather than counting them, so a cooldown charges a minute of lost credit for
every glance at a message, and a choppy hour scores as half of one. Screen
actions get no cooldown and a 20-second exit, long enough to ride out a
switched tab.

### The motion gate runs in the browser

L0 is the only level in the design that skips real work. Every skill below it
is a dot product against an embedding already paid for, so skipping *skills*
saves microseconds while skipping the *frame* saves all of it. Running that
test in the publisher means an empty room does not merely avoid inference, it
never sends the bytes. Nothing is cheaper than a request that was not made.

The gated percentage is shown on the publisher page, because it is the number
that tells you whether a device is costing anything.

---

## What we got wrong about C-RADIO, so you don't have to

Four things, each confirmed against the released checkpoint rather than the
model card.

| Assumption | Reality |
|---|---|
| The adaptor is `siglip2-g` | It is **`siglip2`**. This checkpoint's teachers are clip, siglip2, dino_v2, sam. `siglip2-g` belongs to the H and v4 variants; asking for it raises. |
| Embeddings are 768-d | They are **1152**. 768 is the backbone's per-token width; the summary is 2304 and the adaptor projects to 1152, which is also what the text tower emits. |
| `AutoModel` can serve it | It **cannot do text at all**. That repo ships empty `adaptor_configs` and no adaptor tensors. The adaptor weights exist only inside the `.pth.tar` reached through `torch.hub`. |
| One model does image and text | The adaptor wraps `google/siglip2-so400m-patch16-naflex` and keeps its text tower — a separate 3.5 GB download. |

### The thresholds in the design cannot work

This one matters most. `sigmoid(w·e)` with no scale or offset puts **every**
score between 0.475 and 0.599, so an enter threshold of 0.75 is not badly
tuned — it is unreachable, and the system would report nothing forever while
looking perfectly healthy. Borrowing SigLIP's own learned scale fails the
other way: the 0.45-to-0.75 band collapses into 0.013 of cosine, narrower
than frame-to-frame noise, so the hysteresis debounces nothing.

So every skill carries its own two numbers, fitted from its own room:

```
score = sigmoid((w · e - bias) / temperature)
```

`bias` sits at a high quantile of what the room looks like; `temperature` is
set so the hysteresis band spans a stated number of standard deviations of
that background. Needs no labels. **A skill does not score until it is
calibrated** — before that every score is ~0.5 regardless of the frame, so
any threshold fires immediately or never.

---

## Nebius and NVIDIA

Three NVIDIA open models, each doing the job it is actually good at.

| | Model | Where | Called |
|---|---|---|---|
| The 24/7 encoder | `nvidia/C-RADIOv3-B` + siglip2 | Nebius AI Cloud (or a laptop) | every sampled frame |
| The planner | `nvidia/nemotron-3-super-120b-a12b` | Nebius Token Factory | once per goal written |
| The assistant | `nvidia/nemotron-3-super-120b-a12b` | Nebius Token Factory | once per thing said to it |
| The teacher | `nvidia/Nemotron-3.5-Super-VL` | Nebius Token Factory | only when a moment is ambiguous |

**C-RADIO is the vision encoder *inside* Nemotron 3.5 Super VL.** That is the
whole reason this works rather than a coincidence worth mentioning: the edge
index and the cloud teacher share one visual representation, so the teacher's
verdict is a label in the same space the skill's own vector lives in. A
verdict from a model with a different encoder would be an opinion the skill
could not learn from.

### Where the split pays

The encoder runs on everything and the reasoning models run on almost
nothing. A camera at 8 Hz is 28,800 frames an hour through C-RADIO; the
teacher sees four of them, and only when the state machine genuinely cannot
decide. Token Factory is what makes that affordable - a 120B model priced per
token is free at a tenth of a percent of frames and would be unthinkable at
all of them.

It also made the label loop possible at all. Nemotron 3.5 Super VL can look
at the frames a person just complained about and *write* candidate labels for
them, which closes a gap nothing else could: an embedding cannot be turned
back into words, so when a skill stops matching there is no way to ask the
vector what it should have said. Something that can see has to write it, and
then the recorded embeddings choose between the candidates by separation over
spread. Generating and choosing are different jobs and neither model can do
the other one.

### Nebius AI Cloud: where the encoder runs

The encoder is the only part of this that can be moved. Everything else in
perception is stateful - a WebRTC subscription, per-room calibration, state
machines with dwell timers - and belongs beside the cameras. The encoder is a
pure function: a frame in, 1152 numbers out, nothing remembered between
calls.

So it runs in two places, and both are real:

| | where | how |
|---|---|---|
| In the perception process | a Nebius Compute VM | `--embed local`, the default |
| As its own service | a **Nebius Serverless Endpoint** | `--embed-url https://...` |

The same image serves both. `ENTRYPOINT` is `python -m` and the module is the
command, so `pact_perception.run` is the watcher and `pact_perception.serve`
is the encoder behind HTTP - which is also what a serverless endpoint needs,
since those let you set the arguments and not the entrypoint.

The endpoint is live and answers with what it is, because a vector is only
meaningful against a weight vector from the same encoder and being wrong
there is silent - the numbers look fine and mean nothing:

```
GET /health
{"ok":true,"encoderId":"c-radio_v3-b/siglip2@384","dim":1152,"device":"cpu","threads":16}
```

**What the split costs, measured.** Inside one region the hop is a couple of
milliseconds; the rest is JPEG encode and serialising 1152 floats back. About
twelve milliseconds a frame on top of the encode. Across regions it is ninety,
which is the version not to build. The demo runs `--embed local` because
twelve milliseconds times eight frames a second is still twelve milliseconds
nobody needs - but the endpoint exists, works, and is the honest answer to
"could the encoder be serverless".

**The endpoint does not scale to zero, so the control plane does it.** Nebius
bills an endpoint for wall-clock time while it runs, whatever the traffic, and
nothing there stops it on its own. The Hub already knows when a camera
arrives, because a publisher socket opening *is* a camera arriving: the Engine
starts the machine on the first publisher and stops it ten minutes after the
last one leaves. Ten minutes because a tab refresh is not an empty house and a
cold start is a minute of somebody watching a blank console.

That same loop is what makes preemptible usable. A preempted endpoint goes to
`STOPPED` and Nebius does not bring it back - it stays down until something
starts it. Something does: the next camera to publish.

**Two traps, both of which cost us an evening.**

A stop/start through the Compute API **does not preserve local disk**, and the
store is where every embedding and label the skills have learned lives. `/data`
must be a network disk or they forget everything the first time the control
plane saves money.

And `os.cpu_count()` reports the machine, not the share of it you were given.
A sixteen-core endpoint encoded a frame in **208 ms**; a four-thread laptop
does it in **195**. In a container allocated sixteen cores on a host with a
hundred and ninety-two, torch starts a hundred and ninety-two threads and they
contend rather than work. More hardware, less throughput, nothing in the logs.
The cgroup quota is asked first now, because that is what actually limits the
process and it is invisible to both `cpu_count` and the affinity mask -
and `/health` reports the thread count, because the only thing worse than this
bug is this bug with no way to see it from outside.


### Tavily: a target the system did not invent

Pact's claim is that it does not take your word for whether something
happened. That sits oddly beside a target it made up. "Do some squats every
day" names no number, so one gets looked up and the goal keeps the URL - a
person can then disagree with the guidance rather than with Pact. Only when
the sentence has no number in it: "ten squats" means ten, and a cited URL is
kept only if it was actually among the results, because a model asked for a
citation will sometimes produce the shape of a reference rather than a
reference.

Two traps worth knowing. Every model id in Nebius's own documentation
examples is decommissioned, including the one in their quickstart, so treat
the live catalogue as the only trustworthy source. And Nemotron spends on the
order of a hundred tokens reasoning before answering, counted against the
same budget — too low a `max_tokens` returns a **200 with empty content**,
which looks exactly like a network failure. The floor here is 512 and
`reasoning_content` is read separately.

---

## Setup

```bash
npm install
npx wrangler secret put REALTIME_APP_ID       # dash.cloudflare.com → Realtime
npx wrangler secret put REALTIME_APP_SECRET
npx wrangler secret put NEBIUS_API_KEY        # tokenfactory.nebius.com
```

For local dev, copy `.dev.vars.example` to `.dev.vars` and fill it in.

```bash
npm run dev        # localhost:8787
npm run deploy     # pact.lanvar.ai
npm run typecheck
```

Then the perception service, in a second terminal:

```bash
cd perception
uv venv --python 3.12 && uv pip install -e ".[dev]"

# No model, no download: watch the whole pipeline work in seconds
python -m pact_perception.run --room gym --embed stub \
  --source folder --folder traces/demo --loop-folder --hub http://localhost:8787

# The real encoder, against a webcam
uv pip install -e ".[dev,encoder,camera]"
python -m pact_perception.run --room office --embed local --source camera \
  --hub http://localhost:8787
```

`--embed stub` is a fake encoder with no model behind it. Frames flow, the
gate gates, calibration fits and the state machine runs — but it understands
nothing, and no threshold fitted against it transfers. It exists so the wiring
can be exercised without a four gigabyte download.

Open `/goals` to add a goal. See [perception/README.md](perception/README.md)
for tuning, the log contract, and the measured latencies.

---

## Files

```
src/
  index.ts          Router. /api/{hub,engine,frames,sfu}/*
  hub.ts            Hub DO: the live registry, derived from open sockets
  sfu.ts            Realtime SFU client
  log.ts            The structured logger. The only console.log in the Worker.
  goals/
    engine.ts       Engine DO: the ledger, the frame relay, the alarm
    schema.ts       The SQL, in one place
    evaluate.ts     Goal rules. Pure: transitions in, verdict out.
    planner.ts      Nemotron tool-calling: a sentence → skills + a goal
    nebius.ts       Token Factory client. The max_tokens trap lives here.
    types.ts        Every row and wire shape

public/
  index.html        The wall      goals.html    Goals, instances, questions
  join.html         The publisher
  js/
    sfu-client.js   publish() and subscribe(). The WebRTC core.
    frame-tap.js    The motion gate and the frame sampler, in the browser
    wall.js  join.js  goals.js

perception/         Python. Own pyproject. See its README.
  make_demo_frames.py  Generates the synthetic recording the quickstart replays
  pact_perception/
    run.py          The loop. The only file that knows the order.
    sources.py      folder | camera | relay, behind one interface
    gate.py         L0 motion gate      embed.py   C-RADIO client
    skills.py       Dot products, softmax, calibration
    machine.py      The pure state machine. No I/O.
    teacher.py      Nemotron VL escalation
    probe.py        Logistic refit with before/after holdout
    store.py        Local SQLite: scores, embeddings, labels
    ledger.py       The Engine WebSocket
  tests/            54 tests. The arithmetic, mutation-checked.

bridge/             Node. RTSP/RTMP/MJPEG → the wall. Own README.
m5stackchan/        ESP32 camera firmware.
```

No build step and no framework on the frontend — modules the browser loads
directly, which keeps the interesting parts readable.

---

## Media never passes through the Worker

Workers can't carry WebRTC: no UDP, no long-lived sockets. The Worker only
brokers the SDP handshake, because that step needs the SFU app secret and the
browser can't be trusted with it. Video goes browser ↔ Cloudflare edge
directly.

One honest amendment. **Sampled frames do pass through the Worker** — one
JPEG every two seconds per camera, about 25 KB/s, relayed to perception and
never stored. That is a trickle rather than a stream, and the WebRTC path to
the wall is untouched, but it is a real change to a property this file used
to claim without qualification.

### The publish/subscribe asymmetry

The direction of the SDP offer flips depending on what you're doing, which is
the one genuinely confusing part of the SFU API:

- **Publishing** — you offer, the SFU answers. One round trip.
- **Subscribing** — you name the tracks, the SFU offers, you answer via
  `/renegotiate`. Two round trips.

Both paths have a race worth knowing about: `setRemoteDescription` can fire
ICE and `track` events synchronously, so listeners must be attached *before*
it is called. See the comments in
[`public/js/sfu-client.js`](public/js/sfu-client.js).

---

## Debuggability is the product

When pact says "you did your workout", we have to be able to show why. One
JSON object per line, one logger per process, a closed set of event names so
a typo is a compile error rather than a line that never matches a grep.

Every line carries a `trace_id`, minted when a gate opens and retired when it
closes, so one grep reconstructs one whole session:

```bash
curl -s localhost:8787/api/engine/explain/<trace_id>
```

The single most useful line is `skill.rejected`, and it distinguishes two
near-misses that want **opposite** fixes:

```json
{"ev":"skill.rejected","reason":"dropped below exit before dwell",
 "peak":0.51,"held_ms":306,"needed_ms":1000,"needed_conf":0.0}

{"ev":"skill.rejected","reason":"held past dwell but sagged below enter",
 "peak":0.51,"held_ms":1210,"needed_ms":1000,"needed_conf":0.44}
```

The first ran out of time: shorten `dwell_s`. The second held plenty long but
the score had sagged out of reach by the time dwell elapsed: lower
`enter_conf`, or get more labels. The peak cannot tell them apart — crossing
`enter_conf` is how a candidacy *starts*, so the peak always clears it.

A system that only logs successes cannot answer "why didn't that count?",
which is the question anyone actually asks.

---

## What this deliberately is not

- **No real auth.** Claim codes stop a stranger who finds the join URL from
  publishing, and that is all they do. Anyone with the wall URL can watch.
  Put Cloudflare Access in front of it before pointing it at anything private.
- **No recording.** Frames are relayed and never stored. Perception keeps
  embeddings, not images, on a week's retention.
- **A shared screen is not redacted.** Screen frames go through the Worker
  like any other, at a higher resolution so the teacher can read them, and
  whatever else is on your screen goes with them — other windows, a
  notification, an open inbox. On escalation they are sent to Nebius. Nothing
  is stored at either end, but a screen carries far more than a gym camera
  does and the same "never stored" promise is a much weaker one here. There
  is no per-window capture and no redaction; share a single window rather
  than a whole desktop if that matters.
- **No cloud transcoding.** The SFU forwards bytes untouched.
- **Audio is not published.** A wall of simultaneous audio is unusable.

### Known limits, stated plainly

**Zero-shot is weakest exactly where it hurts most.** The first time you do
something genuinely new in front of a camera that has never seen it, you get
zero-shot quality, and if that is weak for your room the session may be
missed entirely. Running loose at the start is a mitigation, not a cure —
which is why manual entry has to stay first class.

**The refit needs more labels than the design claims.** "Five beats
zero-shot, sixteen makes it solid" is optimistic; measured on synthetic data
the fit first wins at around forty. Real labels are not random draws in 1152
dimensions so the true number is likely better, but it is not five.

**The calibration background is biased by the gate.** Still frames never
reach the encoder, so the distribution a skill calibrates against is "frames
interesting enough to embed", not the room at rest. A screen skill escapes
this one — screens are not hard-gated — and walks into a worse version of it:
if you code all day, coding *is* your screen's background, so a "code for an
hour" skill calibrates its bias against the very thing it is meant to detect
and may never cross its own threshold. Goals about what you do unusually work
better here than goals about what you do constantly.

**Thresholds must bracket the real distribution.** If `exit_conf` sits below
the median score, sessions open and never close. Read the numbers off a
recorded trace before trusting any of them.
