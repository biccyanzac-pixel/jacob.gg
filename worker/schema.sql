-- D1 schema for the jacob.gg hub: play counts (synced from each game's leaderboard) and ratings.

-- One row per (game, puzzle day, player). player is the game's own player id; ids are never compared across games.
CREATE TABLE IF NOT EXISTS plays (
  game      TEXT NOT NULL,
  day_key   TEXT NOT NULL,   -- the puzzle's UTC day
  player    TEXT NOT NULL,
  played_on TEXT NOT NULL,   -- UTC day it was played: day_key, or the replay day for archive plays
  PRIMARY KEY (game, day_key, player)
);

-- Plays per game per UTC day, kept in step with plays, so stats read a few hundred rows, not every play.
CREATE TABLE IF NOT EXISTS daily_counts (
  game      TEXT NOT NULL,
  played_on TEXT NOT NULL,
  n         INTEGER NOT NULL,
  PRIMARY KEY (game, played_on)
);

-- Sync position in each game's leaderboard table.
CREATE TABLE IF NOT EXISTS cursors (
  game       TEXT PRIMARY KEY,
  last_rowid INTEGER NOT NULL,
  synced_at  TEXT NOT NULL
);

-- One rating per (game, puzzle day, rater). rater is a random id kept in the player's browser (jgg:rater).
CREATE TABLE IF NOT EXISTS ratings (
  game       TEXT NOT NULL,
  day_key    TEXT NOT NULL,
  rater      TEXT NOT NULL,
  stars      REAL NOT NULL CHECK (stars >= 0 AND stars <= 5),
  message    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (game, day_key, rater)
);
CREATE INDEX IF NOT EXISTS ratings_recent ON ratings (updated_at DESC);

-- Running rating totals per game, so the hub's stats never scan ratings.
CREATE TABLE IF NOT EXISTS rating_totals (
  game  TEXT PRIMARY KEY,
  votes INTEGER NOT NULL,
  stars REAL NOT NULL
);

-- The hub page's stats, recomputed by the cron and after a rating.
CREATE TABLE IF NOT EXISTS stats_cache (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  json        TEXT NOT NULL,
  computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plays_by_day ON plays (game, played_on);
