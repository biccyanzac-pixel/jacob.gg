/**
 * Shared leaderboard API for the daily riddle game. Cloudflare Worker + D1.
 *
 * Scoring happens entirely in the player's browser (open-jev/kev-0.6b) - this
 * worker never runs a model and holds no AI API key. Its job is narrower: be
 * the one thing every player's browser agrees on, so attempts and the
 * leaderboard are real shared state instead of per-device localStorage, and
 * "3 attempts, scored as their average" is a database fact instead of a
 * client promise.
 *
 * Because inference is client-side, a sophisticated player COULD alter their
 * own score before it reaches here. This worker does not try to re-run the
 * model (that would need the same weights server-side, defeating the point of
 * free/local inference). It closes every cheaper hole instead:
 *
 *   - challengeId is always recomputed from the current UTC date, never
 *     trusted from the client - a request for a stale or invented challenge
 *     is rejected.
 *   - answerHash must match a server-side recompute of the same
 *     normalize+hash the browser used (shared/normalize.js, ported below) -
 *     a mismatched hash means the payload was tampered with in transit.
 *   - noul must be a finite number in [0, 1]; score must equal noul * 100
 *     (within float rounding tolerance). A request where they disagree is
 *     rejected - it never fell out of a real model call.
 *   - attempt_number is always assigned here as (existing row count + 1),
 *     never accepted from the client, and a player at 3 rows is rejected
 *     before a fourth is even considered.
 *   - one row per (player_id, challenge_id, attempt_number), enforced by a
 *     database constraint, not just application logic.
 *   - player_id is never client-chosen: it is issued by /api/session and
 *     paired with a server-generated token; a submission must present a
 *     token whose hash matches the stored one for that player_id.
 *   - submissions are INSERT-only. Nothing here ever UPDATEs or DELETEs a
 *     row, so a past attempt cannot be altered after the fact.
 *   - other players' answer text for TODAY's riddle is withheld from a
 *     player's own leaderboard read until that player's own attempt count
 *     for today reaches MAX_ATTEMPTS - enforced here, in the response the
 *     server sends, not left to the client to politely not display it. A
 *     past day's board is never redacted (see fetchBoard).
 *
 * What this does NOT defend against, honestly: a browser that runs a real
 * model but lies about the resulting noul. There is no server-side model run
 * here to catch that, by design (that would need paid inference and defeat
 * the entire point of this architecture). That is the documented, accepted
 * trade-off for a free, local-inference game - see README.md.
 */

const SCORING_VERSION = 4;
const MAX_NAME = 20;
// Short free-text interpretations only, matching shared/challenges.js.
const MAX_ANSWER = 80;
const MAX_ATTEMPTS = 3;
const BOARD_SIZE = 10;
// Float equality guard for score === noul * 100: generous enough for normal
// floating-point roundoff, tight enough that a meaningfully different number
// still fails.
const SCORE_EPSILON = 0.01;

// The daily riddle rotation. Must stay byte-identical in order and slug to
// shared/challenges.js's CHALLENGES - the worker recomputes today's challenge
// id from its own clock independently of the client, and the two would
// silently disagree about which riddle is "today's" if these ever drifted
// apart. (No prompt text is needed here: the worker never judges anything,
// it only needs the id to match.)
const CHALLENGE_SLUGS = [
  "enter-without-going-in",
  "behind-before-passed",
  "more-true-when-stop-believing",
];

// --- shared logic, ported from shared/normalize.js and shared/challenges.js
// so the worker can recompute independently of whatever the client sent. ---

function normalizeAnswer(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .toLowerCase()
    .normalize("NFKC");
}

async function answerHash({ challengeId, scoringVersion, normalizedAnswer }) {
  const encoder = new TextEncoder();
  const fields = [
    "jacob.gg/daily/answer-hash/v1",
    challengeId,
    String(scoringVersion),
    normalizedAnswer,
  ];
  const parts = [];
  let total = 0;
  for (const field of fields) {
    const bytes = encoder.encode(field);
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, bytes.length, false);
    parts.push(header, bytes);
    total += header.length + bytes.length;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", joined);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Mirrors shared/challenges.js's definitionForDay: same modulo arithmetic
 * over the same-order slug list, so both sides always pick the same riddle
 * for the same UTC day. */
function slugForDay(dayKey) {
  const dayNumber = Math.floor(Date.parse(`${dayKey}T00:00:00Z`) / 86_400_000);
  const index = ((dayNumber % CHALLENGE_SLUGS.length) + CHALLENGE_SLUGS.length) % CHALLENGE_SLUGS.length;
  return CHALLENGE_SLUGS[index];
}

function challengeIdForDay(dayKey) {
  return `${slugForDay(dayKey)}@v${SCORING_VERSION}:${dayKey}`;
}

function validateName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name || [...name].length > MAX_NAME) return null;
  return name;
}

function validateAnswer(raw) {
  if (typeof raw !== "string") return null;
  const answer = raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!answer || [...answer].length > MAX_ANSWER) return null;
  return answer;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function uuid() {
  return crypto.randomUUID();
}

// --- HTTP plumbing -----------------------------------------------------

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, { status = 200, env } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(env) },
  });
}

function fail(code, message, status, env) {
  return json({ error: code, message }, { status, env });
}

// --- rate limiting (in-memory per isolate; good enough to blunt a burst) --

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= 30) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

// --- routes --------------------------------------------------------------

async function handleSession(request, env) {
  const playerId = uuid();
  const token = uuid();
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare(`INSERT INTO players (id, token_hash, created_at) VALUES (?, ?, ?)`)
    .bind(playerId, tokenHash, new Date().toISOString())
    .run();
  return json({ playerId, token }, { env });
}

async function verifyPlayer(env, playerId, token) {
  if (typeof playerId !== "string" || typeof token !== "string" || !playerId || !token) {
    return false;
  }
  const row = await env.DB.prepare(`SELECT token_hash FROM players WHERE id = ?`)
    .bind(playerId)
    .first();
  if (!row) return false;
  const tokenHash = await sha256Hex(token);
  return row.token_hash === tokenHash;
}

function attemptView(row) {
  return {
    attemptNumber: row.attempt_number,
    answer: row.original_answer,
    score: row.score,
    at: row.submitted_at,
  };
}

async function countAttempts(env, challId, playerId) {
  if (!playerId) return 0;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM submissions WHERE player_id = ? AND challenge_id = ?`,
  )
    .bind(playerId, challId)
    .first();
  return row?.count ?? 0;
}

async function fetchPlayerAttempts(env, challId, playerId) {
  const { results } = await env.DB.prepare(
    `SELECT attempt_number, original_answer, score, submitted_at
       FROM submissions
      WHERE challenge_id = ? AND player_id = ?
      ORDER BY attempt_number ASC`,
  )
    .bind(challId, playerId)
    .all();
  return (results ?? []).map(attemptView);
}

function boardRow(player, rank, playerId, redact) {
  const isSelf = playerId != null && player.playerId === playerId;
  // Redaction hides every OTHER player's full attempt list (both answer text
  // and each individual score - an individual score alone can leak which
  // interpretation was strong) until the viewer has used all 3 of their own
  // attempts; see fetchBoard. The viewer's own row is never redacted. A past
  // day's board is never redacted at all (isToday gates this upstream).
  return {
    rank,
    name: player.name,
    score: player.avgScore,
    you: isSelf,
    attempts: !redact || isSelf ? player.attempts : null,
  };
}

/**
 * The leaderboard: one row per player, ranked by the arithmetic mean of every
 * attempt they have submitted so far for this challenge (the "daily score" -
 * shared/challenges.js's averageScore, recomputed here independently). Each
 * row carries that player's full attempt list (answer + individual score per
 * attempt_number), not just a single representative answer - averaging 3
 * distinct answers into one number and then showing just one of those
 * answers next to it reads as "this answer scored this average", which it
 * didn't; see the incident this was built to fix.
 *
 * Tie-break rule (documented here because it matters and is easy to get
 * silently inconsistent): ties on average score sort by the player's
 * *earliest* submission for this challenge (attempt_number 1's timestamp),
 * then by that submission's row id as a final, fully deterministic tiebreak.
 * Both are stable across repeated reads - the same two tied players always
 * come out in the same order.
 *
 * Redaction: for TODAY's challenge id, every row's attempt list is withheld
 * (both answers and individual scores - the average score itself still
 * shows, so ranking stays visible) unless the requesting player (`playerId`)
 * has themselves used all MAX_ATTEMPTS attempts on today's riddle - so
 * nobody can read a stronger interpretation, or even infer one from a bare
 * high individual score, before their own three attempts are spent. A
 * challenge id that is not today's (i.e. already closed) is never redacted:
 * the whole point of "yesterday's strongest interpretations" is that those
 * answers are visible normally.
 */
async function fetchBoard(env, challId, playerId) {
  const { results } = await env.DB.prepare(
    `SELECT player_id, display_name, attempt_number, original_answer, score, submitted_at, id
       FROM submissions
      WHERE challenge_id = ?
      ORDER BY player_id, attempt_number ASC`,
  )
    .bind(challId)
    .all();

  const byPlayer = new Map();
  for (const row of results ?? []) {
    let p = byPlayer.get(row.player_id);
    if (!p) {
      p = { playerId: row.player_id, name: row.display_name, attempts: [] };
      byPlayer.set(row.player_id, p);
    }
    // ORDER BY attempt_number ASC above guarantees this stays sorted and
    // that the first row pushed is attempt_number 1 - the "earliest
    // submission" the tie-break below relies on. A player can only ever have
    // attempt_numbers 1..MAX_ATTEMPTS (the INSERT path assigns them
    // sequentially and the unique index on (player_id, challenge_id,
    // attempt_number) makes a duplicate or skipped number impossible), so
    // this can never accumulate a fake or out-of-range third attempt.
    p.attempts.push({ attemptNumber: row.attempt_number, answer: row.original_answer, score: row.score });
    if (!p.firstSubmittedAt) {
      p.firstSubmittedAt = row.submitted_at;
      p.firstId = row.id;
    }
  }

  const perPlayer = [...byPlayer.values()].map((p) => ({
    ...p,
    avgScore: p.attempts.reduce((sum, a) => sum + a.score, 0) / p.attempts.length,
  }));
  perPlayer.sort(
    (a, b) =>
      b.avgScore - a.avgScore ||
      a.firstSubmittedAt.localeCompare(b.firstSubmittedAt) ||
      String(a.firstId).localeCompare(String(b.firstId)),
  );

  const isToday = challId === challengeIdForDay(todayKey());
  const viewerAttempts = isToday ? await countAttempts(env, challId, playerId) : MAX_ATTEMPTS;
  const redact = isToday && viewerAttempts < MAX_ATTEMPTS;

  const top = perPlayer.slice(0, BOARD_SIZE).map((p, i) => boardRow(p, i + 1, playerId, redact));
  const yourIndex = playerId ? perPlayer.findIndex((p) => p.playerId === playerId) : -1;
  const you =
    yourIndex >= BOARD_SIZE ? boardRow(perPlayer[yourIndex], yourIndex + 1, playerId, redact) : null;

  return { players: perPlayer.length, top, you };
}

async function handleLeaderboard(request, env) {
  const url = new URL(request.url);
  const challId = url.searchParams.get("challengeId");
  const playerId = url.searchParams.get("playerId");
  if (!challId) return fail("bad_request", "challengeId is required.", 400, env);
  return json(await fetchBoard(env, challId, playerId), { env });
}

/** This player's own attempts at a challenge - lets a fresh page load (or a
 * cleared localStorage, as long as the session token survives) restore state
 * from the server rather than only trusting the browser. Always includes
 * this player's own answer text regardless of the redaction rule above,
 * which only ever applies to *other* players on the leaderboard. */
async function handleAttempts(request, env) {
  const url = new URL(request.url);
  const challId = url.searchParams.get("challengeId");
  const playerId = url.searchParams.get("playerId");
  if (!challId || !playerId) {
    return fail("bad_request", "challengeId and playerId are required.", 400, env);
  }
  return json({ attempts: await fetchPlayerAttempts(env, challId, playerId) }, { env });
}

async function handlePlay(request, env, ip) {
  if (rateLimited(ip)) {
    return fail("rate_limited", "Too many submissions from here. Try again later.", 429, env);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return fail("bad_request", "Invalid JSON.", 400, env);
  }

  const { playerId, token } = body ?? {};
  if (!(await verifyPlayer(env, playerId, token))) {
    return fail("bad_session", "Invalid or missing session. Reload the page.", 401, env);
  }

  // The challenge id is never trusted from the client - it is recomputed from
  // the server's own clock and the request is rejected if they disagree.
  const day = todayKey();
  const expectedChallengeId = challengeIdForDay(day);
  if (body.challengeId !== expectedChallengeId) {
    return fail(
      "stale_challenge",
      "That riddle has ended. Refresh the page for today's.",
      409,
      env,
    );
  }

  const name = validateName(body.name);
  if (!name) return fail("bad_name", "Pick a name first.", 400, env);
  const answer = validateAnswer(body.answer);
  if (!answer) return fail("bad_answer", "Write an answer first.", 400, env);

  // The noul itself cannot be re-verified without running the model here,
  // which would defeat the point of free client-side inference - but its
  // SHAPE and its relationship to the score can be, and are:
  const noul = Number(body.noul);
  if (!Number.isFinite(noul) || noul < 0 || noul > 1) {
    return fail("bad_noul", "Invalid score data.", 400, env);
  }
  const expectedScore = noul * 100;
  const submittedScore = Number(body.score);
  if (!Number.isFinite(submittedScore) || Math.abs(submittedScore - expectedScore) > SCORE_EPSILON) {
    return fail("score_mismatch", "Score does not match the reported probability.", 400, env);
  }

  // The hash must match an independent server recompute of the same
  // normalize+hash the browser used, so a tampered-with-in-transit payload
  // (different answer than what was actually normalized) is caught.
  const normalized = normalizeAnswer(answer);
  const expectedHash = await answerHash({
    challengeId: expectedChallengeId,
    scoringVersion: SCORING_VERSION,
    normalizedAnswer: normalized,
  });
  if (body.answerHash !== expectedHash) {
    return fail("hash_mismatch", "Answer data did not match. Try submitting again.", 400, env);
  }

  const model = typeof body.model === "string" && body.model ? body.model.slice(0, 120) : "unknown";

  // A player cannot submit the same (normalized) answer twice for the same
  // challenge - checked here, server-side, before an attempt number is ever
  // assigned, so a rejected duplicate never consumes one of the player's 3
  // attempts. Uses the same normalized_answer the player's other attempts
  // were stored with, so case/whitespace differences that normalizeAnswer()
  // already treats as the same answer are correctly caught as duplicates too.
  const duplicate = await env.DB.prepare(
    `SELECT 1 FROM submissions WHERE player_id = ? AND challenge_id = ? AND normalized_answer = ? LIMIT 1`,
  )
    .bind(playerId, expectedChallengeId, normalized)
    .first();
  if (duplicate) {
    return fail("duplicate_answer", "You've already submitted that answer.", 409, env);
  }

  // Assign the attempt number here, from an actual row count - never from
  // anything the client sent. Retried a few times against the unique
  // (player_id, challenge_id, attempt_number) constraint to stay correct if
  // two requests from the same player land at the same moment; D1 workers
  // normally serialise a single player's requests, so this is a safety net,
  // not the primary mechanism.
  let inserted = false;
  let attemptNumber = null;
  for (let tries = 0; tries < 3 && !inserted; tries += 1) {
    const count = await countAttempts(env, expectedChallengeId, playerId);

    if (count >= MAX_ATTEMPTS) {
      return fail(
        "max_attempts",
        `All ${MAX_ATTEMPTS} attempts are already used for today.`,
        409,
        env,
      );
    }

    attemptNumber = count + 1;
    try {
      await env.DB.prepare(
        `INSERT INTO submissions
           (id, player_id, challenge_id, day_key, scoring_version, attempt_number,
            display_name, original_answer, normalized_answer, answer_hash, noul, score,
            model, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          uuid(),
          playerId,
          expectedChallengeId,
          day,
          SCORING_VERSION,
          attemptNumber,
          name,
          answer,
          normalized,
          expectedHash,
          noul,
          expectedScore,
          model,
          new Date().toISOString(),
        )
        .run();
      inserted = true;
    } catch (err) {
      if (!String(err.message || err).includes("UNIQUE")) throw err;
      // Someone else's request won this attempt-number slot; loop and
      // recompute the count for the next one.
    }
  }

  if (!inserted) {
    return fail(
      "max_attempts",
      `All ${MAX_ATTEMPTS} attempts are already used for today.`,
      409,
      env,
    );
  }

  const [board, playerAttempts] = await Promise.all([
    fetchBoard(env, expectedChallengeId, playerId),
    fetchPlayerAttempts(env, expectedChallengeId, playerId),
  ]);

  return json(
    { result: { answer, score: expectedScore, attemptNumber }, attempts: playerAttempts, leaderboard: board },
    { env },
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors(env) });
    }

    try {
      if (url.pathname === "/api/session" && request.method === "POST") {
        return await handleSession(request, env);
      }
      if (url.pathname === "/api/leaderboard" && request.method === "GET") {
        return await handleLeaderboard(request, env);
      }
      if (url.pathname === "/api/attempts" && request.method === "GET") {
        return await handleAttempts(request, env);
      }
      if (url.pathname === "/api/play" && request.method === "POST") {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        return await handlePlay(request, env, ip);
      }
      return fail("not_found", "No such endpoint.", 404, env);
    } catch (err) {
      console.error(err);
      return fail("server_error", "Something broke. Try again.", 500, env);
    }
  },
};
