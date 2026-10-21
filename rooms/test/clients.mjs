// Integration test with simulated clients against a local room server:
//   npm run dev -- --var JOIN_LIMIT:200      (another terminal)
//   node test/clients.mjs [http://127.0.0.1:8861]
const BASE = process.argv[2] || 'http://127.0.0.1:8861';
const WS = BASE.replace(/^http/, 'ws');
let fails = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(code, { nickname, token, role } = {}) {
    this.code = code; this.nickname = nickname; this.token = token; this.role = role;
    this.msgs = []; this.waiters = [];
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${WS}/api/rooms/${this.code}/ws`);
      this.ws.onopen = () => this.send({ t: 'hello', nickname: this.nickname, token: this.token, role: this.role });
      this.ws.onerror = (e) => reject(new Error('ws error ' + (e.message || '')));
      this.ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        this.msgs.push(m);
        if (m.t === 'welcome') { this.you = m.you; this.token = m.you.token; this.room = m.room; resolve(this); }
        if (m.t === 'room') this.room = m.room;
        if (m.t === 'check' && this.onCheck) this.onCheck(m);
        this.waiters = this.waiters.filter((w) => !(w.test(m) && (w.resolve(m), true)));
      };
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  wait(test, ms = 8000) {
    const hit = this.msgs.find(test);
    if (hit && !test.fresh) return Promise.resolve(hit);
    return new Promise((resolve, reject) => { const w = { test, resolve }; this.waiters.push(w); setTimeout(() => reject(new Error('timeout')), ms); });
  }
  next(t, ms) { const f = (m) => m.t === t; f.fresh = true; return this.wait(f, ms); }
  count(t) { return this.msgs.filter((m) => m.t === t).length; }
  close() { this.ws.close(); }
}

async function createRoom(capacity) {
  const r = await fetch(`${BASE}/api/rooms`, { method: 'POST', body: JSON.stringify({ capacity }) });
  return r.json();
}

// ---- 8 players, host switches games, one drops and rejoins mid-round, reveal exactly once ----
{
  const { code, hostToken } = await createRoom(16);
  check('create returns a valid code', /^[A-HJKMNP-Z2-9]{4}$/.test(code ?? ''), code);
  const exists = await fetch(`${BASE}/api/rooms/${code.toLowerCase()}`).then((r) => r.json());
  check('code lookup is case-insensitive', exists.exists === true);
  const host = await new Client(code, { nickname: 'Host', token: hostToken }).open();
  check('host is host', host.you.host === true);
  const players = [host];
  for (let i = 1; i < 8; i++) players.push(await new Client(code, { nickname: `P${i}` }).open());
  const spec = await new Client(code, { nickname: 'Watcher', role: 'spectator' }).open();
  await sleep(300);
  check('8 players + 1 spectator in the room', host.room.players.filter((p) => p.role === 'player').length === 8 && host.room.players.some((p) => p.role === 'spectator'));
  check('slots are unique', new Set(players.map((p) => p.you.slot)).size === 8);

  // spoiler check: P2 has played today's Factle
  players[2].onCheck = (m) => players[2].send({ t: 'played', game: m.game, date: m.date, yes: true });
  const today = new Date().toISOString().slice(0, 10);
  host.send({ t: 'check', game: 'factle', date: today });
  const sp = await host.next('spoiler').catch(() => null);
  check('spoiler: a player who played the day is reported to the host', sp?.nickname === 'P2' && sp.game === 'factle', JSON.stringify(sp));

  // non-host can't control
  players[1].send({ t: 'start' });
  check('non-host is refused host controls', (await players[1].next('error'))?.code === 'host-only');

  host.send({ t: 'pick', game: 'pointle', mode: 'daily', durationSec: 60, maxScore: 100 });
  await host.wait((m) => m.t === 'room' && m.room.round?.game === 'pointle');
  host.send({ t: 'pick', game: 'factle', mode: 'archive', date: '2026-10-15', durationSec: 60, maxScore: 500, minSec: 3 });
  const switched = await host.wait((m) => m.t === 'room' && m.room.round?.game === 'factle');
  check('host can switch the picked game before starting', switched.room.round.date === '2026-10-15' && switched.room.phase === 'picked');

  host.send({ t: 'start' });
  const cds = await Promise.all([...players, spec].map((c) => c.next('countdown')));
  check('everyone gets the same countdown', cds.every((c) => c.startsAt === cds[0].startsAt && c.round.game === 'factle'));
  check('countdown is 3 s ahead of the server clock', Math.abs(cds[0].startsAt - cds[0].serverNow - 3000) < 50);

  // P3 drops and rejoins with the same token
  players[3].send({ t: 'progress', p: 0.4, seq: 1 });
  await sleep(200);
  const tok3 = players[3].token, slot3 = players[3].you.slot;
  players[3].close();
  await sleep(300);
  const back = await new Client(code, { nickname: 'P3', token: tok3 }).open();
  check('a rejoining player gets the same slot', back.you.slot === slot3);
  players[3] = back;

  await sleep(Math.max(0, cds[0].startsAt - Date.now()) + 50);
  const scores = [300, 400, 400, 100, 250, 50, 500, 0];
  players.forEach((c, i) => { if (i !== 7) c.send({ t: 'lockin', score: scores[i], payload: { pick: i } }); });
  await sleep(400);
  check('no reveal while someone is still playing', host.count('reveal') === 0);
  players[7].send({ t: 'lockin', score: scores[7], payload: { pick: 7 } });
  const rv = await host.next('reveal');
  await sleep(500);
  check('reveal fires once, for everyone', [...players, spec].every((c) => c.count('reveal') === 1), [...players, spec].map((c) => c.count('reveal')).join(','));
  check('reveal says why: everyone locked in', rv.why === 'all-locked');
  const pts = Object.fromEntries(rv.results.map((r) => [r.nickname, r.points]));
  check('rank points with a tie: 500->5, two 400s->3 each, 300->1', pts.P6 === 5 && pts.P1 === 3 && pts.P2 === 3 && pts.Host === 1, JSON.stringify(pts));
  players[0].send({ t: 'lockin', score: 999 });
  await sleep(300);
  check('a late or repeated lock-in changes nothing', host.count('reveal') === 1);

  // round 2: random seed, host forces reveal; P3's total survives another reconnect
  host.send({ t: 'pick', game: 'stratle', mode: 'random', durationSec: 60, maxScore: 500 });
  const r2 = await host.wait((m) => m.t === 'room' && m.room.round?.no === 2);
  check('random rounds get a server seed', Number.isInteger(r2.room.round.seed) && r2.room.round.date === null);
  host.send({ t: 'start' });
  await host.next('countdown');
  await sleep(3100);
  players[1].send({ t: 'lockin', score: 600 }); // over max -> flagged, not refused
  await sleep(200);
  host.send({ t: 'reveal' });
  const rv2 = await host.next('reveal');
  check('host can force the reveal', rv2.why === 'host' && rv2.results.length === 1);
  check('implausible scores are flagged, not refused', rv2.results[0].flags.includes('over-max'));
  const total3 = host.room.players.find((p) => p.slot === slot3).total;
  players[3].close(); await sleep(200);
  const back2 = await new Client(code, { token: tok3 }).open();
  check('scores survive a reconnect', back2.room.players.find((p) => p.slot === slot3).total === total3 && total3 > 0, String(total3));

  // round 3: nobody locks in, the timer fires the reveal (exactly once)
  host.send({ t: 'pick', game: 'yogle', mode: 'daily', durationSec: 10 });
  await host.wait((m) => m.t === 'room' && m.room.round?.no === 3);
  host.send({ t: 'start' });
  const rv3 = await host.next('reveal', 20000).catch(() => null);
  await sleep(1500);
  check('the timer fires the reveal when time runs out', rv3?.why === 'time', rv3?.why);
  check('reveal count after 3 rounds is 3 everywhere', [host, players[1], spec].every((c) => c.count('reveal') === 3));
  host.send({ t: 'end' });
  check('host can end the room', (await players[1].next('closed').catch(() => null))?.reason === 'host-ended');
  [...players, spec, back2].forEach((c) => { try { c.close(); } catch {} });
}

// ---- load: 16 players, progress at 2 Hz for 10 s, nothing dropped ----
{
  const { code, hostToken } = await createRoom(16);
  const host = await new Client(code, { nickname: 'Host', token: hostToken }).open();
  const ps = [host];
  for (let i = 1; i < 16; i++) ps.push(await new Client(code, { nickname: `L${i}` }).open());
  host.send({ t: 'pick', game: 'perceptle', mode: 'random', durationSec: 120 });
  await host.wait((m) => m.t === 'room' && m.room.round);
  host.send({ t: 'start' });
  await host.next('countdown');
  await sleep(3100);
  const sent = new Map();
  for (let tick = 1; tick <= 20; tick++) {
    ps.forEach((c) => { c.send({ t: 'progress', p: tick / 20, seq: tick }); sent.set(c.you.slot, tick); });
    await sleep(500);
  }
  await sleep(1500);
  const last = new Map();
  for (const m of host.msgs) if (m.t === 'presence' && m.seq) last.set(m.slot, Math.max(last.get(m.slot) ?? 0, m.seq));
  const recv = host.msgs.filter((m) => m.t === 'presence').length;
  check('16 players x 2 Hz x 10 s: every update reached the host', [...sent].every(([s, n]) => last.get(s) === n) && recv >= 16 * 20, `${recv} presence messages`);
  host.send({ t: 'end' });
  await sleep(300);
  ps.forEach((c) => c.close());
}

// ---- capacity and rate limiting ----
{
  const { code, hostToken } = await createRoom(2);
  const h = await new Client(code, { token: hostToken }).open();
  await new Client(code, { nickname: 'A' }).open();
  const full = new Client(code, { nickname: 'B' });
  const err = await Promise.race([full.open().then(() => 'joined'), new Promise((r) => setTimeout(() => r(full.msgs.find((m) => m.t === 'error')?.code), 2000))]);
  check('a full room turns a new player away', err === 'full', String(err));
  h.send({ t: 'end' });
  const bad = await fetch(`${BASE}/api/rooms/OOOO`);
  check('a code with confusable characters is rejected', bad.status === 404);
  let limited = false;
  for (let i = 0; i < 260 && !limited; i++) limited = (await fetch(`${BASE}/api/rooms/ZZZZ`)).status === 429;
  check('join attempts are rate-limited per IP', limited);
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
