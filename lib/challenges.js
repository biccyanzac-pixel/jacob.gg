import crypto from "node:crypto";

/**
 * Challenge definitions.
 *
 * Everything the judge is asked lives here as data: the prompt the player
 * sees, the yes/no proposition the score is the probability of, and the
 * criteria that pin down what true and false mean. Adding tomorrow's challenge
 * means adding an entry to CHALLENGES; no application code changes.
 *
 * scoringVersion is the contract between a challenge's scoring configuration
 * and the evaluations stored under it. Change scoringQuestion or criteria and
 * you MUST bump scoringVersion: the version is folded into the answer hash, so
 * stored evaluations are never reused under new criteria, and are never
 * recalculated either. A bump is a new challenge row, so bumping mid-day
 * starts a fresh leaderboard for that day.
 */
export const CHALLENGES = [
  {
    slug: "fun-happy-thought",
    scoringVersion: 1,

    // Player-facing.
    prompt: "Type a fun and happy thought.",
    hint: "Something specific beats something general.",

    // Judge-facing. The player's text is never spliced into either of these -
    // it is sent separately as the state.
    scoringQuestion: "Is this text actually a fun and happy thought?",
    criteria: {
      true:
        "The submitted text genuinely expresses something that could reasonably be " +
        "described as fun and happy.",
      false:
        "The submitted text does not express a fun and happy thought, is predominantly " +
        "negative or unhappy, is nonsense, or does not meaningfully answer the challenge.",
    },
  },
];

/** UTC calendar day, e.g. "2026-09-30". Everyone gets the same challenge. */
export function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Millis until the next UTC midnight, for the countdown in the UI. */
export function msUntilNextDay(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return next - now.getTime();
}

/**
 * Which challenge definition is scheduled for a given UTC day. With one
 * definition, every day serves it; with more, the rotation advances daily.
 */
export function definitionForDay(dayKey) {
  const dayNumber = Math.floor(Date.parse(`${dayKey}T00:00:00Z`) / 86_400_000);
  if (!Number.isFinite(dayNumber)) throw new TypeError(`bad day key: ${dayKey}`);
  const index = ((dayNumber % CHALLENGES.length) + CHALLENGES.length) % CHALLENGES.length;
  return { definition: CHALLENGES[index], dayNumber };
}

/** Stable, readable, deterministic: the same day and config always match a row. */
export function challengeId(slug, scoringVersion, dayKey) {
  return `${slug}@v${scoringVersion}:${dayKey}`;
}

/** Criteria are stored as JSON text; give callers the object back. */
export function parseCriteria(challengeRow) {
  if (!challengeRow?.criteria) return null;
  try {
    return JSON.parse(challengeRow.criteria);
  } catch {
    return null;
  }
}

/**
 * Get the challenge row for a UTC day, creating it on first use. Idempotent
 * and safe to call concurrently: the insert ignores a conflict and the row is
 * then read back.
 */
export function ensureChallenge(db, dayKey = todayKey(), now = new Date()) {
  const { definition, dayNumber } = definitionForDay(dayKey);
  const id = challengeId(definition.slug, definition.scoringVersion, dayKey);

  db.prepare(
    `INSERT INTO challenges
       (id, day_key, slug, prompt, scoring_question, criteria, scoring_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(
    id,
    dayKey,
    definition.slug,
    definition.prompt,
    definition.scoringQuestion,
    definition.criteria ? JSON.stringify(definition.criteria) : null,
    definition.scoringVersion,
    now.toISOString(),
  );

  const row = db.prepare(`SELECT * FROM challenges WHERE id = ?`).get(id);
  return { ...row, dayNumber, hint: definition.hint ?? null };
}

/** Test helper: register an ad-hoc challenge without touching CHALLENGES. */
export function createChallengeRow(
  db,
  {
    id = crypto.randomUUID(),
    dayKey,
    slug = "test-challenge",
    prompt = "Type a fun and happy thought.",
    scoringQuestion = "Is this text actually a fun and happy thought?",
    criteria = null,
    scoringVersion = 1,
  },
) {
  db.prepare(
    `INSERT INTO challenges
       (id, day_key, slug, prompt, scoring_question, criteria, scoring_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    dayKey,
    slug,
    prompt,
    scoringQuestion,
    criteria ? JSON.stringify(criteria) : null,
    scoringVersion,
    new Date().toISOString(),
  );
  return db.prepare(`SELECT * FROM challenges WHERE id = ?`).get(id);
}
