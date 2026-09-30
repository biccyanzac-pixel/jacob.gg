-- D1 schema for the shared leaderboard backend.
--
-- Scoring happens entirely in the player's browser (open-jev/kev-0.6b). This
-- worker never runs a model and never sees an AI API key - it only validates
-- and stores what the browser already computed, the same trust model as any
-- client-authoritative game score, with the abuse guards below.

CREATE TABLE IF NOT EXISTS players (
  id         TEXT PRIMARY KEY,   -- server-generated UUID, never client-chosen
  token_hash TEXT NOT NULL,      -- SHA-256 of a server-issued session token
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id                TEXT PRIMARY KEY,
  player_id         TEXT NOT NULL REFERENCES players (id),
  challenge_id      TEXT NOT NULL,   -- e.g. fun-happy-thought@v2:2026-10-01
  day_key           TEXT NOT NULL,
  scoring_version   INTEGER NOT NULL,
  display_name      TEXT NOT NULL,
  original_answer   TEXT NOT NULL,
  normalized_answer TEXT NOT NULL,
  answer_hash       TEXT NOT NULL,   -- SHA-256, must match a server recompute
  noul              REAL NOT NULL CHECK (noul >= 0 AND noul <= 1),
  score             INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  model             TEXT NOT NULL,   -- which judge/model produced this noul
  submitted_at      TEXT NOT NULL
);

-- One submission per player per challenge, enforced by the database, not the
-- client.
CREATE UNIQUE INDEX IF NOT EXISTS submissions_player_challenge
  ON submissions (player_id, challenge_id);

-- The score must actually be the browser-reported noul rounded, so a forged
-- request that sends a high score with a low noul is rejected before it ever
-- reaches this constraint (see worker src/index.js), but this is a second,
-- structural line of defence.
CREATE INDEX IF NOT EXISTS submissions_board
  ON submissions (challenge_id, score DESC, submitted_at ASC, id ASC);
