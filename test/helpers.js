import { openDatabase } from "../lib/db.js";
import { createChallengeRow, ensureChallenge } from "../lib/challenges.js";

/** A fresh in-memory database with the full schema. */
export function freshDb() {
  return openDatabase(":memory:");
}

/**
 * A stand-in for the Jev judge that counts its calls, so a test can assert
 * exactly how many times Jev would have been contacted. No network, no key.
 *
 * Matches the real judge's contract: evaluate({ state, question, criteria })
 * resolving to { noul, score, model }.
 */
export function fakeJudge({ noul = 0.82, model = "jev-test-1.0" } = {}) {
  const judge = async ({ state, question, criteria }) => {
    judge.calls.push({ state, question, criteria });
    return { noul, score: Math.round(noul * 100), model };
  };
  judge.calls = [];
  Object.defineProperty(judge, "callCount", { get: () => judge.calls.length });
  return judge;
}

/** A judge that fails the test if it is ever called. */
export function forbiddenJudge(label = "judge") {
  return async () => {
    throw new Error(`${label} must not be called here`);
  };
}

/**
 * A judge whose call is held open until release() is called, for exercising
 * concurrent submissions of the same unseen answer.
 */
export function gatedJudge({ noul = 0.75, model = "jev-test-1.0" } = {}) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const judge = async ({ state, question, criteria }) => {
    judge.calls.push({ state, question, criteria });
    await gate;
    return { noul, score: Math.round(noul * 100), model };
  };
  judge.calls = [];
  Object.defineProperty(judge, "callCount", { get: () => judge.calls.length });
  judge.release = () => release();
  return judge;
}

export const DAY = "2026-09-30";
export const OTHER_DAY = "2026-10-01";

/** Today's real challenge, created in the given database. */
export function todaysChallenge(db, dayKey = DAY) {
  return ensureChallenge(db, dayKey);
}

/**
 * An ad-hoc challenge, for testing that evaluations do not leak across
 * challenges or scoring versions.
 */
export function customChallenge(db, { id, dayKey = DAY, slug = "test-challenge", scoringVersion = 1 }) {
  return createChallengeRow(db, { id, dayKey, slug, scoringVersion });
}

/**
 * A stub for global fetch that returns one canned Jev response, and records
 * the request it was given so a test can assert the wire format.
 */
export function stubFetch({ status = 200, json = null, text = "", throws = null } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
    if (throws) throw throws;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (json === null) throw new SyntaxError("not json");
        return json;
      },
      text: async () => text,
    };
  };
  impl.calls = calls;
  Object.defineProperty(impl, "callCount", { get: () => calls.length });
  return impl;
}

/** A well-formed Jev systemone response carrying one noul answer. */
export function jevResponse(noul, { questionId = "verdict", model = "jev-1.13.0" } = {}) {
  return {
    model,
    answers: { [questionId]: { type: "noul", noul } },
    usage: { input_tokens: 42, output_tokens: 7 },
  };
}
