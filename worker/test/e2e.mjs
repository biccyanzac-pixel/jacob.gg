// API checks against a local hub worker:
//   cd worker && rm -rf .wrangler && npm run db:seed:local && npm run dev:local   (then, in another shell)  npm test
// The seed puts 3 Perceptle rows (2 players on day 1, 1 archive replay) and 3 Yogle rows (2 attempts by one player).
const BASE = process.argv[2] || 'http://127.0.0.1:8831';
const ORIGIN = 'http://localhost:8083';
const AUTH = { Authorization: 'Basic ' + btoa('admin:test') };
let failures = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };

async function call(path, body, headers = {}) {
  const res = await fetch(BASE + path, body === undefined ? { headers: { Origin: ORIGIN, ...headers } }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* html/csv */ }
  return { status: res.status, data, text, headers: res.headers };
}

const today = new Date().toISOString().slice(0, 10);
const rater = crypto.randomUUID();

// sync via the cron, twice (the second run must add nothing)
await fetch(BASE + '/__scheduled?cron=*/10+*+*+*+*');
await new Promise((r) => setTimeout(r, 1500));
let r = await call('/admin/sync', undefined, AUTH);
check('second sync adds nothing', r.status === 200 && r.data.perceptle === 0 && r.data.yogle === 0, r.text);

r = await call('/api/stats');
const g = (id) => r.data.games.find((x) => x.id === id);
check('stats: perceptle has 3 plays', g('perceptle')?.plays.all === 3, JSON.stringify(g('perceptle')));
check('stats: yogle attempts count once per player per day', g('yogle')?.plays.all === 2, JSON.stringify(g('yogle')));
check('stats: total', r.data.plays.all === 5);
check('stats: unbound/missing games are zero, not errors', g('factle')?.plays.all === 0);
check('stats: CORS for the hub origin', r.headers.get('access-control-allow-origin') === ORIGIN);
check('stats: busier game ranks first', r.data.games[0].id === 'perceptle', r.data.games.map((x) => x.id).join(','));

r = await call('/api/rate', { game: 'perceptle', day: today, rater, stars: 3.7 });
check('rate: rejects non-half stars', r.status === 400 && r.data.error === 'bad_stars');
r = await call('/api/rate', { game: 'nope', day: today, rater, stars: 3 });
check('rate: rejects unknown game', r.status === 400 && r.data.error === 'bad_game');
r = await call('/api/rate', { game: 'perceptle', day: '2099-01-01', rater, stars: 3 });
check('rate: rejects future day', r.status === 400 && r.data.error === 'bad_day');
r = await call('/api/rate', { game: 'perceptle', day: today, rater, stars: 4.5, message: 'x'.repeat(501) });
check('rate: rejects long message', r.status === 400 && r.data.error === 'bad_message');

r = await call('/api/rate', { game: 'perceptle', day: today, rater, stars: 4.5, message: '  Loved the angles one  ' });
check('rate: ok', r.status === 200 && r.data.mine.stars === 4.5 && r.data.mine.message === 'Loved the angles one', r.text);
check('rate: day average', r.data.day.votes === 1 && r.data.day.avg === 4.5);
r = await call('/api/rate', { game: 'perceptle', day: today, rater, stars: 2, message: '' });
check('re-rate replaces, empty message is null', r.status === 200 && r.data.day.votes === 1 && r.data.day.avg === 2 && r.data.mine.message === null);
await call('/api/rate', { game: 'perceptle', day: today, rater: crypto.randomUUID(), stars: 0 });

r = await call(`/api/rating?game=perceptle&day=${today}&rater=${rater}`);
check('rating: mine + day', r.data.mine?.stars === 2 && r.data.day.votes === 2 && r.data.day.avg === 1, r.text);
r = await call(`/api/rating?game=perceptle&day=${today}`);
check('rating: no rater', r.data.mine === null && r.data.day.votes === 2);

await new Promise((res) => setTimeout(res, 500));
r = await call('/api/stats');
check('stats: rating totals follow re-rates', g('perceptle')?.rating.votes === 2 && g('perceptle')?.rating.avg === 1, JSON.stringify(g('perceptle')));

r = await call('/admin');
check('admin: needs password', r.status === 401);
r = await call('/admin', undefined, { Authorization: 'Basic ' + btoa('admin:wrong') });
check('admin: wrong password', r.status === 401);
r = await call('/admin?game=perceptle', undefined, AUTH);
check('admin: page', r.status === 200 && r.text.includes('jacob.gg admin') && r.text.includes(today));
await call('/api/rate', { game: 'yogle', day: today, rater, stars: 5, message: '<script>alert(1)</script>' });
r = await call('/admin', undefined, AUTH);
check('admin: messages escaped', r.text.includes('&lt;script&gt;') && !r.text.includes('<script>alert'));
r = await call('/admin/ratings.csv', undefined, AUTH);
check('admin: csv', r.status === 200 && r.text.startsWith('game,day,weekday,stars') && r.text.split('\r\n').length === 4);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
