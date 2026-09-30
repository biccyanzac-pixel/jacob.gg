/**
 * Judge providers. The only file in the project that speaks HTTP to a judge.
 *
 * Two providers, one wire protocol (System One):
 *
 *   JUDGE_PROVIDER=local  (default)  -> a jev-local server on this machine
 *   JUDGE_PROVIDER=jev               -> the hosted Jev API at thejevai.com
 *
 * Both answer POST {baseUrl}/v1/systemone with the same request shape:
 *
 *   { "model": "...", "state": "...",
 *     "questions": { "<id>": { "type": "noul",
 *                              "instructions": "...",
 *                              "criteria": { "true": "...", "false": "..." } } } }
 *
 * and return a noul: the probability, in [0, 1], that the stated proposition
 * is true of `state`. The game's score is that probability as a percentage.
 * It is a model's probability estimate, not a measurement of truth.
 *
 * IMPORTANT - the local provider is NOT the same model as hosted Jev. It is
 * jev-local (github.com/us/jev-local), an interface-compatible open-source
 * server running an open-weights model on this machine. Its own README is
 * explicit that it is "an interface-compatible baseline, not a reproduction
 * of Jev's undisclosed model or training". Scores from the two providers are
 * not comparable, which is one more reason evaluations record the model that
 * produced them.
 */

import { loadEnv } from "./env.js";

// --- hosted Jev ------------------------------------------------------------
export const DEFAULT_BASE_URL = "https://thejevai.com";
export const DEFAULT_MODEL = "typesafe/jev-1.13";

// --- local jev-local -------------------------------------------------------
// 127.0.0.1 rather than localhost: jev-local's own README notes the browser
// demo needs 127.0.0.1, and it avoids an IPv6-first resolution stall.
export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:8000";
// Sent as the request's `model` field, which the local server requires but
// does not use to pick weights - JEVLOCAL_MODEL on the server does that. The
// response reports the real model, and that is what gets stored.
export const DEFAULT_LOCAL_REQUEST_MODEL = "jev-local";
// CPU inference on a laptop is slow, and the very first request also loads
// the weights, so the local timeout is generous where the hosted one is not.
export const DEFAULT_LOCAL_TIMEOUT_MS = 300_000;

const SYSTEM_ONE_PATH = "/v1/systemone";
const HEALTH_PATH = "/health";

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
    throw new JudgeError(`Judge returned a non-numeric noul (${typeof value}).`, "JEV_MALFORMED");
  }
  if (!Number.isFinite(value)) {
    throw new JudgeError("Judge returned a non-finite noul.", "JEV_MALFORMED");
  }
  if (value < 0 || value > 1) {
    throw new JudgeError(`Judge returned a noul outside [0, 1]: ${value}.`, "JEV_MALFORMED");
  }
  return value;
}

/**
 * Pull the result object out of whichever envelope the provider uses.
 *
 * Hosted Jev wraps everything, and signals failure in the body rather than
 * only in the HTTP status:
 *
 *   { "code": 0, "message": "ok",
 *     "data": { "result": { "answers": {...}, "usage": {...} }, "creditsUsed": 1 } }
 *
 * jev-local returns the flat documented shape, { model, answers, usage }, so
 * both are accepted. A non-zero `code` is an error even on HTTP 200.
 */
function unwrapResult(payload) {
  if (!payload || typeof payload !== "object") {
    throw new JudgeError("Judge returned an empty response.", "JEV_MALFORMED");
  }
  if (typeof payload.code === "number" && payload.code !== 0) {
    throw new JudgeError(
      `Judge returned code ${payload.code}: ${payload.message ?? "no message"}`,
      "JEV_API_ERROR",
    );
  }
  return payload.data?.result ?? payload.result ?? payload;
}

/**
 * Tidy a reported model name for storage.
 *
 * A local judge loading weights from a directory reports the whole path, and
 * rows should not embed someone's filesystem layout. Hub-style ids
 * ("Qwen/Qwen2.5-1.5B-Instruct") and plain names are kept verbatim.
 */
export function tidyModelName(name) {
  const value = String(name ?? "").trim();
  if (!value) return "unknown";
  const looksLikeHubId = /^[\w.-]+\/[\w.-]+$/.test(value);
  if (looksLikeHubId || !/[\\/]/.test(value)) return value;
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}

function mapHttpFailure(status, bodyText) {
  const detail = String(bodyText ?? "").slice(0, 300);
  switch (status) {
    case 401:
      return new JudgeError("Judge rejected the API key.", "JEV_UNAUTHORIZED", { status });
    case 402:
      // The account is out of credits. Nothing the player or a retry can fix:
      // it needs a top-up, so say so plainly rather than hiding it behind a
      // generic "unavailable".
      return new JudgeError(
        `Judge has no credits left on this account: ${detail}`,
        "JEV_INSUFFICIENT_CREDITS",
        { status },
      );
    case 422:
      return new JudgeError(`Judge rejected the request: ${detail}`, "JEV_INVALID_REQUEST", {
        status,
      });
    case 429:
      return new JudgeError("Judge rate limit reached.", "JEV_RATE_LIMITED", {
        status,
        retryable: true,
      });
    case 529:
      return new JudgeError("Judge is overloaded.", "JEV_OVERLOADED", { status, retryable: true });
    default:
      return new JudgeError(`Judge returned HTTP ${status}: ${detail}`, "JEV_HTTP_ERROR", {
        status,
        retryable: status >= 500,
      });
  }
}

/**
 * Build an evaluate() function against any System One endpoint.
 *
 * evaluate({ state, question, criteria }) -> { noul, score, model, usage }
 *
 * `state` is the player's answer and is the ONLY place player text goes. The
 * question and criteria are separate fields, so player text is never spliced
 * into the instructions the judge is given.
 *
 * `apiKey: null` sends no Authorization header, which is what the local
 * server wants; `requireKey` makes a missing key a hard error, which is what
 * the hosted service needs.
 */
export function createSystemOneJudge({
  baseUrl,
  model,
  apiKey = null,
  requireKey = false,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  questionId = QUESTION_ID,
  providerLabel = "judge",
} = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, "")}${SYSTEM_ONE_PATH}`;

  return async function evaluate({ state, question, criteria = null }) {
    if (typeof state !== "string" || state === "") {
      throw new JudgeError("Nothing to evaluate.", "JEV_BAD_STATE");
    }
    if (typeof question !== "string" || question === "") {
      throw new JudgeError("No question configured.", "JEV_BAD_QUESTION");
    }
    if (requireKey && !apiKey) {
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

    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new JudgeError(
        `Could not reach the ${providerLabel} judge at ${url}: ${err.message}`,
        "JEV_UNREACHABLE",
        { retryable: true },
      );
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
      throw new JudgeError("Judge returned a body that is not JSON.", "JEV_MALFORMED");
    }

    const result = unwrapResult(payload);

    const answer = result?.answers?.[questionId];
    if (!answer) {
      throw new JudgeError(`Judge response has no answer for "${questionId}".`, "JEV_MALFORMED");
    }
    if (answer.type !== "noul") {
      throw new JudgeError(`Judge answered with type "${answer.type}", not noul.`, "JEV_MALFORMED");
    }

    const noul = assertNoul(answer.noul);

    return {
      noul,
      score: scoreFromNoul(noul),
      // Prefer the model the response reports, so a row records what actually
      // ran. jev-local reports the open-weights model id; hosted Jev reports
      // nothing, so the requested alias stands in.
      model: tidyModelName(
        typeof result.model === "string" && result.model ? result.model : model,
      ),
      usage: result.usage ?? null,
    };
  };
}

/** The hosted Jev service. Requires a key and spends credits. */
export function createJevJudge({
  apiKey = process.env.JEV_API_KEY,
  model = process.env.JEV_MODEL || DEFAULT_MODEL,
  baseUrl = process.env.JEV_API_BASE_URL || DEFAULT_BASE_URL,
  fetchImpl,
  timeoutMs = 20_000,
  questionId,
} = {}) {
  return createSystemOneJudge({
    baseUrl,
    model,
    apiKey,
    requireKey: true,
    fetchImpl,
    timeoutMs,
    questionId,
    providerLabel: "hosted Jev",
  });
}

/** A jev-local server on this machine. No key, no credits, no internet. */
export function createLocalJudge({
  model = process.env.JEVLOCAL_REQUEST_MODEL || DEFAULT_LOCAL_REQUEST_MODEL,
  baseUrl = process.env.JEVLOCAL_BASE_URL || DEFAULT_LOCAL_BASE_URL,
  fetchImpl,
  timeoutMs = Number(process.env.JEVLOCAL_TIMEOUT_MS) || DEFAULT_LOCAL_TIMEOUT_MS,
  questionId,
} = {}) {
  return createSystemOneJudge({
    baseUrl,
    model,
    apiKey: null,
    requireKey: false,
    fetchImpl,
    timeoutMs,
    questionId,
    providerLabel: "local",
  });
}

/** Which provider is configured. Defaults to local, so play needs no key. */
export function judgeProvider() {
  const raw = (process.env.JUDGE_PROVIDER || "local").trim().toLowerCase();
  return raw === "jev" || raw === "hosted" ? "jev" : "local";
}

/** Where the configured provider lives, for logs and health checks. */
export function judgeBaseUrl(provider = judgeProvider()) {
  return provider === "jev"
    ? process.env.JEV_API_BASE_URL || DEFAULT_BASE_URL
    : process.env.JEVLOCAL_BASE_URL || DEFAULT_LOCAL_BASE_URL;
}

/** A label for logs. Never shown to players. */
export function judgeDescription(provider = judgeProvider()) {
  return provider === "jev"
    ? `hosted Jev (${process.env.JEV_MODEL || DEFAULT_MODEL})`
    : `local jev-local (${judgeBaseUrl("local")})`;
}

/**
 * Is the local judge up? Health only - it does NOT mean the model is loaded,
 * because jev-local builds its scorer lazily on the first scoring request.
 */
export async function localJudgeHealth({
  baseUrl = judgeBaseUrl("local"),
  fetchImpl = globalThis.fetch,
  timeoutMs = 3000,
} = {}) {
  try {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const body = await response.json();
    return { ok: body?.ok === true, reason: body?.ok === true ? null : "unexpected body" };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// The instance the server uses. Built lazily so the app can boot, and report a
// clear error, without credentials present.
let shared = null;
let sharedProvider = null;

export function judge(args) {
  const provider = judgeProvider();

  // On hosted, if the key is still missing, re-read .env before giving up, so
  // a key pasted in while the server runs takes effect on the next submission.
  if (provider === "jev" && !process.env.JEV_API_KEY) {
    loadEnv();
    shared = null;
  }
  if (shared && sharedProvider !== provider) shared = null;

  if (!shared) {
    shared = provider === "jev" ? createJevJudge() : createLocalJudge();
    sharedProvider = provider;
  }
  return shared(args);
}
