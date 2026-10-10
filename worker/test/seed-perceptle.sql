-- Minimal copy of a "totals"-style leaderboard (Perceptle/Factle) for the local sync test.
DROP TABLE IF EXISTS totals;
CREATE TABLE totals (player_id TEXT, day_key TEXT, is_late INTEGER, display_name TEXT, total INTEGER, played INTEGER, rounds TEXT, last_at TEXT, PRIMARY KEY (player_id, day_key, is_late));
INSERT INTO totals VALUES ('p1', '2026-10-01', 0, 'a', 1, 1, '1', '2026-10-01T10:00:00Z');
INSERT INTO totals VALUES ('p2', '2026-10-01', 0, 'b', 1, 1, '1', '2026-10-01T11:00:00Z');
INSERT INTO totals VALUES ('p1', '2026-10-02', 1, 'a', 1, 1, '1', '2026-10-05T09:00:00Z');
