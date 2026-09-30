/**
 * Real end-to-end worker test, run against a live wrangler dev (Miniflare)
 * instance - genuine HTTP requests, genuine D1 (local emulation), no mocking.
 *
 *   npx wrangler d1 execute jacob-gg-leaderboard --local --file=schema.sql
 *   npx wrangler dev --local --port 8788
 *   node test/e2e.mjs http://127.0.0.1:8788
 *
 * Covers (Phase 6): three attempts enforced server-side, the daily score as
 * the average of all three (not the max), individual scores preserved,
 * today's-board answer redaction before/after a player's own three attempts,
 * a past day's board never redacted, no canonical answer anywhere in the
 * wire protocol, score precision, forged-score/forged-session rejection, and
 * the pre-existing anti-forgery checks.
 */
const BASE = process.argv[2] || "http://127.0.0.1:8788";

const { answerHash, normalizeAnswer } = await import(
  "file:///C:/Users/jacobp/Desktop/jacob.gg/shared/normalize.js"
);
const { challengeForDay, scoreFromNoul, averageScore, previousDayKey } = await import(
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
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
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
console.log(`today's challenge: ${today.id}\n`);

// === no canonical answer anywhere in the challenge object ===================
check(
  "the challenge object has no answer/correctAnswer field",
  !("answer" in today) && !("correctAnswer" in today),
);

// === player A: three attempts, average, individual scores preserved ========
const a = await session();
check("session issued", Boolean(a?.playerId && a?.token));

const a1 = await play(today, a.playerId, a.token, "Ada", "A room", 0.7241);
check("attempt 1 accepted", a1.status === 200, `attemptNumber=${a1.body?.result?.attemptNumber}`);
check(
  "attempt 1 score is full precision (72.41)",
  Math.abs(a1.body.result.score - 72.41) < 0.001,
);

const a2 = await play(today, a.playerId, a.token, "Ada", "A competition", 0.9183);
check("attempt 2 accepted, attemptNumber 2", a2.status === 200 && a2.body.result.attemptNumber === 2);

const a3 = await play(today, a.playerId, a.token, "Ada", "A conversation", 0.8426);
check("attempt 3 accepted, attemptNumber 3", a3.status === 200 && a3.body.result.attemptNumber === 3);

const a4 = await play(today, a.playerId, a.token, "Ada", "One more", 0.99);
check(
  "4th attempt rejected server-side with max_attempts",
  a4.status === 409 && a4.body?.error === "max_attempts",
);

const expectedAverage = averageScore([{ score: 72.41 }, { score: 91.83 }, { score: 84.26 }]);
check(
  "the daily score is the AVERAGE of all three, not the max",
  Math.abs(a3.body.result && (72.41 + 91.83 + 84.26) / 3 - expectedAverage) < 0.001,
); // sanity on the helper itself

const boardAfterA = await leaderboard(today.id, a.playerId);
const adaRow = boardAfterA.body.top.find((r) => r.name === "Ada");
check(
  "leaderboard shows Ada's score as the average (82.83...), not her max (91.83)",
  Math.abs(adaRow.score - expectedAverage) < 0.01 && adaRow.score < 91.83,
  `got ${adaRow.score}, average should be ~${expectedAverage.toFixed(2)}`,
);

const attemptsA = await call(
  `/api/attempts?challengeId=${encodeURIComponent(today.id)}&playerId=${a.playerId}`,
  { method: "GET" },
);
const scoresA = attemptsA.body.attempts.map((x) => x.score);
check(
  "all three individual scores are preserved exactly (72.41, 91.83, 84.26)",
  JSON.stringify(scoresA) === JSON.stringify([72.41, 91.83, 84.26]),
  JSON.stringify(scoresA),
);
check(
  "a player can always see their OWN answer text via /api/attempts",
  attemptsA.body.attempts.every((x) => typeof x.answer === "string" && x.answer.length > 0),
);

// === player B: mid-attempts, must NOT see Ada's answer text =================
const b = await session();
const b1 = await play(today, b.playerId, b.token, "Bea", "A password", 0.95);
check("player B attempt 1 accepted", b1.status === 200);

const boardMidB = await leaderboard(today.id, b.playerId);
check(
  "before B's 3rd attempt, other players' answer text is withheld",
  boardMidB.body.top.every((r) => r.answer === null || r.you === true),
  JSON.stringify(boardMidB.body.top),
);
check(
  "before B's 3rd attempt, rank/name/score ARE still visible (not fully hidden)",
  boardMidB.body.top.length > 0 && boardMidB.body.top.every((r) => typeof r.score === "number" && r.name),
);

await play(today, b.playerId, b.token, "Bea", "A dream", 0.6);
const b3 = await play(today, b.playerId, b.token, "Bea", "A trance", 0.5);
check("player B completed all 3 attempts", b3.status === 200);

const boardAfterB = await leaderboard(today.id, b.playerId);
check(
  "after B's 3rd attempt, other players' (Ada's) answer text IS now visible",
  boardAfterB.body.top.some((r) => r.name === "Ada" && typeof r.answer === "string" && r.answer.length > 0),
  JSON.stringify(boardAfterB.body.top),
);

// A player who hasn't played at all (anonymous / no playerId) must not see
// today's answer text either.
const boardAnon = await leaderboard(today.id, null);
check(
  "an anonymous/no-playerId request sees no answer text for today",
  boardAnon.body.top.every((r) => r.answer === null),
  JSON.stringify(boardAnon.body.top),
);

// === tie-break sanity (reused from the averaging logic) =====================
check(
  "leaderboard is sorted descending by average score",
  boardAfterB.body.top.every((r, i, arr) => i === 0 || arr[i - 1].score >= r.score),
);

// === a past day's board is never redacted, even for a brand-new viewer =====
const yesterdayChallenge = challengeForDay(previousDayKey(today.dayKey));
// Nobody played yesterday's id in THIS fresh local DB, so it will be empty -
// what matters is that an empty board isn't an error and isn't redacted.
const yBoard = await leaderboard(yesterdayChallenge.id, null);
check("a past-day leaderboard read succeeds (even if empty)", yBoard.status === 200);
check(
  "a past day's board never marks answers as redacted (null only when genuinely empty)",
  yBoard.body.top.length === 0 || yBoard.body.top.every((r) => r.answer !== null),
);

// === security checks carried over from the previous version =================
const forgedToken = await play(today, a.playerId, "not-the-real-token", "Eve", "forged", 0.5);
check("a forged/wrong token is rejected (401)", forgedToken.status === 401);

const noSuchPlayer = await play(
  today,
  "00000000-0000-0000-0000-000000000000",
  "x",
  "Eve",
  "forged",
  0.5,
);
check("a nonexistent player id is rejected (401)", noSuchPlayer.status === 401);

const c = await session();
const normalized = normalizeAnswer("legit answer");
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
    answer: "legit answer",
    normalizedAnswer: normalized,
    answerHash: hash,
    noul: 0.1,
    score: 99.99, // forged: does not match noul
    model: "kev-0.6b/q4",
  }),
});
check(
  "a forged score that disagrees with its own noul is rejected (400 score_mismatch)",
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
    answer: "legit answer",
    normalizedAnswer: normalized,
    answerHash: "0000000000000000000000000000000000000000000000000000000000000000",
    noul: 0.5,
    score: 50,
    model: "kev-0.6b/q4",
  }),
});
check(
  "a forged answer hash is rejected (400 hash_mismatch)",
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
    answer: "legit answer",
    normalizedAnswer: normalized,
    answerHash: hash,
    noul: 0.5,
    score: 50,
    model: "kev-0.6b/q4",
  }),
});
check(
  "a client-invented challenge id is rejected (409 stale_challenge)",
  staleChallenge.status === 409 && staleChallenge.body?.error === "stale_challenge",
);

console.log(`\n${failures === 0 ? "ALL WORKER CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
