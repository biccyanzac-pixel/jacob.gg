/**
 * Challenge definitions, isomorphic: the browser, the leaderboard worker and
 * the local Express server all read the same data, so nobody can disagree
 * about which challenge is today's.
 *
 * The client never *chooses* a challenge. It derives today's from the UTC date
 * exactly as the server does, and the server recomputes it and rejects any
 * submission whose challenge id does not match.
 */

export const SCORING_VERSION = 2;

export const CHALLENGES = [
  {
    slug: "fun-happy-thought",
    // Bumped from 1: the judge changed from hosted Jev to an in-browser
    // open-weights noul model, and the proposition is phrased as a statement
    // rather than a question + criteria object. Evaluations from version 1 are
    // never reused or recalculated under version 2.
    scoringVersion: SCORING_VERSION,

    // Player-facing.
    prompt: "Type a fun and happy thought.",
    hint: "Something specific beats something general.",

    // The proposition the noul is the probability of.
    //
    // open-jev's noul() takes a single statement and has no criteria object,
    // unlike the hosted System One API. The wording below carries the same
    // true/false boundary the criteria expressed, folded into one statement -
    // the formatting adaptation the browser judge requires. The original
    // criteria are kept verbatim below and stored with every evaluation, so
    // what a score was judged against is still recorded.
    // Chosen by measurement, not guesswork: web/scripts/sweep-statements.mjs
    // ran five candidate phrasings through both open-jev models on the
    // required answer set. This one gave the best separation on kev-0.6b
    // (happy answers 84-99, genuinely unhappy answers 3-7) while keeping the
    // true/false boundary from the original criteria below.
    noulStatement:
      "This is a real, meaningful sentence in English describing something fun and happy.",

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

export const MAX_NAME = 20;
export const MAX_ANSWER = 280;

/** UTC calendar day, e.g. "2026-09-30". Everyone gets the same challenge. */
export function todayKey(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

/** Millis until the next UTC midnight, for the countdown. */
export function msUntilNextDay(now = new Date()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - d.getTime();
}

/** Which definition is scheduled for a UTC day. */
export function definitionForDay(dayKey) {
  const dayNumber = Math.floor(Date.parse(`${dayKey}T00:00:00Z`) / 86_400_000);
  if (!Number.isFinite(dayNumber)) throw new TypeError(`bad day key: ${dayKey}`);
  const index = ((dayNumber % CHALLENGES.length) + CHALLENGES.length) % CHALLENGES.length;
  return { definition: CHALLENGES[index], dayNumber };
}

/** Stable and deterministic: the same day and config always give this id. */
export function challengeId(slug, scoringVersion, dayKey) {
  return `${slug}@v${scoringVersion}:${dayKey}`;
}

/** Today's challenge, fully resolved. Derived, never chosen. */
export function challengeForDay(dayKey = todayKey()) {
  const { definition, dayNumber } = definitionForDay(dayKey);
  return {
    ...definition,
    dayKey,
    dayNumber,
    id: challengeId(definition.slug, definition.scoringVersion, dayKey),
  };
}

/**
 * The game's score is the noul as a percentage. Nothing else derives it.
 *
 *   0 -> 0, 0.4218 -> 42, 0.8734 -> 87, 0.995 -> 100, 1 -> 100
 */
export function scoreFromNoul(noul) {
  return Math.round(assertNoul(noul) * 100);
}

/** A noul must be present, a real number, finite and within [0, 1]. */
export function assertNoul(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`invalid noul: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Trim and validate a display name. Throws with a player-facing message. */
export function validateName(raw) {
  if (typeof raw !== "string") throw new Error("Pick a name first.");
  const name = raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) throw new Error("Pick a name first.");
  if ([...name].length > MAX_NAME) throw new Error(`Names are ${MAX_NAME} characters or fewer.`);
  return name;
}

/** Trim and validate an answer. Oversized input is rejected, not truncated. */
export function validateAnswer(raw) {
  if (typeof raw !== "string") throw new Error("Write an answer first.");
  const answer = raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!answer) throw new Error("Write an answer first.");
  const length = [...answer].length;
  if (length > MAX_ANSWER) {
    throw new Error(`Answers are ${MAX_ANSWER} characters or fewer. Yours is ${length}.`);
  }
  return answer;
}
