# perception

Frames in, state transitions out. The high-frequency half of pact.

This process samples frames, embeds each one once per *view* any eligible
skill asks for — almost always exactly one — scores every eligible skill
against its own view's embedding, runs a state machine per skill, and posts
**only transitions** to the Engine. It computes several scores a second; the control
plane never sees one. That boundary is the whole "7,200 scores an hour becomes
one event" property, expressed as a process split rather than a convention.

```
 source ──▶ motion gate ──▶ embed ──▶ N dot products ──▶ state machine ──▶ Engine
 folder      no model        C-RADIO   no model            no model         transitions
 camera      frame diff      1152-d    ~microseconds       4 states         only
 relay
```

It **dials out**. One WebSocket to the Engine carries frames down and
transitions up, so there is no inbound port, no public address, no TLS and no
CORS. The identical process runs on a laptop behind a router and on a cloud VM
with nothing changed but `--hub`.

---

## Install

```bash
cd perception
uv venv --python 3.12
uv pip install -e ".[dev]"            # state machine, scoring, tests
uv pip install -e ".[dev,encoder]"    # ...plus torch and the real encoder
uv pip install -e ".[camera]"         # ...plus OpenCV, for a local webcam
```

`encoder` is split out on purpose: the state machine and the scoring maths are
the parts most worth testing, and neither needs a 550 MB checkpoint present to
be tested.

---

## Run it

Start the Worker first, in the repo root:

```bash
npm run dev          # localhost:8787
```

Then, with **no model and no download**, to watch the whole pipeline work:

```bash
python make_demo_frames.py        # traces/ is gitignored, so generate them
python -m pact_perception.run \
  --room gym --embed stub --source folder --folder traces/demo --loop-folder \
  --hub http://localhost:8787 --level info
```

The frames are generated rather than committed, because shipping footage is
how a repository ends up carrying pictures of someone's bathroom. Same seed,
same frames, same scores, which is the property the tuning workflow rests on.

Against a real webcam and the real encoder:

```bash
python -m pact_perception.run \
  --room office --embed local --source camera \
  --hub http://localhost:8787 --resolution 384
```

Taking frames from a phone that opened `/join` on the wall:

```bash
python -m pact_perception.run --room <device-name> --embed local --source relay \
  --hub https://pact.lanvar.ai
```

### `--surface`

Whether a locally driven run is looking at a room or at a shared screen.
A skill only scores frames from its own surface, and a motionless screen is
never gated — see "Watching a screen rather than a room" in the root README
for why both of those matter.

Only `--source folder` and `--source camera` consult this. A `relay` or `sfu`
frame carries its own surface, because the publisher that chose a camera or a
screen is the only party that knows for certain, and a flag that disagreed
with it would silently mis-scope every skill.

```bash
# replaying recorded screenshots rather than recorded footage
python -m pact_perception.run --source folder --folder traces/desk \
  --surface screen --embed local --hub http://localhost:8787
```

### Views, and the one thing the stub cannot show

Each skill also declares a **view**: `full` for the frame as it arrived, or
`layout` for the frame averaged down to a coarse grid and back, which keeps
the structure of a screen and destroys what is on it. It is not a flag — it
comes down with the registry, because it belongs to the skill rather than to
the run. The planner sets `layout` on a screen gate, since what makes a *kind*
of screen recognisable is its shape and the content inside it is noise that
changes every few seconds. See the root README for the measurements.

A frame is encoded once per **distinct** view wanted on it. When every
eligible skill agrees — the normal case, and always the case on a camera —
that is the single encode it has always been. Two encodes are paid only when
two skills on one surface genuinely ask different questions of the same
pixels, and `embed.done` names the view so you can see which happened:

```bash
python make_demo_frames.py --scene screen --out traces/screen
python -m pact_perception.run --room desk --surface screen \
  --source folder --folder traces/screen --embed stub \
  --store traces/viewtest.db --hub http://localhost:8787 --level debug
```

**`--embed stub` cannot demonstrate the benefit, only the wiring.** The stub
builds its vector from an 8×8 grid of the frame, which is coarser than the
16×16 `layout_only` averages to, so it has already discarded the content
before the transform could — it is in effect a layout-only encoder, and a
`full` skill and a `layout` skill score within 0.0005 of each other under it.
Use it to confirm two views are encoded, stored and calibrated separately.
For the thirtyfold collapse itself, `--embed local`.

One store takes one writer. A run against a store a live process is already
recording into is refused at startup, which is also where the one-time
migration that adds the view column happens — hence `--store` above.

### About `--embed stub`

A fake encoder with no model behind it. It is deterministic and it responds to
the image, so frames flow, the gate gates, calibration fits, scores move and
the state machine runs — but **it understands nothing**. A skill labelled
"a person at a sink" will not detect a person at a sink, and no threshold
fitted against it transfers to the real encoder. It exists so the wiring can
be exercised in seconds rather than after a four gigabyte download.

---

## The encoder, and four things that are not what the docs say

Confirmed against the released checkpoint rather than the model card.

| | |
|---|---|
| The adaptor is `siglip2`, not `siglip2-g` | This checkpoint's teachers are clip, siglip2, dino_v2, sam. `siglip2-g` belongs to the H and v4 variants and asking for it raises. |
| Vectors are **1152-d**, not 768 | 768 is the backbone's per-token width. The summary is 2304; the siglip2 adaptor projects to 1152, which is also what the text tower emits. |
| HuggingFace cannot do text | That repo ships empty `adaptor_configs` and no adaptor tensors. The adaptor weights exist only inside the `.pth.tar` reached through `torch.hub`. |
| `trust_repo=True` is mandatory | Without it `torch.hub` blocks on a stdin prompt a container will never answer, and the failure reads like a hang rather than a question. |

Text is embedded **once per skill, ever**, at creation. The image path runs
forever. The first adaptor construction also pulls the SigLIP2 text tower,
about 3.5 GB.

### Measured CPU latency

Two numbers, because the difference between them matters and quoting only
the first would flatter the system.

| | 256 px | 384 px | 512 px |
|---|---|---|---|
| Backbone alone, 4 threads, idle machine | 217 ms | 561 ms | 1077 ms |
| **End to end**, incl. the adaptor head, machine under load | **1164 ms** | **2486 ms** | - |

The second row is what a frame actually costs. The gap is the siglip2
adaptor head plus a host with 2 GiB free, and it is the row to plan against.

So about **0.9 fps at 256 px on a loaded laptop**. A gate samples at 0.5 Hz,
so CPU has headroom there and an action at 2 Hz is borderline. **Rep counting
at 8 Hz is out of reach on CPU** - that one wants a GPU, or a recorded trace
replayed for the demo.

---

## Thresholds are fitted, not chosen

The design's 0.75 / 0.45 are placeholders, and taken literally they do not
work. `sigmoid(w·e)` with no scale or offset puts **every** score between
0.475 and 0.599, so an enter threshold of 0.75 is not badly tuned, it is
unreachable — the system would report nothing forever while looking healthy.
Borrowing SigLIP's own learned scale fails the other way: the 0.45-to-0.75
band collapses into 0.013 of cosine, narrower than frame-to-frame noise, so
the hysteresis debounces nothing.

So each skill carries its own two numbers:

```
score = sigmoid((w · e - bias) / temperature)
```

`bias` sits at a high quantile of what this room looks like, and `temperature`
is set so the 0.45-to-0.75 band spans a stated number of standard deviations
of that background. Both are fitted from the first 60 scored frames, need no
labels, and are pushed up to the Engine so a restart does not throw them away.

**A skill does not score until it is calibrated.** Before that, every score is
about 0.5 regardless of the frame, so any threshold under 0.5 fires on the
first frame and any over it never fires. Either way the event is an artefact
of the identity transform. You will see `detail=calibrating` first.

Two consequences worth knowing when tuning:

The calibration background is made of **frames that passed the motion gate**,
not of the room at rest. Still frames never reach the encoder, so the
distribution you are fitting against is "frames interesting enough to embed".

Your thresholds have to **bracket the real distribution**. If `exit_conf` sits
below the median score, sessions open and never close. Read the numbers off a
recorded trace with `--trace-skill <key>` and set them from what you see.

---

## Tuning against a recording

This is why live and replay go through one interface. Record once, then replay
the same frames as often as you like:

```bash
# the per-frame score firehose, for one skill only
python -m pact_perception.run --source folder --folder traces/monday \
  --embed local --level info --trace-skill applied_to_face \
  | grep '"ev":"skill.score"'
```

Re-performing an action to test a threshold does not work, and a replay path
that differed from the live one would not transfer. The state machine is a
pure function of `(state, score, now)` for the same reason: `pytest` replays a
score trace through it with different numbers and no camera involved.

```bash
pytest -q          # 159 tests: the machine, the scoring maths, the probe, escalation
ruff check .
```

---

## Reading the log

One JSON object per line. Every line carries `ts`, `level`, `ev`, `trace_id`
and `room`. A `trace_id` is minted when a gate opens and retired when it
closes, so one grep reconstructs one whole session:

```bash
... | grep 'c9351e'
```

The single most useful line is `skill.rejected`, and it distinguishes two
near-misses that want opposite fixes:

```json
{"ev":"skill.rejected","reason":"dropped below exit before dwell",
 "peak":0.51,"held_ms":306,"needed_ms":1000,"needed_conf":0.0}

{"ev":"skill.rejected","reason":"held past dwell but sagged below enter",
 "peak":0.51,"held_ms":1210,"needed_ms":1000,"needed_conf":0.44}
```

The first ran out of time: shorten `dwell_s`. The second held plenty long but
the score had sagged out of reach by the time dwell elapsed: lower
`enter_conf`, or improve the probe. The peak cannot tell them apart —
crossing `enter_conf` is how a candidacy starts, so the peak always clears it.

`skill.score` is the firehose and is off by default. It is enabled **per
skill** with `--trace-skill`, and that opt-in deliberately ignores the global
level, because needing `--level trace` to see one skill's scores would bury
them under every other skill's.

---

## The teacher, and the loop that makes it improve

A skill held between its thresholds for `escalate_after_s` escalates: four
recent frames go to `nvidia/Nemotron-3.5-Super-VL` with a longer prompt, and
its verdict does two separate jobs. It settles the occurrence, so the
transition is recorded `verdict_by=vlm` rather than lost. And it becomes a
label, which is the only reason the same ambiguity costs less next time.

Measured against the live model: about 1.3 to 2.0 seconds and **$0.0006 a
call**, which at a tenth of a percent of frames is a rounding error.

An `UNSURE` verdict is a real answer, not a failure — the frames genuinely do
not show it, so the question belongs to a person. A failed *call* is
different and is logged as an error.

Without `NEBIUS_API_KEY` everything still runs; escalation is skipped and
mid-band cases go unresolved rather than crashing. A missing credential
should degrade, not stop.

### What the refit actually delivers

Every label refits the probe, and the result is reported with holdout
accuracy measured on frames the fit never saw. **A refit that does not beat
zero-shot is reported and discarded**, not shipped — otherwise the number
would be decoration rather than evidence.

The design claims five labels beats zero-shot and sixteen makes it solid.
Measured on synthetic data where the labels follow a direction well off the
sentence, that is optimistic: five and sixteen are both still refused, and
the fit first wins at around forty, taking the cosine between the probe and
the true direction from 0.24 to 0.62. Three hundred reaches 0.73. Real labels
are not random draws in 1152 dimensions, so the true number is probably
better than this, but it is not five.

```json
{"ev":"probe.refit","skill":"applied_to_face","n_examples":42,
 "holdout_before":0.67,"holdout_after":0.75,"accepted":true}
```

---

## What is not here yet

- **Discriminator refitting.** A `discriminator` skill calibrates and scores,
  and the margin test escalates correctly, but the multi-class probe is not
  refitted from labels the way a binary one is. Every label trains every
  class in principle, which roughly triples the value of each answer; that is
  not implemented.
- **Human answers as labels.** A metric question settles its instance, but
  the answer is not yet joined back to a frame embedding the way a teacher
  verdict is. Only the teacher currently teaches.

---

## Deploying it

Perception takes **no inbound connections** — it dials out to the Engine over
one WebSocket. So there is no port to publish, no TLS to terminate and no
ingress to configure, and "runs on a laptop" and "runs on a cloud VM" are the
same deployment rather than two.

```bash
docker build -t pact-perception .
docker run -d --name pact-gym \
  -e PACT_ROOM=gym \
  -e PACT_HUB=https://pact.lanvar.ai \
  -e PACT_SOURCE=relay \
  -e NEBIUS_API_KEY=$NEBIUS_API_KEY \
  -v pact-gym-data:/data \
  pact-perception
```

The weights are baked in at build time, not fetched at boot. A container that
downloads four gigabytes on every start fails on a flaky network, and on
Nebius Serverless AI the container disk is deleted with the endpoint, so a
runtime download would happen every single time.

### On Nebius

Two products with confusingly similar names, and only one of them can do this.

**Token Factory cannot host a custom model.** Its dedicated-endpoint API takes
a `model_name` from a fixed catalogue — there is no image field and no HF-repo
field — and custom weights is a gated beta limited to fine-tunes of text LLMs.
A 98M vision encoder needing `trust_remote_code` is not reachable that way.

**Nebius Serverless AI Endpoints** takes a container image and returns a
managed HTTPS URL in about five minutes. `trust_remote_code` is a non-issue
inside your own container.

```bash
nebius ai endpoint create --name pact-perception \
  --image <registry>/pact-perception:v1 \
  --platform gpu-l40s-a --preset 1gpu-8vcpu-32gb \
  --auth token --token "$AUTH_TOKEN" --subnet-id "$SUBNET_ID"
```

But **"serverless" is a misnomer here**: there is no scale-to-zero and no
autoscaling, billing is plain Compute VM pricing, and the smallest GPU is a
whole L40S at about $1.55/hour. Left running that is roughly $37 a day.

Which is why the measured CPU latencies above matter. Perception needs no
inbound connectivity, so it does not need the endpoint product at all — a
plain CPU instance with no public IP is about a sixteenth of the price and
comfortably fast enough at the rate a gate samples. Reach for the GPU when
the frame rate genuinely demands it, and script it up and down rather than
leaving it on.

Either way the environment is the same, which was the point:

```
PACT_ROOM        which room's frames this process handles
PACT_HUB         the Worker's base URL
PACT_SOURCE      relay | camera | folder
PACT_EMBED       local | remote | stub
PACT_RESOLUTION  multiple of 16; cost scales with the square
PACT_STORE       where the local SQLite lives
NEBIUS_API_KEY   optional. Without it, escalation is skipped rather than failing.
```
