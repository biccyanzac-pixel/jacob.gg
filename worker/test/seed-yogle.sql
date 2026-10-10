-- Minimal copy of a "results"-style leaderboard with several attempts per player (Yogle) for the local sync test.
DROP TABLE IF EXISTS results;
CREATE TABLE results (id TEXT PRIMARY KEY, player_id TEXT, day_key TEXT, is_late INTEGER, submitted_at TEXT);
INSERT INTO results VALUES ('r1', 'y1', '2026-10-01', 0, '2026-10-01T08:00:00Z');
INSERT INTO results VALUES ('r2', 'y1', '2026-10-01', 0, '2026-10-01T08:05:00Z');
INSERT INTO results VALUES ('r3', 'y2', '2026-10-03', 0, '2026-10-03T08:05:00Z');
