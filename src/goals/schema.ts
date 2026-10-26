/**
 * The ledger's schema, in one place.
 *
 * Applied idempotently on every Engine boot. A Durable Object's SQLite lives
 * and dies with the object, so there is no migration tooling and no need for
 * any: `CREATE TABLE IF NOT EXISTS` run at startup is the whole story, and
 * keeping the statements here rather than beside the queries means the shape
 * of the ledger can be read without reading the code that uses it.
 *
 * One deliberate departure from the design document. It describes an
 * `observations` table holding every score, append-only. That cannot live
 * here: perception produces several scores a second per skill, and the entire
 * point of the process split is that the control plane never sees them. So
 * scores and their cached embeddings stay in perception's own store, next to
 * the frames, and this database holds only what crossed the wire -
 * transitions, and the instances they settled. The design's schema is one
 * logical model split across two stores, and this is the half that is
 * cheap to keep forever.
 *
 * `transitions` is append-only and is never edited, which is what lets a
 * settled instance be re-explained months later: the row that caused it,
 * including its trace id, is still there.
 */

/**
 * Columns added after the table first shipped.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists,
 * so a new column never reaches a Durable Object that has been running since
 * before it was written. Each of these runs on its own and is allowed to
 * fail: SQLite raises "duplicate column name" when it is already there, which
 * is the normal case on every boot after the first.
 */
export const ADDITIONS: readonly string[] = [
  "ALTER TABLE skills ADD COLUMN min_cycle_s REAL NOT NULL DEFAULT 0.0",
  "ALTER TABLE transitions ADD COLUMN needed_conf REAL",
  "ALTER TABLE goals ADD COLUMN sequence_window_s REAL NOT NULL DEFAULT 600",
  "ALTER TABLE instances ADD COLUMN nudged_at INTEGER",
];

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  key              TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  label            TEXT NOT NULL,
  room             TEXT,
  depends_on       TEXT REFERENCES skills(key),

  -- Which kind of picture this question is about: 'camera', 'screen', or
  -- 'any'. Not decoration. A shared screen and a room camera arrive down the
  -- same pipe, so without this every skill is scored against every frame and
  -- "a person at a bathroom sink" quietly calibrates its idea of a normal
  -- frame against screenshots of a code editor. The scores stay low, so
  -- nothing looks broken while the thresholds drift.
  surface          TEXT NOT NULL DEFAULT 'any',

  enter_conf       REAL NOT NULL DEFAULT 0.75,
  exit_conf        REAL NOT NULL DEFAULT 0.45,
  dwell_s          REAL NOT NULL DEFAULT 2.0,
  exit_s           REAL NOT NULL DEFAULT 2.0,
  cooldown_s       REAL NOT NULL DEFAULT 10.0,
  escalate_after_s REAL NOT NULL DEFAULT 60.0,
  -- Shortest believable gap between two counts, count-to-count. Cooldown
  -- measures from the end of a session and so cannot express this.
  min_cycle_s      REAL NOT NULL DEFAULT 0.0,

  classes          TEXT,
  margin           REAL,

  -- The fitted calibration. Defaults are deliberately the identity, so an
  -- uncalibrated skill scores around 0.5 for everything and is obviously
  -- wrong rather than subtly wrong.
  bias             REAL NOT NULL DEFAULT 0.0,
  temperature      REAL NOT NULL DEFAULT 1.0,

  -- The weight vector, as base64 float32. 1152 floats for most kinds,
  -- K x 1152 for a discriminator. Stored here so it survives a perception
  -- restart; only perception ever reads it.
  w                TEXT,
  encoder_id       TEXT,
  dim              INTEGER,
  weight_state     TEXT NOT NULL DEFAULT 'pending',
  n_labels         INTEGER NOT NULL DEFAULT 0,

  sample_hz        REAL NOT NULL DEFAULT 0.5,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  key           TEXT PRIMARY KEY,
  description   TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'target',
  cadence       TEXT NOT NULL,
  done_min      REAL,
  done_max      REAL,
  window_start  TEXT,
  window_end    TEXT,
  tz            TEXT NOT NULL DEFAULT 'UTC',
  -- Longest gap allowed between two steps of one sequenced pass, in
  -- seconds. Zero means no limit. Without it a first step observed in the
  -- morning would go on scoping later steps all day.
  sequence_window_s REAL NOT NULL DEFAULT 600,
  step_value    REAL,
  step_period   TEXT,
  step_on       TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS goal_skills (
  goal_key       TEXT NOT NULL REFERENCES goals(key) ON DELETE CASCADE,
  skill_key      TEXT NOT NULL REFERENCES skills(key),
  role           TEXT NOT NULL,
  class_key      TEXT,
  min_count      INTEGER,
  accumulate     INTEGER NOT NULL DEFAULT 0,
  sequence_index INTEGER,
  PRIMARY KEY (goal_key, skill_key)
);

CREATE TABLE IF NOT EXISTS instances (
  id            TEXT PRIMARY KEY,
  goal_key      TEXT NOT NULL REFERENCES goals(key) ON DELETE CASCADE,
  occurrence_on TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'pending',
  observed      REAL NOT NULL DEFAULT 0,
  -- Frozen at creation. This is what makes a progression work: raising next
  -- week's target must not retroactively raise this week's.
  target_min    REAL,
  -- When this occurrence was last spoken about unprompted. One nudge per
  -- occurrence: saying it every time someone walks past the sink is how an
  -- assistant gets switched off.
  nudged_at     INTEGER,
  settled_at    INTEGER,
  settled_by    TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE (goal_key, occurrence_on)
);

-- A nudge with a time on it. The only row in this schema about the future,
-- which is why the Engine has an alarm and the Hub does not.
CREATE TABLE IF NOT EXISTS reminders (
  id       TEXT PRIMARY KEY,
  at       INTEGER NOT NULL,
  text     TEXT NOT NULL,
  goal_key TEXT,
  done     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders (done, at);

-- A better label, measured but not yet applied.
--
-- One row per skill, newest replacing older: a proposal is a question
-- waiting for an answer, and two of them open at once for the same skill is
-- two answers for one decision. It is kept out of the skills table because
-- a label IS the detector - writing one straight onto the row would change
-- what the system believes on the strength of a vision call, and nobody
-- would see the before and after numbers that justified it.
CREATE TABLE IF NOT EXISTS proposals (
  skill_key    TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  -- What it would replace, captured when proposed. The skill's own label
  -- can change under a pending proposal, and then the numbers below would
  -- be a comparison against something that is no longer there.
  was          TEXT NOT NULL,
  ratio_after  REAL NOT NULL,
  ratio_before REAL NOT NULL,
  runners_up   TEXT NOT NULL DEFAULT '[]',
  at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id             TEXT PRIMARY KEY,
  instance_id    TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  skill_key      TEXT NOT NULL REFERENCES skills(key),
  prompt         TEXT NOT NULL,
  proposed_value TEXT,
  asked_at       INTEGER NOT NULL,
  answered_at    INTEGER,
  answer         TEXT
);

-- Append-only. Every row here is one thing that actually happened, and the
-- trace id is what links it back to the frames that caused it.
CREATE TABLE IF NOT EXISTS transitions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_key   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  at          INTEGER NOT NULL,
  room        TEXT NOT NULL,
  trace_id    TEXT NOT NULL,
  score       REAL NOT NULL,
  reason      TEXT NOT NULL,
  dwell_ms    INTEGER,
  duration_ms INTEGER,
  held_ms     INTEGER,
  needed_ms   INTEGER,
  needed_conf REAL,
  peak        REAL,
  count       INTEGER,
  class_key   TEXT,
  p1          REAL,
  p2          REAL,
  margin      REAL,
  verdict_by  TEXT
);

-- The two lookups that actually happen at speed: "what did this skill do
-- recently" when evaluating a goal, and "what happened in this span" when
-- explaining a settlement to someone.
CREATE INDEX IF NOT EXISTS transitions_skill_at ON transitions (skill_key, at);
CREATE INDEX IF NOT EXISTS transitions_trace ON transitions (trace_id);
CREATE INDEX IF NOT EXISTS instances_goal_date ON instances (goal_key, occurrence_on);
CREATE INDEX IF NOT EXISTS questions_open ON questions (answered_at, asked_at);
`;

/**
 * Columns added after the first deploy.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already
 * exists, so a column added to the statement above never reaches a Durable
 * Object that has already booted once - and the failure is a confusing "no
 * such column" at query time rather than at startup. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so each of these is run on its own and the
 * duplicate-column error is the expected outcome on every boot but the first.
 */
export const MIGRATIONS: readonly string[] = [
  `ALTER TABLE skills ADD COLUMN surface TEXT NOT NULL DEFAULT 'any'`,
];
