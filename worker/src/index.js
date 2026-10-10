/**
 * jacob.gg hub: Cloudflare Worker + D1.
 *
 *   - Plays: every 10 minutes (cron) it copies new rows from each game's own leaderboard D1 (bound read-only by
 *     convention, see sources.js) into `plays`. History came along on the first run, so nothing was backfilled by
 *     hand. A play is one player on one puzzle day of one game, whatever the number of attempts.
 *   - Ratings: the shared kit (../kit/jgg.js) posts 0-5 stars in half steps plus an optional message, one per
 *     rater per game per puzzle day (re-rating replaces it).
 *   - GET /api/stats feeds the hub page: plays today / last 7 days / all time, ratings and a combined rank.
 *   - /admin (HTTP Basic auth, password = ADMIN_PASSWORD secret): ratings and messages per game and day, CSV export.
 */
import manifest from '../../games.json';
import { PAGE, SOURCES } from './sources.js';

const GAMES = manifest.games.map((g) => g.id);
const MAX_MESSAGE = 500;
const PRIOR_VOTES = 5;     // Bayesian rating: every game starts with 5 imaginary votes at the prior mean
const PRIOR_MEAN = 3.5;
const PAGES_PER_RUN = 3;   // per game per sync, keeps one run well under D1's per-invocation query limit

const todayKey = (d = new Date()) => d.toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const validDayKey = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

// --- HTTP plumbing (same shape as the games' workers) ---

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.length) return '*';
  return allowed.includes(origin) ? origin : allowed[0];
}

function cors(request, env) {
  return {
    'Access-Control-Allow-Origin': allowedOrigin(request, env),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(request, env, body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(request, env), ...extra } });
}

const fail = (request, env, code, message, status) => json(request, env, { error: code, message }, status);

const hits = new Map(); // in-memory, per isolate: enough to blunt a burst
function rateLimited(ip, bucket, limit) {
  const now = Date.now(), key = `${bucket}:${ip}`;
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 3600_000);
  const over = recent.length >= limit;
  if (!over) recent.push(now);
  hits.set(key, recent);
  return over;
}

// --- plays sync ---

export async function sync(env) {
  const report = {};
  const cursors = new Map((await env.DB.prepare('SELECT game, last_rowid FROM cursors').all()).results.map((r) => [r.game, r.last_rowid]));
  for (const [game, src] of Object.entries(SOURCES)) {
    const db = env[src.binding];
    if (!db) { report[game] = 'not bound'; continue; }
    let cursor = cursors.get(game) ?? 0, added = 0;
    try {
      for (let page = 0; page < PAGES_PER_RUN; page++) {
        const rows = (await db.prepare(src.sql).bind(cursor).all()).results;
        if (!rows.length) break;
        const plays = rows
          .filter((r) => r.player && validDayKey(r.day_key))
          .map((r) => ({ d: r.day_key, p: String(r.player), o: r.is_late && validDayKey(String(r.at).slice(0, 10)) ? String(r.at).slice(0, 10) : r.day_key }));
        const days = [...new Set(plays.map((p) => p.o))];
        cursor = rows[rows.length - 1].rid;
        const [ins] = await env.DB.batch([
          env.DB.prepare(`INSERT OR IGNORE INTO plays (game, day_key, player, played_on)
            SELECT ?1, j.value ->> 'd', j.value ->> 'p', j.value ->> 'o' FROM json_each(?2) j`).bind(game, JSON.stringify(plays)),
          env.DB.prepare(`INSERT INTO daily_counts (game, played_on, n)
            SELECT game, played_on, COUNT(*) FROM plays WHERE game = ?1 AND played_on IN (SELECT value FROM json_each(?2))
            GROUP BY game, played_on
            ON CONFLICT (game, played_on) DO UPDATE SET n = excluded.n`).bind(game, JSON.stringify(days)),
          env.DB.prepare(`INSERT INTO cursors (game, last_rowid, synced_at) VALUES (?1, ?2, ?3)
            ON CONFLICT (game) DO UPDATE SET last_rowid = excluded.last_rowid, synced_at = excluded.synced_at`)
            .bind(game, cursor, new Date().toISOString()),
        ]);
        added += ins.meta.changes;
        if (rows.length < PAGE) break;
      }
      report[game] = added;
    } catch (e) {
      report[game] = `error: ${e.message}`; // one game's schema change must not stop the others
    }
  }
  return report;
}

// --- stats ---

export function rank(games) {
  const maxPlays = Math.max(1, ...games.map((g) => g.plays.all));
  for (const g of games) {
    g.rating.bayes = (PRIOR_VOTES * PRIOR_MEAN + g.rating.sum) / (PRIOR_VOTES + g.rating.votes);
    g.score = 0.5 * (g.plays.all / maxPlays) + 0.5 * (g.rating.bayes / 5);
  }
  return [...games].sort((a, b) => b.score - a.score || b.plays.all - a.plays.all || GAMES.indexOf(a.id) - GAMES.indexOf(b.id));
}

export async function computeStats(env) {
  const today = todayKey(), weekStart = addDays(today, -6);
  const [counts, totals] = await env.DB.batch([
    env.DB.prepare(`SELECT game, SUM(n) AS total,
        SUM(CASE WHEN played_on = ?1 THEN n ELSE 0 END) AS today,
        SUM(CASE WHEN played_on >= ?2 AND played_on <= ?1 THEN n ELSE 0 END) AS week
      FROM daily_counts GROUP BY game`).bind(today, weekStart),
    env.DB.prepare('SELECT game, votes, stars FROM rating_totals'),
  ]);
  const c = new Map(counts.results.map((r) => [r.game, r]));
  const t = new Map(totals.results.map((r) => [r.game, r]));
  const games = rank(GAMES.map((id) => {
    const p = c.get(id), r = t.get(id);
    const votes = r?.votes ?? 0, sum = r?.stars ?? 0;
    return {
      id,
      plays: { today: p?.today ?? 0, week: p?.week ?? 0, all: p?.total ?? 0 },
      rating: { votes, sum, avg: votes ? Math.round((sum / votes) * 100) / 100 : null },
    };
  }));
  const sumOf = (k) => games.reduce((a, g) => a + g.plays[k], 0);
  const stats = {
    computedAt: new Date().toISOString(),
    today,
    plays: { today: sumOf('today'), week: sumOf('week'), all: sumOf('all') },
    games: games.map((g) => ({ ...g, rating: { avg: g.rating.avg, votes: g.rating.votes, bayes: Math.round(g.rating.bayes * 100) / 100 }, score: Math.round(g.score * 1000) / 1000 })),
  };
  await env.DB.prepare(`INSERT INTO stats_cache (id, json, computed_at) VALUES (1, ?1, ?2)
    ON CONFLICT (id) DO UPDATE SET json = excluded.json, computed_at = excluded.computed_at`).bind(JSON.stringify(stats), stats.computedAt).run();
  return stats;
}

async function handleStats(request, env) {
  const row = await env.DB.prepare('SELECT json FROM stats_cache WHERE id = 1').first();
  const stats = row ? JSON.parse(row.json) : await computeStats(env);
  return json(request, env, stats, 200, { 'Cache-Control': 'public, max-age=60' });
}

// --- ratings ---

const validRater = (s) => typeof s === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(s);

function cleanMessage(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const m = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if ([...m].length > MAX_MESSAGE) return undefined;
  return m || null;
}

async function dayAverage(env, game, day) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS votes, AVG(stars) AS avg FROM ratings WHERE game = ?1 AND day_key = ?2').bind(game, day).first();
  return { votes: r?.votes ?? 0, avg: r?.votes ? Math.round(r.avg * 100) / 100 : null };
}

async function handleRate(request, env, ctx, ip) {
  if (rateLimited(ip, 'rate', 120)) return fail(request, env, 'rate_limited', 'Too many ratings from here. Try again later.', 429);
  let body;
  try { body = await request.json(); } catch { return fail(request, env, 'bad_json', 'Expected JSON.', 400); }
  const { game, day, rater, stars } = body || {};
  if (!GAMES.includes(game)) return fail(request, env, 'bad_game', 'Unknown game.', 400);
  if (!validDayKey(day) || day > addDays(todayKey(), 1) || day < '2026-09-01') return fail(request, env, 'bad_day', 'Bad day.', 400);
  if (!validRater(rater)) return fail(request, env, 'bad_rater', 'Bad rater id.', 400);
  if (typeof stars !== 'number' || !(stars >= 0 && stars <= 5) || Math.round(stars * 2) !== stars * 2) {
    return fail(request, env, 'bad_stars', 'Stars must be 0 to 5 in steps of 0.5.', 400);
  }
  const message = cleanMessage(body.message);
  if (message === undefined) return fail(request, env, 'bad_message', `Messages are up to ${MAX_MESSAGE} characters.`, 400);

  const now = new Date().toISOString();
  const old = await env.DB.prepare('SELECT stars FROM ratings WHERE game = ?1 AND day_key = ?2 AND rater = ?3').bind(game, day, rater).first();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO ratings (game, day_key, rater, stars, message, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
      ON CONFLICT (game, day_key, rater) DO UPDATE SET stars = excluded.stars, message = excluded.message, updated_at = excluded.updated_at`)
      .bind(game, day, rater, stars, message, now),
    env.DB.prepare(`INSERT INTO rating_totals (game, votes, stars) VALUES (?1, ?2, ?3)
      ON CONFLICT (game) DO UPDATE SET votes = votes + excluded.votes, stars = stars + excluded.stars`)
      .bind(game, old ? 0 : 1, stars - (old?.stars ?? 0)),
  ]);
  ctx.waitUntil(computeStats(env));
  return json(request, env, { ok: true, mine: { stars, message }, day: await dayAverage(env, game, day) });
}

async function handleRating(request, env, url) {
  const game = url.searchParams.get('game'), day = url.searchParams.get('day'), rater = url.searchParams.get('rater');
  if (!GAMES.includes(game) || !validDayKey(day)) return fail(request, env, 'bad_request', 'Need game and day.', 400);
  const mine = validRater(rater)
    ? await env.DB.prepare('SELECT stars, message FROM ratings WHERE game = ?1 AND day_key = ?2 AND rater = ?3').bind(game, day, rater).first()
    : null;
  return json(request, env, { mine: mine || null, day: await dayAverage(env, game, day) });
}

// --- admin ---

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function authorised(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const h = request.headers.get('Authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  let pass = '';
  try { pass = atob(h.slice(6)).split(':').slice(1).join(':'); } catch { return false; }
  return (await sha256Hex(pass)) === (await sha256Hex(env.ADMIN_PASSWORD));
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const wd = (day) => WEEKDAYS[new Date(day + 'T00:00:00Z').getUTCDay()];
const stars = (n) => (n === null || n === undefined ? '–' : Number(n).toFixed(2));

async function adminPage(env, url) {
  const game = GAMES.includes(url.searchParams.get('game')) ? url.searchParams.get('game') : '';
  const day = validDayKey(url.searchParams.get('day')) ? url.searchParams.get('day') : '';
  const where = "(?1 = '' OR game = ?1) AND (?2 = '' OR day_key = ?2)";
  const stats = await computeStats(env);
  const [perDay, messages] = await env.DB.batch([
    env.DB.prepare(`SELECT r.game, r.day_key, COUNT(*) AS votes, AVG(r.stars) AS avg,
        SUM(r.message IS NOT NULL) AS msgs, (SELECT COUNT(*) FROM plays p WHERE p.game = r.game AND p.day_key = r.day_key) AS plays
      FROM ratings r WHERE ${where.replace(/game|day_key/g, 'r.$&')} GROUP BY r.game, r.day_key ORDER BY r.day_key DESC, r.game LIMIT 400`).bind(game, day),
    env.DB.prepare(`SELECT game, day_key, stars, message, updated_at FROM ratings
      WHERE message IS NOT NULL AND ${where} ORDER BY updated_at DESC LIMIT 500`).bind(game, day),
  ]);
  const link = (g, d) => `?${new URLSearchParams({ ...(g && { game: g }), ...(d && { day: d }) })}`;
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>jacob.gg admin</title><style>
:root{color-scheme:light dark;--b:#8884}body{font:15px/1.45 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:24px 16px}
h1{margin:0 0 4px}h2{margin:28px 0 8px}table{border-collapse:collapse;width:100%}th,td{padding:5px 8px;border-bottom:1px solid var(--b);text-align:left;vertical-align:top}
th{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;opacity:.7}td.n{text-align:right;font-variant-numeric:tabular-nums}
.msg{white-space:pre-wrap}.muted{opacity:.65}form{display:flex;gap:8px;flex-wrap:wrap;align-items:center}select,input,button{font:inherit;padding:4px 8px}
.wrap{overflow-x:auto}</style></head><body>
<h1>jacob.gg admin</h1>
<p class="muted">Plays sync from each game's leaderboard every 10 minutes. Stats computed ${esc(stats.computedAt)}.
<a href="/admin/ratings.csv">Download all ratings (CSV)</a> · <a href="/admin/sync">Sync plays now</a></p>
<h2>Games (hub order)</h2><div class="wrap"><table><tr><th>Game</th><th>Plays today</th><th>Last 7 days</th><th>All time</th><th>Avg stars</th><th>Votes</th><th>Rank score</th></tr>
${stats.games.map((g) => `<tr><td><a href="${link(g.id, '')}">${esc(g.id)}</a></td><td class="n">${g.plays.today}</td><td class="n">${g.plays.week}</td><td class="n">${g.plays.all}</td><td class="n">${stars(g.rating.avg)}</td><td class="n">${g.rating.votes}</td><td class="n">${g.score}</td></tr>`).join('')}
<tr><th>All</th><th class="n">${stats.plays.today}</th><th class="n">${stats.plays.week}</th><th class="n">${stats.plays.all}</th><th></th><th></th><th></th></tr></table></div>
<h2>Filter</h2><form method="get"><select name="game">${opt('', 'All games', game)}${GAMES.map((g) => opt(g, g, game)).join('')}</select>
<input type="date" name="day" value="${esc(day)}"><button>Show</button> <a href="/admin">Clear</a></form>
<h2>Ratings per game and day</h2><div class="wrap"><table><tr><th>Day</th><th>Game</th><th>Avg stars</th><th>Votes</th><th>Plays</th><th>Messages</th></tr>
${perDay.results.map((r) => `<tr><td><a href="${link(r.game, r.day_key)}">${esc(wd(r.day_key))} ${esc(r.day_key)}</a></td><td>${esc(r.game)}</td><td class="n">${stars(r.avg)}</td><td class="n">${r.votes}</td><td class="n">${r.plays}</td><td class="n">${r.msgs}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No ratings yet.</td></tr>'}
</table></div>
<h2>Messages${game || day ? ` (${esc([game, day].filter(Boolean).join(', '))})` : ''}</h2><div class="wrap"><table><tr><th>When</th><th>Game</th><th>Day</th><th>Stars</th><th>Message</th></tr>
${messages.results.map((r) => `<tr><td class="muted">${esc(r.updated_at.slice(0, 16).replace('T', ' '))}</td><td>${esc(r.game)}</td><td>${esc(r.day_key)}</td><td class="n">${stars(r.stars)}</td><td class="msg">${esc(r.message)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No messages yet.</td></tr>'}
</table></div></body></html>`;
}

async function ratingsCsv(env) {
  const rows = (await env.DB.prepare('SELECT game, day_key, stars, message, created_at, updated_at FROM ratings ORDER BY day_key, game, created_at').all()).results;
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return ['game,day,weekday,stars,message,created_at,updated_at',
    ...rows.map((r) => [r.game, r.day_key, wd(r.day_key), r.stars, r.message, r.created_at, r.updated_at].map(cell).join(','))].join('\r\n');
}

async function handleAdmin(request, env, url) {
  if (!(await authorised(request, env))) {
    return new Response('Password required.', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="jacob.gg admin", charset="UTF-8"' } });
  }
  const headers = { 'Cache-Control': 'no-store' };
  if (url.pathname === '/admin/ratings.csv') {
    return new Response(await ratingsCsv(env), { headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="jacob-gg-ratings.csv"' } });
  }
  if (url.pathname === '/admin/sync') {
    const report = await sync(env);
    await computeStats(env);
    return new Response(JSON.stringify(report, null, 2), { headers: { ...headers, 'Content-Type': 'application/json' } });
  }
  return new Response(await adminPage(env, url), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
}

// --- entry ---

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request, env) });
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    try {
      if (url.pathname === '/api/stats' && request.method === 'GET') return await handleStats(request, env);
      if (url.pathname === '/api/rating' && request.method === 'GET') return await handleRating(request, env, url);
      if (url.pathname === '/api/rate' && request.method === 'POST') return await handleRate(request, env, ctx, ip);
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return await handleAdmin(request, env, url);
      if (url.pathname === '/' || url.pathname === '/api/health') return json(request, env, { ok: true, games: GAMES });
      return fail(request, env, 'not_found', 'Not found.', 404);
    } catch (e) {
      console.error(e);
      return fail(request, env, 'server_error', 'Something went wrong.', 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sync(env).then(() => computeStats(env)));
  },
};
