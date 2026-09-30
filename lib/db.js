import fs from "node:fs";
import path from "node:path";
// Node's built-in SQLite. No native build step, no dependency. Requires Node
// 22.5+ (with --experimental-sqlite on 22.x); unflagged from Node 23.4.
import { DatabaseSync } from "node:sqlite";

// Schema is created in one go and is additive-only. Bumping a challenge's
// scoring_version is how scoring changes are rolled out (see lib/challenges.js),
// so historical rows never need rewriting.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS challenges (
  id               TEXT    PRIMARY KEY,
  day_key          TEXT    NOT NULL,
  slug             TEXT    NOT NULL,
  prompt           TEXT    NOT NULL,
  -- The yes/no proposition whose probability becomes the score.
  scoring_question TEXT    NOT NULL,
  -- JSON: { "true": "...", "false": "..." }, or NULL when unconstrained.
  criteria         TEXT,
  scoring_version  INTEGER NOT NULL,
  created_at       TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS challenges_day_slug_version
  ON challenges (day_key, slug, scoring_version);

CREATE INDEX IF NOT EXISTS challenges_day ON challenges (day_key);

CREATE TABLE IF NOT EXISTS evaluations (
  id                TEXT    PRIMARY KEY,
  challenge_id      TEXT    NOT NULL REFERENCES challenges (id),
  answer_hash       TEXT    NOT NULL,
  original_answer   TEXT    NOT NULL,
  normalized_answer TEXT    NOT NULL,
  -- The raw probability Jev returned, stored as a float64 REAL.
  noul              REAL    NOT NULL CHECK (noul >= 0 AND noul <= 1),
  -- Math.round(noul * 100), stored so the score can never drift from the
  -- value the player was shown.
  score             INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  model             TEXT    NOT NULL,
  scoring_version   INTEGER NOT NULL,
  -- The question and criteria as they stood when this was evaluated, so a row
  -- always carries the terms it was judged under.
  scoring_question  TEXT    NOT NULL,
  criteria          TEXT,
  created_at        TEXT    NOT NULL
);

-- The core deduplication guarantee: one authoritative evaluation per
-- (challenge, answer hash). The hash already folds in scoring_version.
CREATE UNIQUE INDEX IF NOT EXISTS evaluations_challenge_hash
  ON evaluations (challenge_id, answer_hash);

CREATE TABLE IF NOT EXISTS submissions (
  id              TEXT PRIMARY KEY,
  player_id       TEXT NOT NULL,
  challenge_id    TEXT NOT NULL REFERENCES challenges (id),
  evaluation_id   TEXT NOT NULL REFERENCES evaluations (id),
  display_name    TEXT NOT NULL,
  original_answer TEXT NOT NULL,
  submitted_at    TEXT NOT NULL
);

-- One attempt per player per challenge, enforced by the database rather than
-- by the caller or the browser.
CREATE UNIQUE INDEX IF NOT EXISTS submissions_player_challenge
  ON submissions (player_id, challenge_id);

CREATE INDEX IF NOT EXISTS submissions_board
  ON submissions (challenge_id, submitted_at, id);
`;

/**
 * Open (and migrate) the database. Pass ":memory:" for tests.
 */
export function openDatabase(location = process.env.DATABASE_FILE || "data/daily.db") {
  if (location !== ":memory:") {
    const dir = path.dirname(location);
    if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(location, { enableForeignKeyConstraints: true });

  // WAL keeps readers from blocking the writer. Not available for in-memory
  // databases, where the pragma is a harmless no-op.
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    // Ignore: an unsupported journal mode is not worth failing startup over.
  }
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);

  return db;
}

/**
 * Run `fn` inside an immediate transaction. Not re-entrant - do not nest.
 */
export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A failed rollback must not mask the original error.
    }
    throw err;
  }
}

// SQLITE_CONSTRAINT_UNIQUE (2067) and SQLITE_CONSTRAINT_PRIMARYKEY (1555).
const UNIQUE_ERRCODES = new Set([1555, 2067]);

export function isUniqueViolation(err) {
  if (!err) return false;
  if (UNIQUE_ERRCODES.has(err.errcode)) return true;
  return /UNIQUE constraint failed/i.test(String(err.message ?? ""));
}
