"""
Configuration, in one place.

Every knob is read here and nowhere else, so that "what can I change?" has a
single answer and so that a value read from the environment on a server and
from a flag on a laptop cannot drift into two different defaults.

The defaults are deliberately the ones that work with no arguments at all:
replay a folder, embed locally, talk to nothing. Running the pipeline should
not require credentials until the step that actually needs them.
"""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass, field
from typing import Literal

from .log import Level

#: `sfu` pulls straight off the Realtime SFU, the way a viewer does, and is
#: the right default: the video is already flowing there, so a publisher
#: uploading a second copy is both slower and dependent on its tab staying
#: in the foreground. `relay` is that older path, kept for sources that
#: cannot reach the SFU.
SourceKind = Literal["sfu", "folder", "camera", "relay"]
#: `stub` is a fake encoder with no model behind it. It exists so the whole
#: pipeline can be exercised in seconds instead of after a four gigabyte
#: download; it detects nothing and no threshold fitted against it transfers.
EmbedKind = Literal["local", "remote", "stub"]

#: C-RADIOv3-B's preferred input is 512x512 and its siglip2 teacher was
#: distilled at 432. On a GPU the resolution barely matters - measured on a
#: 3050 Ti, 224px is 66ms and 384px is 72ms, because at these sizes the model
#: is launch-bound rather than compute-bound - so there is no reason to run
#: below what the model was built for. On CPU the same step costs 390ms to
#: 1090ms and the trade is real, which is what --resolution is for.
DEFAULT_RESOLUTION = 384

#: Frames per second when nothing is eligible but the gate. A gate is a
#: "is someone in the room" question and does not need to be asked often.
DEFAULT_IDLE_HZ = 0.5

#: Ceiling on the adaptive rate. A bench press rep lasts two to four seconds,
#: so counting one needs several samples inside it; below about 4 Hz reps are
#: not merely miscounted, they are invisible.
DEFAULT_MAX_HZ = 15.0


@dataclass(frozen=True, slots=True)
class Config:
    room: str
    hub: str
    token: str | None

    source: SourceKind
    folder: str | None
    camera_index: int
    loop_folder: bool

    embed: EmbedKind
    embed_url: str | None
    model_version: str
    adaptor: str
    resolution: int
    device: str

    idle_hz: float
    max_hz: float
    motion_threshold: float

    nebius_key: str | None
    teacher_model: str
    store_path: str
    retain_days: float

    level: Level

    #: What a locally driven source is looking at. Only consulted for folder
    #: and camera runs: a relayed or SFU frame carries its own surface,
    #: because the publisher is the one party that knows for certain.
    #:
    #: It belongs up beside `source`, and sits here because a dataclass field
    #: with a default cannot precede one without. A default is worth that:
    #: every existing caller means "camera", which is what they all were
    #: before a screen was something this could watch.
    surface: str = "camera"
    trace_skills: frozenset[str] = field(default_factory=frozenset)

    @property
    def encoder_id(self) -> str:
        """
        Identifies the exact embedding space a weight vector was fitted in.

        A probe fitted against one encoder is meaningless under another, and
        changing the input resolution moves the space too. Recording this on
        every skill is what lets perception refuse to score rather than
        return confident nonsense after a model swap.
        """
        return f"{self.model_version}/{self.adaptor}@{self.resolution}"


def _env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def _env_float(name: str, default: float) -> float:
    raw = _env(name)
    return default if raw is None else float(raw)


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    return default if raw is None else int(raw)


LEVELS = ("trace", "debug", "info", "warn", "error")


def load(argv: list[str] | None = None) -> Config:
    """Flags win over environment, environment wins over defaults."""
    p = argparse.ArgumentParser(
        prog="pact-perception",
        description="Sample frames, embed them, score skills, emit transitions.",
    )
    add = p.add_argument

    add("--room", default=_env("PACT_ROOM", "default"))
    add("--hub", default=_env("PACT_HUB", "http://localhost:8787"))

    add(
        "--source", choices=("sfu", "folder", "camera", "relay"), default=_env("PACT_SOURCE", "sfu")
    )
    add("--folder", default=_env("PACT_FOLDER"))
    add("--camera-index", type=int, default=_env_int("PACT_CAMERA_INDEX", 0))
    add(
        "--loop-folder",
        action="store_true",
        default=_env("PACT_LOOP_FOLDER") == "1",
        help="Replay the folder forever. What a demo wants; a tuning run does not.",
    )

    add(
        "--surface",
        choices=("camera", "screen", "any"),
        default=_env("PACT_SURFACE", "camera"),
        help="What a --source folder or --source camera run is looking at. "
        "Relayed frames carry their own and ignore this.",
    )

    add("--embed", choices=("local", "remote", "stub"), default=_env("PACT_EMBED", "local"))
    add("--embed-url", default=_env("PACT_EMBED_URL"))
    add("--model-version", default=_env("PACT_MODEL", "c-radio_v3-b"))
    add("--adaptor", default=_env("PACT_ADAPTOR", "siglip2"))
    add(
        "--device",
        choices=("auto", "cuda", "cpu"),
        default=_env("PACT_DEVICE", "auto"),
        help="auto picks a GPU when one is present. Name one to rule the other out.",
    )
    add("--resolution", type=int, default=_env_int("PACT_RESOLUTION", DEFAULT_RESOLUTION))

    add("--idle-hz", type=float, default=_env_float("PACT_IDLE_HZ", DEFAULT_IDLE_HZ))
    add("--max-hz", type=float, default=_env_float("PACT_MAX_HZ", DEFAULT_MAX_HZ))
    add("--motion-threshold", type=float, default=_env_float("PACT_MOTION", 0.012))
    add("--store", default=_env("PACT_STORE", "traces/perception.db"))
    add("--retain-days", type=float, default=_env_float("PACT_RETAIN_DAYS", 7.0))

    add("--level", choices=LEVELS, default=_env("PACT_LEVEL", "info"))
    add(
        "--trace-skill",
        action="append",
        default=[],
        help="Turn on the per-frame score firehose for ONE skill. Repeatable.",
    )

    a = p.parse_args(argv)

    if a.resolution % 16 != 0:
        p.error(f"--resolution must be a multiple of 16 (the patch size); got {a.resolution}")
    if a.source == "folder" and not a.folder:
        p.error("--source folder needs --folder")
    if a.embed == "remote" and not a.embed_url:
        p.error("--embed remote needs --embed-url")

    return Config(
        room=a.room,
        hub=str(a.hub).rstrip("/"),
        token=_env("PACT_TOKEN"),
        source=a.source,
        folder=a.folder,
        camera_index=a.camera_index,
        loop_folder=a.loop_folder,
        surface=a.surface,
        embed=a.embed,
        embed_url=a.embed_url,
        model_version=a.model_version,
        adaptor=a.adaptor,
        resolution=a.resolution,
        device=a.device,
        idle_hz=a.idle_hz,
        max_hz=a.max_hz,
        motion_threshold=a.motion_threshold,
        nebius_key=_env("NEBIUS_API_KEY"),
        teacher_model=_env("PACT_TEACHER_MODEL", "nvidia/Nemotron-3.5-Super-VL") or "",
        store_path=a.store,
        retain_days=a.retain_days,
        level=a.level,
        trace_skills=frozenset(a.trace_skill),
    )
