"""
Structured logging. One JSON object per line, one logger per process.

Debuggability here IS the product. When pact says "you did your workout",
the only way to show why is one line per decision, in one place, that a
machine can read back. Two rules make that work and both are enforced here
rather than left to discipline:

Event names are a closed set. `Event` is a literal union, so a typo is a
type error and `grep '"ev":"skill.rejected"'` finds every rejection rather
than three spellings of one.

Rejections are logged as loudly as acceptances. A system that only records
successes cannot answer "why didn't that count?", which is the question
anyone actually asks. `skill.rejected` carries the peak score and how long
it was held, which is enough to tell a near-miss from a non-event without
re-running anything.

`trace_id` is minted when a gate opens and retired when it closes, so
`grep trace_id=...` reconstructs one whole session from the first sampled
frame to the settled instance. Outside a gate span a source still carries
one, because a line with no trace is a line you cannot place.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from datetime import UTC, datetime
from typing import Any, Literal

Level = Literal["trace", "debug", "info", "warn", "error"]

#: The closed vocabulary. Adding a variant means adding it here first.
Event = Literal[
    "frame.sampled",
    "frame.gated",
    "embed.done",
    "skill.score",
    "skill.transition",
    "skill.rejected",
    "discriminator.margin",
    "teacher.call",
    "question.asked",
    "question.answered",
    "goal.evaluate",
    "goal.settle",
    "probe.refit",
    # Lifecycle. Not detections, but a log you cannot start or stop reading
    # is not an operable log.
    "service.start",
    "service.stop",
    "service.error",
]

_ORDER: dict[Level, int] = {"trace": 10, "debug": 20, "info": 30, "warn": 40, "error": 50}

#: `skill.score` is the firehose: one line per skill per frame. It is the
#: only event that is off by default, and it is enabled per skill rather than
#: globally so that turning it on for one skill does not bury the others.
_FIREHOSE: frozenset[Event] = frozenset({"skill.score"})


def _now_iso() -> str:
    """ISO-8601 with milliseconds. Sorts lexically, which is why it is text."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Logger:
    """
    A logger bound to one room.

    Holds the current `trace_id` because every line needs one and threading it
    through every call site by hand is how lines end up without one.
    """

    def __init__(
        self,
        room: str,
        level: Level = "info",
        trace_skills: frozenset[str] = frozenset(),
        stream: Any = None,
    ) -> None:
        self.room = room
        self.level = level
        self.trace_skills = trace_skills
        self._stream = stream if stream is not None else sys.stdout
        self._trace_id = new_trace_id()
        self._lock = threading.Lock()

    # ------------------------------------------------------------- trace id

    @property
    def trace_id(self) -> str:
        return self._trace_id

    def rotate(self) -> str:
        """
        Start a new span. Called when a gate opens and again when it closes,
        so a session's lines share an id and the quiet between sessions does
        not get filed under the session that just ended.
        """
        self._trace_id = new_trace_id()
        return self._trace_id

    # ---------------------------------------------------------------- emit

    def emit(self, level: Level, ev: Event, /, **fields: Any) -> None:
        if not self._enabled(level, ev, fields):
            return
        line = {
            "ts": _now_iso(),
            "level": level,
            "ev": ev,
            "trace_id": self._trace_id,
            "room": self.room,
            **fields,
        }
        # One write call per line. Two threads interleaving halfway through a
        # JSON object produces a file nothing can parse.
        with self._lock:
            self._stream.write(json.dumps(line, separators=(",", ":"), default=str) + "\n")
            self._stream.flush()

    def _enabled(self, level: Level, ev: Event, fields: dict[str, Any]) -> bool:
        if _ORDER[level] < _ORDER[self.level]:
            return False
        if ev in _FIREHOSE:
            return str(fields.get("skill", "")) in self.trace_skills
        return True

    # Thin wrappers so call sites read as the level they are, and so the
    # event name stays the first positional argument everywhere.
    def trace(self, ev: Event, /, **f: Any) -> None:
        self.emit("trace", ev, **f)

    def debug(self, ev: Event, /, **f: Any) -> None:
        self.emit("debug", ev, **f)

    def info(self, ev: Event, /, **f: Any) -> None:
        self.emit("info", ev, **f)

    def warn(self, ev: Event, /, **f: Any) -> None:
        self.emit("warn", ev, **f)

    def error(self, ev: Event, /, **f: Any) -> None:
        self.emit("error", ev, **f)


def new_trace_id() -> str:
    """
    Short, sortable, and unique enough. Time prefix first so that grepping a
    day's logs and sorting puts a session's spans in the order they happened.
    """
    return f"{int(time.time() * 1000):x}{os.urandom(3).hex()}"
