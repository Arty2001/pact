# perception

Frames in, state transitions out. The high-frequency half of pact.

This process samples frames, embeds them once, scores every eligible skill
against that one embedding, runs a state machine per skill, and posts **only
transitions** to the Engine. It computes several scores a second; the control
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
python -m pact_perception.run \
  --room gym --embed stub --source folder --folder traces/demo --loop-folder \
  --hub http://localhost:8787 --level info
```

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

Measured on a laptop CPU, 4 threads: **217 ms** at 256 px, **561 ms** at
384 px, **1077 ms** at 512 px. A gate needs 0.5 Hz, so CPU is ample; rep
counting wants 4-8 Hz and benefits from more cores or a GPU.

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
pytest -q          # 34 tests; the state machine's arithmetic and the scoring maths
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

## What is not here yet

- **The teacher.** Escalation to `nvidia/Nemotron-3.5-Super-VL` on a stuck
  mid-band or a tight discriminator margin. The state machine already emits
  the `escalate` event; nothing consumes it. It belongs here rather than in
  the Worker because it needs the frames, and frames stay put.
- **Probe refitting from answers.** `probe.refit` currently reports the
  calibration fit, with holdout accuracy stubbed at zero. Fitting a logistic
  probe from teacher and human labels, with real before/after holdout, is the
  next piece.
- **A Dockerfile.** It runs from a checkout today.
