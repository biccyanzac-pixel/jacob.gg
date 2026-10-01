/**
 * Production verification. Identical assertions to worker/test/e2e.mjs, run
 * against the real deployed Cloudflare Worker + D1 instead of local
 * Miniflare - genuine public HTTP requests, no mocking.
 *
 *   node test/production-check.mjs https://jacob-gg-leaderboard.jacob-gg-leaderboard-worker.workers.dev
 *
 * Uses CORS preflight-equivalent requests with the production ALLOWED_ORIGIN
 * header so the check exercises the same cross-origin path the real browser
 * frontend uses.
 */
const BASE = process.argv[2];
if (!BASE) {
  console.error("usage: node test/production-check.mjs <worker-url>");
  process.exit(1);
}

const ORIGIN = "https://biccyanzac-pixel.github.io";

const { answerHash, normalizeAnswer } = await import(
  "file:///C:/Users/jacobp/Desktop/jacob.gg/shared/normalize.js"
);
const { challengeForDay, scoreFromNoul, previousDayKey } = await import(
  "file:///C:/Users/jacobp/Desktop/jacob.gg/shared/challenges.js"
);

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures += 1;
}

async function call(path, options) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...(options?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, body };
}

async function session() {
  const r = await call("/api/session", { method: "POST", body: "{}" });
  return r.body;
}

async function play(challenge, playerId, token, name, answer, noul) {
  const normalized = normalizeAnswer(answer);
  const hash = await answerHash({
    challengeId: challenge.id,
    scoringVersion: challenge.scoringVersion,
    normalizedAnswer: normalized,
  });
  const score = scoreFromNoul(noul);
  return call("/api/play", {
    method: "POST",
    body: JSON.stringify({
      playerId,
      token,
      challengeId: challenge.id,
      dayKey: challenge.dayKey,
      scoringVersion: challenge.scoringVersion,
      name,
      answer,
      normalizedAnswer: normalized,
      answerHash: hash,
      noul,
      score,
      model: "kev-0.6b/q4",
    }),
  });
}

async function leaderboard(challengeId, playerId) {
  const q = new URLSearchParams({ challengeId, ...(playerId ? { playerId } : {}) });
  return call(`/api/leaderboard?${q}`, { method: "GET" });
}

const today = challengeForDay();
console.log(`target: ${BASE}`);
console.log(`today's challenge: ${today.id}\n`);

// === CORS: the configured origin is honoured =========================
const corsCheck = await call("/api/leaderboard?challengeId=cors-probe", { method: "GET" });
check(
  "CORS header allows the production frontend origin",
  corsCheck.headers.get("access-control-allow-origin") === ORIGIN ||
    corsCheck.headers.get("access-control-allow-origin") === "*",
  corsCheck.headers.get("access-control-allow-origin"),
);

// === session creation ========================================================
const a = await session();
check("POST /api/session works against the public Worker", Boolean(a?.playerId && a?.token));

// === three attempts, 4th rejected ===========================================
const a1 = await play(today, a.playerId, a.token, "ProdCheckA", "a room", 0.7241);
check("attempt 1 accepted in production", a1.status === 200, `score=${a1.body?.result?.score}`);

const a2 = await play(today, a.playerId, a.token, "ProdCheckA", "a competition", 0.9183);
check("attempt 2 accepted in production", a2.status === 200 && a2.body.result.attemptNumber === 2);

const a3 = await play(today, a.playerId, a.token, "ProdCheckA", "a conversation", 0.8426);
check("attempt 3 accepted in production", a3.status === 200 && a3.body.result.attemptNumber === 3);

const a4 = await play(today, a.playerId, a.token, "ProdCheckA", "one more", 0.99);
check(
  "attempt 4 rejected in production (max_attempts)",
  a4.status === 409 && a4.body?.error === "max_attempts",
);

const expectedAvg = (72.41 + 91.83 + 84.26) / 3;
const boardAfterA = await leaderboard(today.id, a.playerId);
const aRow = boardAfterA.body.top.find((r) => r.name === "ProdCheckA");
check(
  "production leaderboard shows the AVERAGE of 3 attempts, not the max",
  aRow && Math.abs(aRow.score - expectedAvg) < 0.01 && aRow.score < 91.83,
  `got ${aRow?.score}, expected ~${expectedAvg.toFixed(2)}`,
);

// === second independent player sees the same leaderboard ===================
const b = await session();
check("second production session created", Boolean(b?.playerId && b?.token));

const b1 = await play(today, b.playerId, b.token, "ProdCheckB", "a password", 0.95);
check("player B attempt 1 accepted in production", b1.status === 200);

const boardMidB = await leaderboard(today.id, b.playerId);
check(
  "before B's 3rd attempt, other players' (A's) answer text is withheld in production",
  boardMidB.body.top.every((r) => r.answer === null || r.you === true),
  JSON.stringify(boardMidB.body.top),
);
check(
  "B can see player A on the SAME shared leaderboard (rank/name/score)",
  boardMidB.body.top.some((r) => r.name === "ProdCheckA"),
  JSON.stringify(boardMidB.body.top.map((r) => r.name)),
);

await play(today, b.playerId, b.token, "ProdCheckB", "a dream", 0.6);
const b3 = await play(today, b.playerId, b.token, "ProdCheckB", "a trance", 0.5);
check("player B completed 3 attempts in production", b3.status === 200);

const boardAfterB = await leaderboard(today.id, b.playerId);
check(
  "after B's 3rd attempt, A's answer text becomes visible in production",
  boardAfterB.body.top.some(
    (r) => r.name === "ProdCheckA" && typeof r.answer === "string" && r.answer.length > 0,
  ),
  JSON.stringify(boardAfterB.body.top),
);
check(
  "both players appear together on the one shared production leaderboard",
  boardAfterB.body.players >= 2,
  `players=${boardAfterB.body.players}`,
);

// === previous-day answers are available (even if empty) ====================
const yesterday = challengeForDay(previousDayKey(today.dayKey));
const yBoard = await leaderboard(yesterday.id, null);
check("previous-day leaderboard reachable in production", yBoard.status === 200);
check(
  "previous-day answers are not redacted (null only if genuinely empty)",
  yBoard.body.top.length === 0 || yBoard.body.top.every((r) => r.answer !== null),
);

// === forged-request protections still hold in production ===================
const forgedToken = await play(today, a.playerId, "not-the-real-token", "Eve", "forged", 0.5);
check("forged session token rejected in production (401)", forgedToken.status === 401);

const noSuchPlayer = await play(
  today,
  "00000000-0000-0000-0000-000000000000",
  "x",
  "Eve",
  "forged",
  0.5,
);
check("nonexistent player id rejected in production (401)", noSuchPlayer.status === 401);

const c = await session();
const normalized = normalizeAnswer("legit production answer");
const hash = await answerHash({
  challengeId: today.id,
  scoringVersion: today.scoringVersion,
  normalizedAnswer: normalized,
});
const tamperedScore = await call("/api/play", {
  method: "POST",
  body: JSON.stringify({
    playerId: c.playerId,
    token: c.token,
    challengeId: today.id,
    dayKey: today.dayKey,
    scoringVersion: today.scoringVersion,
    name: "Eve",
    answer: "legit production answer",
    normalizedAnswer: normalized,
    answerHash: hash,
    noul: 0.1,
    score: 99.99,
    model: "kev-0.6b/q4",
  }),
});
check(
  "forged score (disagrees with noul) rejected in production (400 score_mismatch)",
  tamperedScore.status === 400 && tamperedScore.body?.error === "score_mismatch",
);

const wrongHash = await call("/api/play", {
  method: "POST",
  body: JSON.stringify({
    playerId: c.playerId,
    token: c.token,
    challengeId: today.id,
    dayKey: today.dayKey,
    scoringVersion: today.scoringVersion,
    name: "Eve",
    answer: "legit production answer",
    normalizedAnswer: normalized,
    answerHash: "0".repeat(64),
    noul: 0.5,
    score: 50,
    model: "kev-0.6b/q4",
  }),
});
check(
  "forged answer hash rejected in production (400 hash_mismatch)",
  wrongHash.status === 400 && wrongHash.body?.error === "hash_mismatch",
);

const staleChallenge = await call("/api/play", {
  method: "POST",
  body: JSON.stringify({
    playerId: c.playerId,
    token: c.token,
    challengeId: "invented-riddle@v99:2000-01-01",
    dayKey: "2000-01-01",
    scoringVersion: 99,
    name: "Eve",
    answer: "legit production answer",
    normalizedAnswer: normalized,
    answerHash: hash,
    noul: 0.5,
    score: 50,
    model: "kev-0.6b/q4",
  }),
});
check(
  "invented challenge id rejected in production (409 stale_challenge)",
  staleChallenge.status === 409 && staleChallenge.body?.error === "stale_challenge",
);

console.log(`\n${failures === 0 ? "ALL PRODUCTION CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
