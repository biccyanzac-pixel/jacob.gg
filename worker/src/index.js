/**
 * Shared leaderboard API for the daily game. Cloudflare Worker + D1.
 *
 * Scoring happens entirely in the player's browser (open-jev/kev-0.6b) - this
 * worker never runs a model and holds no AI API key. Its job is narrower: be
 * the one thing every player's browser agrees on, so the leaderboard is real
 * shared state instead of per-device localStorage.
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
 *   - noul must be a finite number in [0, 1]; score must be exactly
 *     Math.round(noul * 100). A request where they disagree is rejected -
 *     it never fell out of a real model call.
 *   - one row per (player_id, challenge_id), enforced by a UNIQUE index, not
 *     just application logic.
 *   - player_id is never client-chosen: it is issued by /api/session and
 *     paired with a server-generated token; a submission must present a
 *     token whose hash matches the stored one for that player_id.
 *
 * What this does NOT defend against, honestly: a browser that runs a real
 * model but lies about the resulting noul. There is no server-side model run
 * here to catch that, by design (that would need paid inference and defeat
 * the entire point of this architecture). That is the documented, accepted
 * trade-off for a free, local-inference game - see README.
 */

const SCORING_VERSION = 2;
const CHALLENGE_SLUG = "fun-happy-thought";
const MAX_NAME = 20;
const MAX_ANSWER = 280;
const BOARD_SIZE = 10;

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

function challengeId(dayKey) {
  return `${CHALLENGE_SLUG}@v${SCORING_VERSION}:${dayKey}`;
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
  await env.DB.prepare(
    `INSERT INTO players (id, token_hash, created_at) VALUES (?, ?, ?)`,
  )
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

function boardRow(row, rank, playerId) {
  return {
    rank,
    name: row.display_name,
    answer: row.original_answer,
    score: row.score,
    you: playerId != null && row.player_id === playerId,
  };
}

async function fetchBoard(env, challId, playerId) {
  const { results } = await env.DB.prepare(
    `SELECT player_id, display_name, original_answer, score, submitted_at, id
       FROM submissions
      WHERE challenge_id = ?
      ORDER BY score DESC, submitted_at ASC, id ASC`,
  )
    .bind(challId)
    .all();

  const rows = results ?? [];
  const top = rows.slice(0, BOARD_SIZE).map((r, i) => boardRow(r, i + 1, playerId));
  const yourIndex = playerId ? rows.findIndex((r) => r.player_id === playerId) : -1;
  const you = yourIndex >= BOARD_SIZE ? boardRow(rows[yourIndex], yourIndex + 1, playerId) : null;

  return { players: rows.length, top, you };
}

async function handleLeaderboard(request, env) {
  const url = new URL(request.url);
  const challId = url.searchParams.get("challengeId");
  const playerId = url.searchParams.get("playerId");
  if (!challId) return fail("bad_request", "challengeId is required.", 400, env);
  return json(await fetchBoard(env, challId, playerId), { env });
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
  const expectedChallengeId = challengeId(day);
  if (body.challengeId !== expectedChallengeId) {
    return fail(
      "stale_challenge",
      "That challenge has ended. Refresh the page for today's.",
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
  const score = Math.round(noul * 100);
  if (Number(body.score) !== score) {
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

  try {
    await env.DB.prepare(
      `INSERT INTO submissions
         (id, player_id, challenge_id, day_key, scoring_version, display_name,
          original_answer, normalized_answer, answer_hash, noul, score, model, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        uuid(),
        playerId,
        expectedChallengeId,
        day,
        SCORING_VERSION,
        name,
        answer,
        normalized,
        expectedHash,
        noul,
        score,
        model,
        new Date().toISOString(),
      )
      .run();
  } catch (err) {
    // UNIQUE(player_id, challenge_id) violation: already played today.
    if (String(err.message || err).includes("UNIQUE")) {
      const board = await fetchBoard(env, expectedChallengeId, playerId);
      return json(
        { error: "already_played", message: "You have already played today.", leaderboard: board },
        { status: 409, env },
      );
    }
    throw err;
  }

  const board = await fetchBoard(env, expectedChallengeId, playerId);
  return json({ result: { answer, score }, leaderboard: board }, { env });
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
