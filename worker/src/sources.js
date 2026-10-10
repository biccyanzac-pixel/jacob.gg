// Where each game's plays come from: its own leaderboard D1, bound to this worker in wrangler.toml.
// One row per (game, puzzle day, player) is a play. The sync reads only rows added since the last run
// (rowid > cursor), so it costs a handful of D1 reads however big the leaderboards get.
//
// Each query gets the cursor as ?1 and must return: rid (rowid), player, day_key, is_late, at (ISO time).
// If a game changes its leaderboard table, change its query here and redeploy (see ../../PLAYBOOK.md).

const LIMIT = 1000;
const q = (table, at) =>
  `SELECT rowid AS rid, player_id AS player, day_key, is_late, ${at} AS at FROM ${table} WHERE rowid > ?1 ORDER BY rowid LIMIT ${LIMIT}`;

export const PAGE = LIMIT;

export const SOURCES = {
  'ridd-le':   { binding: 'DB_RIDDLE',    sql: q('submissions', 'submitted_at') },
  yogle:       { binding: 'DB_YOGLE',     sql: q('results', 'submitted_at') },
  predictle:   { binding: 'DB_PREDICTLE', sql: q('results', 'submitted_at') },
  pointle:     { binding: 'DB_POINTLE',   sql: q('results', 'submitted_at') },
  factle:      { binding: 'DB_FACTLE',    sql: q('totals', 'last_at') },   // one row per player per day, made at the first pick
  perceptle:   { binding: 'DB_PERCEPTLE', sql: q('totals', 'last_at') },
};
