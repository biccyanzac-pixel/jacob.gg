import crypto from "node:crypto";
import { isUniqueViolation, transaction } from "./db.js";
import { parseCriteria } from "./challenges.js";
import { assertNoul, scoreFromNoul } from "./judge.js";
import { answerHash, normalizeAnswer } from "./normalize.js";

export const MAX_NAME = 20;
export const MAX_ANSWER = 280;

export class GameError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = "GameError";
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

// --- validation ------------------------------------------------------------
// Oversized input is rejected, never silently truncated: a player should not
// be scored on an answer that is not the one they wrote.

function stripControls(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function validateName(raw) {
  if (typeof raw !== "string") throw new GameError("bad_name", "Pick a name first.");
  const name = stripControls(raw).replace(/\s+/g, " ").trim();
  if (!name) throw new GameError("bad_name", "Pick a name first.");
  if ([...name].length > MAX_NAME) {
    throw new GameError("name_too_long", `Names are ${MAX_NAME} characters or fewer.`);
  }
  return name;
}

export function validateAnswer(raw) {
  if (typeof raw !== "string") throw new GameError("bad_answer", "Write an answer first.");
  const answer = stripControls(raw).replace(/\r\n?/g, "\n").trim();
  if (!answer) throw new GameError("bad_answer", "Write an answer first.");
  // Count by code point, so an emoji costs one character rather than two.
  const length = [...answer].length;
  if (length > MAX_ANSWER) {
    throw new GameError(
      "answer_too_long",
      `Answers are ${MAX_ANSWER} characters or fewer. Yours is ${length}.`,
    );
  }
  return answer;
}

// --- evaluations -----------------------------------------------------------

export function findEvaluation(db, challengeId, hash) {
  return (
    db
      .prepare(`SELECT * FROM evaluations WHERE challenge_id = ? AND answer_hash = ?`)
      .get(challengeId, hash) ?? null
  );
}

function storeEvaluation(db, { challenge, hash, original, normalized, verdict, now }) {
  return transaction(db, () => {
    const id = crypto.randomUUID();
    // ON CONFLICT DO NOTHING plus a read-back: if another writer won the race,
    // adopt their row rather than creating a second one.
    db.prepare(
      `INSERT INTO evaluations
         (id, challenge_id, answer_hash, original_answer, normalized_answer,
          noul, score, model, scoring_version, scoring_question, criteria, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (challenge_id, answer_hash) DO NOTHING`,
    ).run(
      id,
      challenge.id,
      hash,
      original,
      normalized,
      verdict.noul,
      verdict.score,
      verdict.model,
      challenge.scoring_version,
      challenge.scoring_question,
      challenge.criteria ?? null,
      now.toISOString(),
    );

    return findEvaluation(db, challenge.id, hash);
  });
}

// In-flight judge calls, per database handle, keyed by answer hash. This is
// what stops two simultaneous requests carrying the same brand-new answer from
// both calling the judge: the second awaits the first. It is per-process; the
// unique index is the guarantee that survives across processes (see README).
const inflightByDb = new WeakMap();

function inflightFor(db) {
  let map = inflightByDb.get(db);
  if (!map) {
    map = new Map();
    inflightByDb.set(db, map);
  }
  return map;
}

/**
 * Return the authoritative evaluation for this answer, calling the judge only
 * if one does not already exist.
 *
 * Resolves to { evaluation, judged, hash, normalized } where `judged` says
 * whether this call was the one that invoked the judge.
 */
export async function resolveEvaluation({ db, judge, challenge, answer, now = new Date() }) {
  const normalized = normalizeAnswer(answer);
  const hash = answerHash({
    challengeId: challenge.id,
    scoringVersion: challenge.scoring_version,
    normalizedAnswer: normalized,
  });

  const cached = findEvaluation(db, challenge.id, hash);
  if (cached) return { evaluation: cached, judged: false, hash, normalized };

  const inflight = inflightFor(db);
  const existing = inflight.get(hash);
  if (existing) {
    return { evaluation: await existing, judged: false, hash, normalized };
  }

  const pending = (async () => {
    // Re-check inside the task: a write may have landed since the first read.
    const raced = findEvaluation(db, challenge.id, hash);
    if (raced) return raced;

    // The player's answer goes only in `state`. The question and criteria are
    // separate fields, so player text can never become judge instructions.
    const raw = await judge({
      state: answer,
      question: challenge.scoring_question,
      criteria: parseCriteria(challenge),
    });

    // Derive the score here, from the raw probability, so the stored score can
    // never disagree with the stored noul - whatever the judge reports.
    const noul = assertNoul(raw?.noul);
    const verdict = {
      noul,
      score: scoreFromNoul(noul),
      model: typeof raw.model === "string" && raw.model ? raw.model : "unknown",
    };

    const stored = storeEvaluation(db, {
      challenge,
      hash,
      original: answer,
      normalized,
      verdict,
      now,
    });
    if (!stored) {
      throw new GameError("evaluation_lost", "The evaluation could not be stored.", 500);
    }
    return stored;
  })();

  inflight.set(hash, pending);
  try {
    const evaluation = await pending;
    return { evaluation, judged: true, hash, normalized };
  } finally {
    // Cleared on success and on failure: a failed judge call must not poison
    // the next attempt with a rejected promise.
    inflight.delete(hash);
  }
}

// --- submissions -----------------------------------------------------------

export function findSubmission(db, playerId, challengeId) {
  return (
    db
      .prepare(
        `SELECT s.*, e.score
           FROM submissions s
           JOIN evaluations e ON e.id = s.evaluation_id
          WHERE s.player_id = ? AND s.challenge_id = ?`,
      )
      .get(playerId, challengeId) ?? null
  );
}

/**
 * Play today's challenge: validate, resolve (or reuse) an evaluation, then
 * record the submission.
 *
 * Throws GameError("already_played") if this player already has a submission
 * for this challenge - checked up front and again via the unique index, so the
 * database is the authority rather than the caller or the browser.
 */
export async function play({ db, judge, challenge, playerId, name, answer, now = new Date() }) {
  if (typeof playerId !== "string" || !playerId) {
    throw new GameError("no_player", "Missing player identity.", 400);
  }

  const alreadyPlayed = findSubmission(db, playerId, challenge.id);
  if (alreadyPlayed) {
    throw new GameError(
      "already_played",
      "You have already played today. Come back tomorrow.",
      409,
      { submission: alreadyPlayed },
    );
  }

  const displayName = validateName(name);
  const cleanAnswer = validateAnswer(answer);

  const { evaluation, judged } = await resolveEvaluation({
    db,
    judge,
    challenge,
    answer: cleanAnswer,
    now,
  });

  const submission = {
    id: crypto.randomUUID(),
    player_id: playerId,
    challenge_id: challenge.id,
    evaluation_id: evaluation.id,
    display_name: displayName,
    original_answer: cleanAnswer,
    submitted_at: now.toISOString(),
  };

  try {
    db.prepare(
      `INSERT INTO submissions
         (id, player_id, challenge_id, evaluation_id, display_name, original_answer, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      submission.id,
      submission.player_id,
      submission.challenge_id,
      submission.evaluation_id,
      submission.display_name,
      submission.original_answer,
      submission.submitted_at,
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Two requests from the same player raced. The first one stands.
      throw new GameError(
        "already_played",
        "You have already played today. Come back tomorrow.",
        409,
        { submission: findSubmission(db, playerId, challenge.id) },
      );
    }
    throw err;
  }

  return { submission, evaluation, judged };
}

// --- leaderboard -----------------------------------------------------------

// Deterministic ordering: score descending, then earliest submission, then
// submission id as a stable final tiebreak. Reads stored rows only - this
// never touches the judge.
const BOARD_SQL = `
  SELECT s.id, s.player_id, s.display_name, s.original_answer, s.submitted_at, e.score
    FROM submissions s
    JOIN evaluations e ON e.id = s.evaluation_id
   WHERE s.challenge_id = ?
   ORDER BY e.score DESC, s.submitted_at ASC, s.id ASC
`;

export function leaderboard(db, challengeId, { limit = 10, playerId = null } = {}) {
  const rows = db.prepare(BOARD_SQL).all(challengeId);

  const view = (row, rank) => ({
    rank,
    name: row.display_name,
    answer: row.original_answer,
    score: row.score,
    you: playerId != null && row.player_id === playerId,
  });

  const top = rows.slice(0, limit).map((row, index) => view(row, index + 1));
  const yourIndex = playerId == null ? -1 : rows.findIndex((row) => row.player_id === playerId);

  return {
    players: rows.length,
    top,
    // Populated only when the player ranks below the visible slice, so their
    // own row is always shown somewhere.
    you: yourIndex >= limit ? view(rows[yourIndex], yourIndex + 1) : null,
  };
}
