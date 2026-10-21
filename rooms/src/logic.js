// Pure room logic, shared by the Room Durable Object and the unit tests. No I/O here.

// Room codes: 4 characters with nothing that reads as another (no 0/O, 1/I/L).
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;

export function makeCode(random = Math.random) {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return s;
}

// Accepts what people type: any case, stray spaces. Returns the canonical code or null.
export function normalizeCode(input) {
  const s = String(input ?? '').toUpperCase().replace(/\s+/g, '');
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

export function cleanNickname(n) {
  return String(n ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

// Live colour rows from a word game (docs/room-contract.md): at most 8 rows of g/y/x, 8 tiles each, so a row can
// never carry letters. Anything else is dropped (undefined), not trimmed.
export function cleanRows(rows) {
  if (!Array.isArray(rows) || rows.length > 8) return undefined;
  return rows.every((r) => typeof r === 'string' && /^[gyx]{1,8}$/.test(r)) ? [...rows] : undefined;
}

// A boost of 10 means +10%. Clamped to 0..100 so a typo can't hand someone 1000%.
export function applyHandicap(score, boostPct = 0) {
  const b = Math.min(100, Math.max(0, Number(boostPct) || 0));
  return (score * (100 + b)) / 100; // not score * 1.1, which gives 55.00000000000001
}

// Rank points for one round. results: [{ slot, score }] for players who finished (locked in).
// 1st 5, 2nd 3, 3rd 2, everyone else who finished 1. Ties share the better place ("competition ranking"):
// two tied firsts both get 5 and the next player is 3rd (2 points). Returns Map slot -> points.
export const RANK_POINTS = [5, 3, 2];
export function rankPoints(results) {
  const sorted = [...results].sort((a, b) => b.score - a.score);
  const out = new Map();
  let place = 0;
  sorted.forEach((r, i) => {
    if (i === 0 || r.score !== sorted[i - 1].score) place = i; // same score keeps the previous place
    out.set(r.slot, RANK_POINTS[place] ?? 1);
  });
  return out;
}

// Plausibility: flag, never reject. maxScore / minSec come from the host's pick (the game's own round descriptor).
export function plausibility({ score, lockedAt, startsAt, maxScore, minSec }) {
  const flags = [];
  if (!Number.isFinite(score)) flags.push('not-a-number');
  else {
    if (score < 0) flags.push('negative');
    if (Number.isFinite(maxScore) && score > maxScore) flags.push('over-max');
  }
  if (lockedAt < startsAt) flags.push('before-start');
  else if (Number.isFinite(minSec) && lockedAt - startsAt < minSec * 1000) flags.push('too-fast');
  return flags;
}

// Reconnect: the same token always gets the same slot back (scores live on the slot). A new token gets the next
// free slot number, or null if the room is full for that role. Mutates and returns state.players.
export function claimSlot(state, token, { nickname, role, capacity }) {
  const existing = state.players.find((p) => p.token === token);
  if (existing) { if (nickname) existing.nickname = nickname; return existing; }
  if (role === 'player' && state.players.filter((p) => p.role === 'player').length >= capacity) return null;
  const slot = state.players.reduce((m, p) => Math.max(m, p.slot), -1) + 1;
  const p = { slot, token, nickname: nickname || `Player ${slot + 1}`, role, total: 0, rounds: 0 };
  state.players.push(p);
  return p;
}

// Seeds for "random fresh" rounds: a 32-bit number, not tied to any date.
export function makeSeed(random = Math.random) {
  return Math.floor(random() * 2 ** 32) >>> 0;
}
