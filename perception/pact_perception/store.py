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

#: The frames table, hoisted out of SCHEMA because the migration below has to
#: be able to run the identical statement. Its primary key widened from `ts`
#: to `(ts, view)`, and SQLite cannot ALTER a primary key - the table has to be
#: rebuilt - so the DDL is written once here and reused rather than copied into
#: the migration where the two could drift apart.
_FRAMES_DDL = """
CREATE TABLE IF NOT EXISTS frames (
  ts         REAL    NOT NULL,
  -- Which picture of this moment produced this vector: "full" or "layout".
  -- Part of the key, not a tag. Two skills on one frame can want different
  -- views, and with `ts` alone as the key the second INSERT OR REPLACE
  -- silently overwrote the first - leaving one vector claiming to be the
  -- frame, joined to observations from both views, with nothing to say which
  -- one it was. A cosine measured on a blurred frame is not comparable to one
  -- measured on a sharp frame, so that mixture corrupts every bias and
  -- temperature fitted from it.
  view       TEXT    NOT NULL DEFAULT 'full',
  encoder_id TEXT    NOT NULL,
  dim        INTEGER NOT NULL,
  embedding  BLOB    NOT NULL,
  PRIMARY KEY (ts, view)
)"""

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS observations (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_key TEXT    NOT NULL,
  ts        REAL    NOT NULL,
  score     REAL    NOT NULL,
  cos       REAL    NOT NULL,
  phase     TEXT    NOT NULL,
  -- The view the scored vector came from. Redundant against the skill's own
  -- row in the registry, and stored anyway: this is what makes the join to
  -- `frames` pick the right one of two vectors at the same instant, and the
  -- registry is in another process.
  view      TEXT    NOT NULL DEFAULT 'full'
);
CREATE INDEX IF NOT EXISTS obs_skill_ts ON observations (skill_key, ts);

-- Embeddings are keyed on time and view rather than on a skill: one frame is
-- scored by every eligible skill, so storing it per skill would duplicate it
-- N times. Per view, though, it genuinely is a different vector.
{_FRAMES_DDL};

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
        self.path = p
        self.db = sqlite3.connect(p, check_same_thread=False)
        self._prepare()
        # WAL so a long-running writer does not block a reader poking at the
        # same file to see what the system has been doing.
        self.db.execute("PRAGMA journal_mode=WAL")
        self.retain_s = retain_days * 86400.0
        self._last_vacuum = 0.0
        self._uncommitted = 0

    # ----------------------------------------------------------- migration

    def _prepare(self) -> None:
        """
        Apply the schema, then bring an older store up to it.

        Both halves are under one handler because both can fail the same way
        and for the same reason, and the remedy is the same either way. A
        store takes one writer - two of them lose each other's observations -
        and `_add_views` is the only thing a Store does at startup that
        writes, so it is where a second process now notices. Which of the two
        statements trips depends on how strong a lock the live writer happens
        to be holding at that instant, which is not a distinction worth
        putting in front of someone.
        """
        try:
            self.db.executescript(SCHEMA)
            self._add_views()
        except sqlite3.OperationalError as err:
            if "locked" not in str(err) and "busy" not in str(err):
                raise
            self.db.rollback()
            raise RuntimeError(
                f"{self.path} is held by another process. A store takes one "
                "writer, and this run needs to write: a store recorded before "
                "views existed takes a one-time migration to record which view "
                "produced each embedding. Stop the perception process already "
                "using this file, or point this run at a different one with "
                "--store."
            ) from err

    def _add_views(self) -> None:
        """
        Bring a database written before views up to one that has them.

        `CREATE TABLE IF NOT EXISTS` is a no-op against a table that is
        already there, so the statements above do nothing to a store that has
        been recording since before this column existed - and the failure is
        a confusing "no such column: view" at query time rather than at
        startup.

        The two tables need different treatment and that is the whole reason
        this is a function rather than a line. `observations` takes a plain
        ADD COLUMN. `frames` cannot: its primary key widened from `ts` to
        `(ts, view)`, SQLite has no way to alter a primary key, and leaving
        the narrow one in place is not a cosmetic difference - it is the bug
        this whole change exists to avoid, where the layout vector replaces
        the full one at the same instant. So the table is rebuilt.

        Everything already stored was encoded from the frame as it arrived,
        which is exactly what "full" means, so the backfill is not a guess.

        This is also the only thing a Store does at startup that WRITES, and
        so the only thing that can be refused by a store a live process is
        already recording into. `_prepare` turns that refusal into something
        actionable.

        Both checks are made before either write, so a store that has already
        been migrated - every store, after the first boot - does nothing at
        all here and takes no lock.
        """
        if "view" in self._columns("observations") and "view" in self._columns("frames"):
            return
        if "view" not in self._columns("observations"):
            self.db.execute("ALTER TABLE observations ADD COLUMN view TEXT NOT NULL DEFAULT 'full'")
        if "view" not in self._columns("frames"):
            self.db.execute("ALTER TABLE frames RENAME TO frames_pre_view")
            self.db.execute(_FRAMES_DDL)
            self.db.execute(
                """INSERT INTO frames (ts, view, encoder_id, dim, embedding)
                   SELECT ts, 'full', encoder_id, dim, embedding FROM frames_pre_view"""
            )
            self.db.execute("DROP TABLE frames_pre_view")
        self.db.commit()

    def _columns(self, table: str) -> set[str]:
        return {str(row[1]) for row in self.db.execute(f"PRAGMA table_info({table})")}

    # ------------------------------------------------------------- writing

    def observe(
        self,
        skill_key: str,
        ts: float,
        score: float,
        cos: float,
        phase: str,
        view: str = "full",
    ) -> None:
        self.db.execute(
            """INSERT INTO observations (skill_key, ts, score, cos, phase, view)
               VALUES (?,?,?,?,?,?)""",
            (skill_key, ts, score, cos, phase, view),
        )
        self._tick()

    def remember_frame(
        self, ts: float, embedding: np.ndarray, encoder_id: str, view: str = "full"
    ) -> None:
        vec = np.asarray(embedding, dtype=np.float32)
        self.db.execute(
            """INSERT OR REPLACE INTO frames (ts, view, encoder_id, dim, embedding)
               VALUES (?,?,?,?,?)""",
            (ts, view, encoder_id, int(vec.shape[-1]), vec.tobytes()),
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

    def examples(self, skill_key: str, encoder_id: str, view: str = "full") -> list[Example]:
        """
        Labels joined to the embeddings they describe.

        Filtered on encoder_id: an example gathered under a different encoder
        is not merely stale, it is a point in a different space, and training
        on a mix of the two produces a probe that fits neither.

        Filtered on view for the same reason one level down. A label records a
        moment, not a vector, and that moment may have been encoded twice -
        once as it arrived and once with its content averaged away. Only one
        of the two is the picture this skill was ever scored against, and a
        probe fitted across both is fitted across two different spaces.
        """
        rows = self.db.execute(
            """SELECT e.label, e.source, f.embedding, f.dim
               FROM training_examples e
               JOIN frames f ON f.ts = e.frame_ts
               WHERE e.skill_key = ? AND f.encoder_id = ? AND f.view = ?
               ORDER BY e.created_at""",
            (skill_key, encoder_id, view),
        ).fetchall()
        return [
            Example(
                embedding=np.frombuffer(blob, dtype=np.float32).reshape(dim),
                label=int(label),
                source=str(source),
            )
            for label, source, blob, dim in rows
        ]

    def frames_between(
        self, start: float, end: float, limit: int = 2000, view: str = "full"
    ) -> list[float]:
        """
        Every stored frame inside a stretch of time, oldest first.

        This is what makes a spoken correction worth more than a nod. "I was
        reading for twenty minutes" is one sentence and several hundred
        frames, and several hundred is the quantity a refit has always needed
        and almost never had - the ordinary loop only ever produces a label
        when something was noticed, which is exactly not the case being
        corrected.
        """
        rows = self.db.execute(
            """SELECT ts FROM frames
               WHERE ts >= ? AND ts <= ? AND view = ? ORDER BY ts LIMIT ?""",
            (start, end, view, limit),
        ).fetchall()
        return [float(r[0]) for r in rows]

    def labelled_ts(self, skill_key: str) -> set[float]:
        """Frames this skill already has an example for."""
        rows = self.db.execute(
            "SELECT frame_ts FROM training_examples WHERE skill_key = ?", (skill_key,)
        ).fetchall()
        return {float(r[0]) for r in rows}

    def quiet_frames(
        self,
        skill_key: str,
        start: float,
        end: float,
        limit: int,
        margin: float = 300.0,
        view: str = "full",
    ) -> list[float]:
        """
        Frames from outside a window, least like this skill first.

        A fit needs both answers. A correction only ever supplies one of them
        - nobody volunteers "and I was NOT doing it at 14:32" - so the
        opposite examples have to be found rather than told, and the honest
        place to look is where this skill already scored lowest.

        Two things keep that from being circular. The ordering uses the raw
        cosine, which is what the skill thought BEFORE any of this, so a
        frame is chosen for looking unlike the skill rather than for
        agreeing with it. And `margin` holds the selection well clear of the
        window's edges, because the minutes either side of a correction are
        the ones most likely to be the same activity half-started.

        These are assumed, not observed, and that is the weakest link in the
        whole loop. It is survivable only because the refit tests itself on
        frames it did not train on and discards itself when it fails, so a
        bad draw costs a rejected refit rather than a corrupted skill.
        """
        rows = self.db.execute(
            """SELECT f.ts FROM frames f
               LEFT JOIN observations o
                 ON o.ts = f.ts AND o.view = f.view AND o.skill_key = ?
               WHERE f.view = ? AND (f.ts < ? OR f.ts > ?)
               ORDER BY COALESCE(o.cos, -1e9) ASC
               LIMIT ?""",
            (skill_key, view, start - margin, end + margin, limit),
        ).fetchall()
        return [float(r[0]) for r in rows]

    def scored_frames(
        self, skill_key: str, since: float, until: float, limit: int = 600
    ) -> np.ndarray:
        """
        Embeddings of frames this skill has already scored, in a window.

        Joined through observations rather than taken from `frames` directly,
        which gets the surface right for free: a skill only ever scores its
        own surface, so anything it has an observation for is a frame it
        could legitimately be compared against. The frames table has no
        surface of its own, and picking negatives from the wrong one would
        flatter any label at all.

        The view comes along the same way, and that is why this takes no view
        argument. Each observation carries the view it was scored in, so
        matching it in the join yields the vectors this skill actually saw -
        a skill asking about layout gets layout vectors on both sides of the
        comparison, which is the only way `rank_candidates` means anything.
        """
        rows = self.db.execute(
            """SELECT f.embedding, f.dim
               FROM observations o JOIN frames f ON f.ts = o.ts AND f.view = o.view
               WHERE o.skill_key = ? AND o.ts BETWEEN ? AND ?
               ORDER BY o.ts DESC LIMIT ?""",
            (skill_key, since, until, limit),
        ).fetchall()
        if not rows:
            return np.zeros((0, 0), dtype=np.float32)
        return np.stack(
            [np.frombuffer(blob, dtype=np.float32).reshape(dim) for blob, dim in rows]
        )

    def cosines(self, skill_key: str, limit: int = 600) -> np.ndarray:
        rows = self.db.execute(
            "SELECT cos FROM observations WHERE skill_key = ? ORDER BY ts DESC LIMIT ?",
            (skill_key, limit),
        ).fetchall()
        return np.asarray([r[0] for r in rows], dtype=np.float64)

    def nearest_frame_ts(
        self, ts: float, tolerance: float = 2.0, view: str = "full"
    ) -> float | None:
        """
        The stored frame closest to a moment, in a given view.

        A teacher verdict or a human answer arrives seconds after the frame it
        is about, so a label has to be attached by proximity rather than by an
        exact timestamp it was never given.

        The view matters even though what comes back is only a timestamp. A
        moment is encoded in whichever views were wanted at the time, so the
        nearest moment overall may be one this skill's view never saw - and a
        label pinned there joins to nothing, which is a label silently lost
        rather than one that is wrong.
        """
        row = self.db.execute(
            "SELECT ts FROM frames WHERE view = ? ORDER BY ABS(ts - ?) LIMIT 1", (view, ts)
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

        # DISTINCT because one moment is now several rows - one per view - and
        # the DELETE below drops every view of a doomed timestamp in one go.
        rows = self.db.execute(
            "SELECT DISTINCT ts FROM frames WHERE ts < ?", (cutoff,)
        ).fetchall()
        doomed = [(float(r[0]),) for r in rows if float(r[0]) not in keep]
        self.db.executemany("DELETE FROM frames WHERE ts = ?", doomed)
        cur = self.db.execute("DELETE FROM observations WHERE ts < ?", (cutoff,))
        self.db.commit()
        return len(doomed) + (cur.rowcount or 0)

    def close(self) -> None:
        self.db.commit()
        self.db.close()
