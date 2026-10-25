"""
The local store: observations, embeddings, and labels.

This is the half of the design's schema that deliberately does NOT live in
the Engine. Perception produces several scores a second per skill, and the
whole point of the process split is that the control plane never sees one, so
scores stay here, next to the frames that produced them.

Keeping the embeddings matters for a reason beyond debugging. A label is only
useful if you still have the vector it describes: when the teacher adjudicates
a frame, or you answer a question about one, the thing that gets trained on is
the embedding at that moment. Throwing it away would mean every answer taught
the system nothing.

At 1152 float32 that is 4.6 KB a frame, so a day of one camera at 0.5 Hz is
about 200 MB. Retention is therefore a first-class setting rather than an
afterthought, and the default keeps a week.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

SCHEMA = """
CREATE TABLE IF NOT EXISTS observations (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_key TEXT    NOT NULL,
  ts        REAL    NOT NULL,
  score     REAL    NOT NULL,
  cos       REAL    NOT NULL,
  phase     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS obs_skill_ts ON observations (skill_key, ts);

-- Embeddings are keyed on time rather than on a skill: one frame is scored by
-- every eligible skill, so storing it per skill would duplicate it N times.
CREATE TABLE IF NOT EXISTS frames (
  ts         REAL PRIMARY KEY,
  encoder_id TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  embedding  BLOB NOT NULL
);

-- What the loop is made of. source tells you whether to trust it: a human
-- answer outranks a teacher adjudication when they disagree.
CREATE TABLE IF NOT EXISTS training_examples (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_key  TEXT    NOT NULL,
  class_key  TEXT,
  label      INTEGER NOT NULL,
  source     TEXT    NOT NULL,
  frame_ts   REAL    NOT NULL,
  created_at REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS ex_skill ON training_examples (skill_key);
"""


@dataclass(frozen=True, slots=True)
class Example:
    embedding: np.ndarray
    label: int
    source: str


#: Writes to batch before committing. Committing per frame would fsync on
#: every sample; never committing at all means a crash loses the lot and
#: nothing outside this process can read what the system has been doing,
#: which is how this was found.
_COMMIT_EVERY = 16


class Store:
    def __init__(self, path: str | Path = "traces/perception.db", retain_days: float = 7.0) -> None:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(p, check_same_thread=False)
        self.db.executescript(SCHEMA)
        # WAL so a long-running writer does not block a reader poking at the
        # same file to see what the system has been doing.
        self.db.execute("PRAGMA journal_mode=WAL")
        self.retain_s = retain_days * 86400.0
        self._last_vacuum = 0.0
        self._uncommitted = 0

    # ------------------------------------------------------------- writing

    def observe(self, skill_key: str, ts: float, score: float, cos: float, phase: str) -> None:
        self.db.execute(
            "INSERT INTO observations (skill_key, ts, score, cos, phase) VALUES (?,?,?,?,?)",
            (skill_key, ts, score, cos, phase),
        )
        self._tick()

    def remember_frame(self, ts: float, embedding: np.ndarray, encoder_id: str) -> None:
        vec = np.asarray(embedding, dtype=np.float32)
        self.db.execute(
            "INSERT OR REPLACE INTO frames (ts, encoder_id, dim, embedding) VALUES (?,?,?,?)",
            (ts, encoder_id, int(vec.shape[-1]), vec.tobytes()),
        )
        self._tick()

    def _tick(self) -> None:
        self._uncommitted += 1
        if self._uncommitted >= _COMMIT_EVERY:
            self.db.commit()
            self._uncommitted = 0

    def label(
        self,
        skill_key: str,
        frame_ts: float,
        label: int,
        source: str,
        class_key: str | None = None,
    ) -> None:
        self.db.execute(
            """INSERT INTO training_examples
               (skill_key, class_key, label, source, frame_ts, created_at)
               VALUES (?,?,?,?,?,?)""",
            (skill_key, class_key, label, source, frame_ts, time.time()),
        )
        self.db.commit()

    def commit(self) -> None:
        self.db.commit()

    # ------------------------------------------------------------- reading

    def examples(self, skill_key: str, encoder_id: str) -> list[Example]:
        """
        Labels joined to the embeddings they describe.

        Filtered on encoder_id: an example gathered under a different encoder
        is not merely stale, it is a point in a different space, and training
        on a mix of the two produces a probe that fits neither.
        """
        rows = self.db.execute(
            """SELECT e.label, e.source, f.embedding, f.dim
               FROM training_examples e
               JOIN frames f ON f.ts = e.frame_ts
               WHERE e.skill_key = ? AND f.encoder_id = ?
               ORDER BY e.created_at""",
            (skill_key, encoder_id),
        ).fetchall()
        return [
            Example(
                embedding=np.frombuffer(blob, dtype=np.float32).reshape(dim),
                label=int(label),
                source=str(source),
            )
            for label, source, blob, dim in rows
        ]

    def cosines(self, skill_key: str, limit: int = 600) -> np.ndarray:
        rows = self.db.execute(
            "SELECT cos FROM observations WHERE skill_key = ? ORDER BY ts DESC LIMIT ?",
            (skill_key, limit),
        ).fetchall()
        return np.asarray([r[0] for r in rows], dtype=np.float64)

    def nearest_frame_ts(self, ts: float, tolerance: float = 2.0) -> float | None:
        """
        The stored frame closest to a moment.

        A teacher verdict or a human answer arrives seconds after the frame it
        is about, so a label has to be attached by proximity rather than by an
        exact timestamp it was never given.
        """
        row = self.db.execute(
            "SELECT ts FROM frames ORDER BY ABS(ts - ?) LIMIT 1", (ts,)
        ).fetchone()
        if row is None:
            return None
        return float(row[0]) if abs(float(row[0]) - ts) <= tolerance else None

    # ------------------------------------------------------------ retention

    def prune(self, now: float | None = None) -> int:
        """
        Drop what is older than the retention window.

        Observations and frames go; training examples never do. A label is
        small, it took a person or a teacher call to produce, and the whole
        premise is that the system improves as they accumulate.
        """
        now = now if now is not None else time.time()
        if now - self._last_vacuum < 3600:
            return 0
        self._last_vacuum = now
        cutoff = now - self.retain_s
        kept = self.db.execute("SELECT frame_ts FROM training_examples").fetchall()
        keep = {float(r[0]) for r in kept}

        rows = self.db.execute("SELECT ts FROM frames WHERE ts < ?", (cutoff,)).fetchall()
        doomed = [(float(r[0]),) for r in rows if float(r[0]) not in keep]
        self.db.executemany("DELETE FROM frames WHERE ts = ?", doomed)
        cur = self.db.execute("DELETE FROM observations WHERE ts < ?", (cutoff,))
        self.db.commit()
        return len(doomed) + (cur.rowcount or 0)

    def close(self) -> None:
        self.db.commit()
        self.db.close()
