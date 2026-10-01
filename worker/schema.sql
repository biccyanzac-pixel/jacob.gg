-- D1 schema for the shared leaderboard backend.
--
-- Scoring happens entirely in the player's browser (open-jev/kev-0.6b). This
-- worker never runs a model and never sees an AI API key - it only validates
-- and stores what the browser already computed, the same trust model as any
-- client-authoritative game score, with the abuse guards documented in
-- src/index.js.
--
-- v2: up to 3 attempts per player per challenge (was 1), full-precision
-- REAL scores (was integer). See src/index.js's SCORING_VERSION = 3.

CREATE TABLE IF NOT EXISTS players (
  id         TEXT PRIMARY KEY,   -- server-generated UUID, never client-chosen
  token_hash TEXT NOT NULL,      -- SHA-256 of a server-issued session token
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id                TEXT PRIMARY KEY,
  player_id         TEXT NOT NULL REFERENCES players (id),
  challenge_id      TEXT NOT NULL,   -- e.g. fun-happy-thought@v3:2026-10-01
  day_key           TEXT NOT NULL,
  scoring_version   INTEGER NOT NULL,
  attempt_number    INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  display_name      TEXT NOT NULL,
  original_answer   TEXT NOT NULL,
  normalized_answer TEXT NOT NULL,
  answer_hash       TEXT NOT NULL,   -- SHA-256, must match a server recompute
  noul              REAL NOT NULL CHECK (noul >= 0 AND noul <= 1),
  -- Full precision (noul * 100), never rounded before storage. Display
  -- formatting to two decimal places happens client-side only.
  score             REAL NOT NULL CHECK (score >= 0 AND score <= 100),
  model             TEXT NOT NULL,   -- which judge/model produced this noul
  submitted_at      TEXT NOT NULL
);

-- At most one row per player per challenge per attempt number - this is what
-- makes "3 attempts" a database fact rather than an application promise. The
-- attempt number itself is always assigned server-side (existing row count +
-- 1), never trusted from the client; see src/index.js.
CREATE UNIQUE INDEX IF NOT EXISTS submissions_player_challenge_attempt
  ON submissions (player_id, challenge_id, attempt_number);

-- Duplicate-answer rejection (same player, same challenge, same normalized
-- answer) is enforced in handlePlay() itself, checked before an attempt
-- number is ever assigned - NOT as a database constraint here. Production
-- already has pre-existing rows that would violate such a constraint (test
-- traffic from before this rule existed), and this schema's own invariant is
-- insert-only, never-delete - retroactively cleaning that data to add the
-- constraint would mean deleting historical rows, which this file
-- deliberately never does. The application-level check is still genuine
-- server-side enforcement (the client's belief about whether it's a
-- duplicate is never trusted); see handlePlay() in src/index.js.

-- Leaderboard reads: best score per player for a challenge. See fetchBoard()
-- in src/index.js for the query and the documented tie-break rule.
CREATE INDEX IF NOT EXISTS submissions_board
  ON submissions (challenge_id, player_id, score DESC, submitted_at ASC, id ASC);
