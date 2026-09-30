/**
 * Jev client. The only file in the project that speaks HTTP to a judge.
 *
 * Endpoint and schema are as documented at https://thejevai.com/docs,
 * https://github.com/jev-ai/jev-api and https://jev-ai.dev/concepts/noul/:
 *
 *   POST {baseUrl}/v1/systemone
 *   Authorization: Bearer <JEV_API_KEY>
 *   Content-Type: application/json
 *
 *   { "model": "...", "state": "...",
 *     "questions": { "<id>": { "type": "noul",
 *                              "instructions": "...",
 *                              "criteria": { "true": "...", "false": "..." } } } }
 *
 *   -> { "model": "jev-1.13.0",
 *        "answers": { "<id>": { "type": "noul", "noul": 0.95 } },
 *        "usage": { "input_tokens": 307, "output_tokens": 20 } }
 *
 * A noul is Jev's probability that the answer to the stated proposition is
 * yes - for this game, the probability that the submitted text is a fun and
 * happy thought. It is that probability, not a measurement of truth.
 */

import { loadEnv } from "./env.js";

export const DEFAULT_BASE_URL = "https://thejevai.com";
export const DEFAULT_MODEL = "typesafe/jev-1.13";
const SYSTEM_ONE_PATH = "/v1/systemone";

// The id we give our single question; the response echoes it back.
export const QUESTION_ID = "verdict";

export class JudgeError extends Error {
  constructor(message, code, { status = null, retryable = false } = {}) {
    super(message);
    this.name = "JudgeError";
    this.code = code;
    this.httpStatus = status;
    // Whether trying again later could plausibly succeed.
    this.retryable = retryable;
  }
}

/**
 * The game's score is the noul as a percentage. Nothing else derives it.
 *
 *   0      -> 0
 *   0.4218 -> 42
 *   0.8734 -> 87
 *   0.995  -> 100
 *   1      -> 100
 */
export function scoreFromNoul(noul) {
  return Math.round(assertNoul(noul) * 100);
}

/**
 * Validate a noul strictly: present, a real number, finite, within [0, 1].
 * Anything else is a malformed response and must not be stored.
 */
export function assertNoul(value) {
  if (typeof value !== "number") {
    throw new JudgeError(`Jev returned a non-numeric noul (${typeof value}).`, "JEV_MALFORMED");
  }
  if (!Number.isFinite(value)) {
    throw new JudgeError("Jev returned a non-finite noul.", "JEV_MALFORMED");
  }
  if (value < 0 || value > 1) {
    throw new JudgeError(`Jev returned a noul outside [0, 1]: ${value}.`, "JEV_MALFORMED");
  }
  return value;
}

/**
 * Pull the result object out of Jev's response envelope.
 *
 * The live API wraps everything, and signals failure in the body rather than
 * only in the HTTP status:
 *
 *   { "code": 0, "message": "ok",
 *     "data": { "result": { "answers": {...}, "usage": {...}, "elapsedMs": 1248 },
 *               "creditsUsed": 1 } }
 *
 * The published examples show the inner `result` object on its own, so accept
 * the wrapped form, a bare `result`, or an already-unwrapped object. A
 * non-zero `code` is an error even when the HTTP status is 200.
 */
function unwrapResult(payload) {
  if (!payload || typeof payload !== "object") {
    throw new JudgeError("Jev returned an empty response.", "JEV_MALFORMED");
  }
  if (typeof payload.code === "number" && payload.code !== 0) {
    throw new JudgeError(
      `Jev returned code ${payload.code}: ${payload.message ?? "no message"}`,
      "JEV_API_ERROR",
    );
  }
  return payload.data?.result ?? payload.result ?? payload;
}

function mapHttpFailure(status, bodyText) {
  const detail = String(bodyText ?? "").slice(0, 300);
  switch (status) {
    case 401:
      return new JudgeError("Jev rejected the API key.", "JEV_UNAUTHORIZED", { status });
    case 422:
      return new JudgeError(`Jev rejected the request: ${detail}`, "JEV_INVALID_REQUEST", {
        status,
      });
    case 429:
      return new JudgeError("Jev rate limit reached.", "JEV_RATE_LIMITED", {
        status,
        retryable: true,
      });
    case 529:
      return new JudgeError("Jev is overloaded.", "JEV_OVERLOADED", { status, retryable: true });
    default:
      return new JudgeError(`Jev returned HTTP ${status}: ${detail}`, "JEV_HTTP_ERROR", {
        status,
        retryable: status >= 500,
      });
  }
}

/**
 * Build an evaluate() function.
 *
 * evaluate({ state, question, criteria }) -> { noul, score, model, usage }
 *
 * `state` is the player's answer and is the ONLY place player text goes. The
 * question and criteria are separate fields, so player text is never spliced
 * into the instructions the judge is given.
 */
export function createJevJudge({
  apiKey = process.env.JEV_API_KEY,
  model = process.env.JEV_MODEL || DEFAULT_MODEL,
  baseUrl = process.env.JEV_API_BASE_URL || DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  questionId = QUESTION_ID,
} = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, "")}${SYSTEM_ONE_PATH}`;

  return async function evaluate({ state, question, criteria = null }) {
    if (typeof state !== "string" || state === "") {
      throw new JudgeError("Nothing to evaluate.", "JEV_BAD_STATE");
    }
    if (typeof question !== "string" || question === "") {
      throw new JudgeError("No question configured.", "JEV_BAD_QUESTION");
    }
    if (!apiKey) {
      throw new JudgeError("JEV_API_KEY is not set.", "JEV_UNCONFIGURED");
    }

    const body = {
      model,
      state,
      questions: {
        [questionId]: {
          type: "noul",
          instructions: question,
          ...(criteria ? { criteria } : {}),
        },
      },
    };

    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new JudgeError(`Could not reach Jev: ${err.message}`, "JEV_UNREACHABLE", {
        retryable: true,
      });
    }

    if (!response.ok) {
      let text = "";
      try {
        text = await response.text();
      } catch {
        // The status alone is enough to classify the failure.
      }
      throw mapHttpFailure(response.status, text);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new JudgeError("Jev returned a body that is not JSON.", "JEV_MALFORMED");
    }

    const result = unwrapResult(payload);

    const answer = result?.answers?.[questionId];
    if (!answer) {
      throw new JudgeError(
        `Jev response has no answer for "${questionId}".`,
        "JEV_MALFORMED",
      );
    }
    if (answer.type !== "noul") {
      throw new JudgeError(`Jev answered with type "${answer.type}", not noul.`, "JEV_MALFORMED");
    }

    const noul = assertNoul(answer.noul);

    return {
      noul,
      score: scoreFromNoul(noul),
      // The live API does not echo a resolved version, so this is usually the
      // requested alias. If a response ever does carry one, prefer it, so a row
      // records what actually ran.
      model: typeof result.model === "string" && result.model ? result.model : model,
      usage: result.usage ?? null,
    };
  };
}

// The instance the server uses. Built lazily so the app can boot, and report a
// clear error, without credentials present.
let shared = null;

export function jevJudge(args) {
  // If the key is still missing, re-read .env before giving up. That way a key
  // pasted into .env while the server is already running takes effect on the
  // next submission, with no restart. Once a key is found the client is cached
  // and .env is never read again.
  if (!process.env.JEV_API_KEY) {
    loadEnv();
    shared = null;
  }
  shared ??= createJevJudge();
  return shared(args);
}

export const judgeModel = process.env.JEV_MODEL || DEFAULT_MODEL;
