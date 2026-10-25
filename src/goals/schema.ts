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

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  key              TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  label            TEXT NOT NULL,
  room             TEXT,
  depends_on       TEXT REFERENCES skills(key),

  enter_conf       REAL NOT NULL DEFAULT 0.75,
  exit_conf        REAL NOT NULL DEFAULT 0.45,
  dwell_s          REAL NOT NULL DEFAULT 2.0,
  exit_s           REAL NOT NULL DEFAULT 2.0,
  cooldown_s       REAL NOT NULL DEFAULT 10.0,
  escalate_after_s REAL NOT NULL DEFAULT 60.0,

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
  settled_at    INTEGER,
  settled_by    TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE (goal_key, occurrence_on)
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
