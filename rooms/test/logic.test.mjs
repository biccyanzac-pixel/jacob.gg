import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_ALPHABET, makeCode, normalizeCode, rankPoints, applyHandicap, claimSlot, plausibility, cleanNickname } from '../src/logic.js';

test('codes use only unambiguous characters and are 4 long', () => {
  for (const ch of '0O1IL') assert.ok(!CODE_ALPHABET.includes(ch), ch);
  for (let i = 0; i < 2000; i++) { const c = makeCode(); assert.equal(c.length, 4); assert.equal(normalizeCode(c), c); }
});

test('code validation accepts what people type and rejects the rest', () => {
  assert.equal(normalizeCode(' ab 2c'), 'AB2C');
  assert.equal(normalizeCode('abc'), null);
  assert.equal(normalizeCode('AB0C'), null); // 0 isn't in the alphabet
  assert.equal(normalizeCode('ABCDE'), null);
  assert.equal(normalizeCode(null), null);
});

test('rank points: 5/3/2 then 1 for finishing', () => {
  const p = rankPoints([{ slot: 0, score: 10 }, { slot: 1, score: 80 }, { slot: 2, score: 50 }, { slot: 3, score: 30 }, { slot: 4, score: 5 }]);
  assert.deepEqual([1, 2, 3, 0, 4].map((s) => p.get(s)), [5, 3, 2, 1, 1]);
});

test('rank points: ties share the better place, the next player skips', () => {
  const p = rankPoints([{ slot: 0, score: 90 }, { slot: 1, score: 90 }, { slot: 2, score: 70 }, { slot: 3, score: 70 }, { slot: 4, score: 10 }]);
  assert.deepEqual([0, 1, 2, 3, 4].map((s) => p.get(s)), [5, 5, 2, 2, 1]);
  assert.deepEqual([...rankPoints([{ slot: 7, score: 0 }])], [[7, 5]]);
  assert.equal(rankPoints([]).size, 0);
});

test('handicap: a percentage boost, clamped to 0..100', () => {
  assert.equal(applyHandicap(50, 10), 55);
  assert.equal(applyHandicap(50, 0), 50);
  assert.equal(applyHandicap(50, 250), 100);
  assert.equal(applyHandicap(50, -20), 50);
  assert.equal(applyHandicap(50, 'abc'), 50);
});

test('reconnect: the same token gets the same slot and scores back; capacity holds', () => {
  const state = { players: [] };
  const a = claimSlot(state, 'tok-a', { nickname: 'Ann', role: 'player', capacity: 2 });
  const b = claimSlot(state, 'tok-b', { nickname: 'Bob', role: 'player', capacity: 2 });
  a.total = 12;
  assert.equal(claimSlot(state, 'tok-c', { nickname: 'Cy', role: 'player', capacity: 2 }), null); // full
  const back = claimSlot(state, 'tok-a', { nickname: '', role: 'player', capacity: 2 });
  assert.equal(back.slot, a.slot); assert.equal(back.total, 12); assert.equal(back.nickname, 'Ann');
  assert.equal(claimSlot(state, 'tok-s', { nickname: 'Sam', role: 'spectator', capacity: 2 }).slot, 2); // spectators don't count
  assert.notEqual(a.slot, b.slot);
});

test('plausibility flags but never decides', () => {
  assert.deepEqual(plausibility({ score: 50, lockedAt: 20e3, startsAt: 0, maxScore: 100, minSec: 5 }), []);
  assert.deepEqual(plausibility({ score: 150, lockedAt: 20e3, startsAt: 0, maxScore: 100, minSec: 5 }), ['over-max']);
  assert.deepEqual(plausibility({ score: 50, lockedAt: 1e3, startsAt: 0, maxScore: 100, minSec: 5 }), ['too-fast']);
  assert.deepEqual(plausibility({ score: 50, lockedAt: -5, startsAt: 0 }), ['before-start']);
});

test('nicknames are trimmed, de-controlled and capped at 20', () => {
  assert.equal(cleanNickname('  Jo \n  Bloggs\u0007 '), 'Jo Bloggs');
  assert.equal(cleanNickname('W'.repeat(40)).length, 20);
});
