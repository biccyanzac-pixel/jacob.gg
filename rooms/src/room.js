// One live room = one Durable Object (SQLite-backed, the only kind the Free plan allows).
// WebSockets use the Hibernation API, so an idle room costs no duration. Durable state (players, scores, the current
// round, lock-ins) is one storage key written only on real changes; live presence (thinking / progress) is kept in
// memory and in each socket's attachment, so 2 Hz progress updates never write storage.
import { claimSlot, cleanNickname, makeSeed, plausibility, rankPoints, applyHandicap } from './logic.js';

const EXPIRE_MS = 6 * 60 * 60 * 1000;   // 6 hours without activity
const COUNTDOWN_MS = 3000;
const MAX_SPECTATORS = 32;
const MAX_MSG = 16 * 1024;              // bytes; answers are small

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.state = null;        // loaded lazily
    this.presence = new Map(); // slot -> { state: 'thinking'|'locked'|'finished', p, seq }
  }

  async load() {
    if (!this.state) this.state = (await this.ctx.storage.get('room')) ?? null;
    return this.state;
  }
  async save() {
    this.state.lastActive = Date.now();
    await this.ctx.storage.put('room', this.state);
    await this.schedule();
  }
  // One alarm does double duty: the round deadline (reveal) and the 6-hour expiry.
  async schedule() {
    const s = this.state, times = [s.lastActive + EXPIRE_MS];
    if (s.phase === 'countdown' || s.phase === 'playing') times.push(s.round.endsAt);
    await this.ctx.storage.setAlarm(Math.min(...times));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/init') {
      if (await this.load()) return Response.json({ error: 'taken' }, { status: 409 });
      const { code, hostToken, capacity } = await request.json();
      this.state = { code, hostToken, capacity: capacity || 16, scoring: 'rank', handicaps: {}, phase: 'lobby',
        round: null, roundNo: 0, players: [], lockins: {}, history: [], created: Date.now(), lastActive: Date.now() };
      await this.save();
      return Response.json({ ok: true });
    }
    if (url.pathname === '/exists') return Response.json({ exists: !!(await this.load()) && this.state.phase !== 'ended' });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (!(await this.load()) || this.state.phase === 'ended') return new Response('no such room', { status: 404 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ token: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- messaging ----
  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch { /* closed */ } }
  broadcast(msg) { const s = JSON.stringify(msg); for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch {} } }
  connectedTokens() { return new Set(this.ctx.getWebSockets().map((w) => w.deserializeAttachment()?.token).filter(Boolean)); }
  player(token) { return this.state.players.find((p) => p.token === token); }

  snapshot() {
    const s = this.state, online = this.connectedTokens();
    return {
      code: s.code, phase: s.phase, capacity: s.capacity, scoring: s.scoring, handicaps: s.handicaps, roundNo: s.roundNo,
      round: s.round && { ...s.round },
      players: s.players.map((p) => ({ slot: p.slot, nickname: p.nickname, role: p.role, total: p.total, rounds: p.rounds,
        online: online.has(p.token), host: p.token === s.hostToken,
        presence: this.presence.get(p.slot) ?? { state: s.lockins[p.slot] ? 'locked' : 'thinking', p: 0 } })),
      history: s.history.slice(-50),
    };
  }
  pushRoom() { this.broadcast({ t: 'room', room: this.snapshot(), serverNow: Date.now() }); }

  async webSocketMessage(ws, raw) {
    await this.load();
    if (!this.state || this.state.phase === 'ended') return ws.close(4404, 'room closed');
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return this.send(ws, { t: 'error', code: 'too-big' });
    let m; try { m = JSON.parse(raw); } catch { return this.send(ws, { t: 'error', code: 'bad-json' }); }
    const att = ws.deserializeAttachment() ?? {};
    if (m.t === 'hello') return this.hello(ws, m);
    const me = att.token && this.player(att.token);
    if (!me) return this.send(ws, { t: 'error', code: 'say-hello-first' });
    const isHost = me.token === this.state.hostToken;
    switch (m.t) {
      case 'ping': return this.send(ws, { t: 'pong', serverNow: Date.now(), id: m.id });
      case 'progress': return this.progress(me, m);
      case 'lockin': return this.lockin(me, m);
      case 'played': return this.played(me, m);
    }
    if (!isHost) return this.send(ws, { t: 'error', code: 'host-only' });
    switch (m.t) {
      case 'pick': return this.pick(m);
      case 'check': return this.broadcast({ t: 'check', game: String(m.game ?? ''), date: m.date ?? null });
      case 'start': return this.start();
      case 'reveal': return this.reveal('host');
      case 'settings': return this.settings(m);
      case 'kick': return this.kick(m.slot);
      case 'end': return this.end();
      default: return this.send(ws, { t: 'error', code: 'unknown-type' });
    }
  }

  async hello(ws, m) {
    const s = this.state;
    const token = typeof m.token === 'string' && m.token.length >= 16 ? m.token : crypto.randomUUID();
    let role = m.role === 'spectator' ? 'spectator' : 'player';
    if (token === s.hostToken) role = 'player';
    const known = this.player(token);
    if (!known && role === 'spectator' && s.players.filter((p) => p.role === 'spectator').length >= MAX_SPECTATORS)
      { this.send(ws, { t: 'error', code: 'full' }); return ws.close(4409, 'full'); }
    const me = claimSlot(s, token, { nickname: cleanNickname(m.nickname), role: known?.role ?? role, capacity: s.capacity });
    if (!me) { this.send(ws, { t: 'error', code: 'full' }); return ws.close(4409, 'full'); }
    ws.serializeAttachment({ token });
    if (!known || m.nickname) await this.save();
    this.send(ws, { t: 'welcome', you: { slot: me.slot, token, role: me.role, host: token === s.hostToken },
      room: this.snapshot(), lockedIn: !!s.lockins[me.slot], serverNow: Date.now() });
    this.pushRoom();
  }

  progress(me, m) {
    if (this.state.phase !== 'playing' || me.role !== 'player' || this.state.lockins[me.slot]) return;
    const p = Math.min(1, Math.max(0, Number(m.p) || 0)), seq = Number(m.seq) || 0;
    this.presence.set(me.slot, { state: 'thinking', p, seq });
    this.broadcast({ t: 'presence', slot: me.slot, state: 'thinking', p, seq });
  }

  async lockin(me, m) {
    const s = this.state;
    if (s.phase !== 'playing' && s.phase !== 'countdown') return this.send(this.socketOf(me), { t: 'error', code: 'not-playing' });
    if (me.role !== 'player' || s.lockins[me.slot]) return; // locked once; repeats are ignored
    const now = Date.now(), score = Number(m.score);
    const flags = plausibility({ score, lockedAt: now, startsAt: s.round.startsAt, maxScore: s.round.maxScore, minSec: s.round.minSec });
    const payload = JSON.stringify(m.payload ?? null).length <= 8192 ? m.payload ?? null : null;
    s.lockins[me.slot] = { score: Number.isFinite(score) ? score : 0, payload, lockedAt: now, flags };
    this.presence.set(me.slot, { state: 'locked', p: 1, seq: this.presence.get(me.slot)?.seq ?? 0 });
    await this.save();
    this.broadcast({ t: 'presence', slot: me.slot, state: 'locked', p: 1 });
    const players = s.players.filter((p) => p.role === 'player'), online = this.connectedTokens();
    if (players.filter((p) => online.has(p.token)).every((p) => s.lockins[p.slot])) await this.reveal('all-locked');
  }

  played(me, m) {
    if (!m.yes) return;
    const host = this.ctx.getWebSockets().find((w) => w.deserializeAttachment()?.token === this.state.hostToken);
    if (host) this.send(host, { t: 'spoiler', game: m.game, date: m.date, slot: me.slot, nickname: me.nickname });
  }

  async pick(m) {
    const s = this.state;
    if (s.phase === 'countdown' || s.phase === 'playing') return this.broadcastErrorToHost('round-running');
    const mode = ['daily', 'archive', 'random'].includes(m.mode) ? m.mode : 'daily';
    const today = new Date().toISOString().slice(0, 10);
    const date = mode === 'daily' ? today : mode === 'archive' && /^\d{4}-\d\d-\d\d$/.test(m.date) && m.date <= today ? m.date : null;
    if (mode === 'archive' && !date) return this.broadcastErrorToHost('bad-date');
    const durationSec = Math.min(1800, Math.max(10, Math.round(Number(m.durationSec) || 120)));
    s.round = { game: String(m.game ?? '').slice(0, 32), mode, date, seed: mode === 'random' ? makeSeed() : null, durationSec,
      maxScore: Number.isFinite(+m.maxScore) ? +m.maxScore : null, minSec: Number.isFinite(+m.minSec) ? +m.minSec : null,
      startsAt: null, endsAt: null, no: s.roundNo + 1 };
    s.phase = 'picked';
    s.lockins = {};
    this.presence.clear();
    await this.save();
    this.pushRoom();
  }

  async start() {
    const s = this.state;
    if (s.phase !== 'picked') return this.broadcastErrorToHost('pick-first');
    const now = Date.now();
    s.round.startsAt = now + COUNTDOWN_MS;
    s.round.endsAt = s.round.startsAt + s.round.durationSec * 1000;
    s.roundNo = s.round.no;
    s.phase = 'playing'; // lock-ins before startsAt are flagged, not refused
    await this.save();
    this.broadcast({ t: 'countdown', round: s.round, startsAt: s.round.startsAt, endsAt: s.round.endsAt, serverNow: now });
    this.pushRoom();
  }

  async reveal(why) {
    const s = this.state;
    if (s.phase !== 'playing') return; // fires exactly once: the alarm, "all locked" and the host can all race here
    s.phase = 'revealed';
    const finished = s.players.filter((p) => p.role === 'player' && s.lockins[p.slot]);
    const adjusted = finished.map((p) => ({ slot: p.slot, score: applyHandicap(s.lockins[p.slot].score, s.handicaps[p.slot]) }));
    const points = s.scoring === 'raw' ? new Map(adjusted.map((r) => [r.slot, r.score])) : rankPoints(adjusted);
    for (const p of finished) { p.total += points.get(p.slot) ?? 0; p.rounds += 1; }
    const results = finished.map((p) => ({ slot: p.slot, nickname: p.nickname, score: s.lockins[p.slot].score,
      adjusted: adjusted.find((a) => a.slot === p.slot).score, points: points.get(p.slot) ?? 0, payload: s.lockins[p.slot].payload,
      flags: s.lockins[p.slot].flags, lockedAt: s.lockins[p.slot].lockedAt })).sort((a, b) => b.adjusted - a.adjusted);
    s.history.push({ no: s.round.no, game: s.round.game, mode: s.round.mode, date: s.round.date, seed: s.round.seed,
      results: results.map(({ payload, ...r }) => r) });
    await this.save();
    this.broadcast({ t: 'reveal', why, round: s.round, results, serverNow: Date.now() });
    this.pushRoom();
  }

  async settings(m) {
    const s = this.state;
    if (m.capacity != null) s.capacity = Math.min(64, Math.max(2, Math.round(+m.capacity) || 16));
    if (m.scoring === 'rank' || m.scoring === 'raw') s.scoring = m.scoring;
    if (m.handicaps && typeof m.handicaps === 'object')
      for (const [slot, pct] of Object.entries(m.handicaps)) s.handicaps[slot] = Math.min(100, Math.max(0, +pct || 0));
    await this.save();
    this.pushRoom();
  }

  async kick(slot) {
    const s = this.state, p = s.players.find((x) => x.slot === slot);
    if (!p || p.token === s.hostToken) return;
    s.players = s.players.filter((x) => x !== p);
    for (const ws of this.ctx.getWebSockets()) if (ws.deserializeAttachment()?.token === p.token) ws.close(4403, 'removed');
    await this.save();
    this.pushRoom();
  }

  async end() {
    this.state.phase = 'ended';
    await this.ctx.storage.put('room', this.state);
    this.broadcast({ t: 'closed', reason: 'host-ended', history: this.state.history });
    for (const ws of this.ctx.getWebSockets()) ws.close(4000, 'ended');
    await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000); // keep the recap an hour, then tidy up
  }

  async alarm() {
    await this.load();
    if (!this.state) return;
    const now = Date.now();
    if (this.state.phase === 'playing' && now >= this.state.round.endsAt) await this.reveal('time');
    if (this.state.phase === 'ended' || now >= this.state.lastActive + EXPIRE_MS) {
      for (const ws of this.ctx.getWebSockets()) ws.close(4001, 'expired');
      await this.ctx.storage.deleteAll();
      this.state = null;
    }
  }

  webSocketClose(ws) { this.load().then(() => this.state && this.pushRoom()); }
  webSocketError(ws) { this.webSocketClose(ws); }
  socketOf(me) { return this.ctx.getWebSockets().find((w) => w.deserializeAttachment()?.token === me.token); }
  broadcastErrorToHost(code) {
    const host = this.ctx.getWebSockets().find((w) => w.deserializeAttachment()?.token === this.state.hostToken);
    if (host) this.send(host, { t: 'error', code });
  }
}
