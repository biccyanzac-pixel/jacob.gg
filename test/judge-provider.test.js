import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LOCAL_BASE_URL,
  tidyModelName,
  createJevJudge,
  createLocalJudge,
  judgeBaseUrl,
  judgeProvider,
  localJudgeHealth,
} from "../lib/judge.js";
import { jevLocalHealth, jevLocalResponse, jevResponse, stubFetch } from "./helpers.js";

// Provider selection reads the environment, so each test restores it.
const ENV_KEYS = ["JUDGE_PROVIDER", "JEV_API_KEY", "JEVLOCAL_BASE_URL", "JEV_API_BASE_URL"];
let saved;

test.beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});

test.afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// --- selection -------------------------------------------------------------

test("the default provider is local, so play needs no key", () => {
  delete process.env.JUDGE_PROVIDER;
  assert.equal(judgeProvider(), "local");
  assert.equal(judgeBaseUrl(), DEFAULT_LOCAL_BASE_URL);
});

test("JUDGE_PROVIDER selects the hosted service explicitly", () => {
  process.env.JUDGE_PROVIDER = "jev";
  assert.equal(judgeProvider(), "jev");
  process.env.JUDGE_PROVIDER = "hosted";
  assert.equal(judgeProvider(), "jev");
});

test("provider names are case and whitespace insensitive, and unknown means local", () => {
  for (const value of ["LOCAL", " local ", "Jev ", "nonsense", ""]) {
    process.env.JUDGE_PROVIDER = value;
    const expected = value.trim().toLowerCase() === "jev" ? "jev" : "local";
    assert.equal(judgeProvider(), expected, `for ${JSON.stringify(value)}`);
  }
});

// --- the local provider ----------------------------------------------------

test("the local judge needs no API key and sends no Authorization header", async () => {
  delete process.env.JEV_API_KEY;
  const fetchImpl = stubFetch({ json: jevLocalResponse(0.82) });

  const result = await createLocalJudge({ baseUrl: "http://127.0.0.1:8000", fetchImpl })({
    state: "ice cream in the sun",
    question: "Is this text actually a fun and happy thought?",
    criteria: { true: "yes it is", false: "no it is not" },
  });

  const { url, options, body } = fetchImpl.calls[0];
  assert.equal(url, "http://127.0.0.1:8000/v1/systemone");
  assert.equal("Authorization" in options.headers, false, "no key should be sent locally");
  assert.equal(options.headers["Content-Type"], "application/json");

  // Same request contract as hosted: the player's text only ever in `state`.
  assert.equal(body.state, "ice cream in the sun");
  assert.equal(body.questions.verdict.type, "noul");
  assert.deepEqual(Object.keys(body.questions.verdict.criteria), ["true", "false"]);

  assert.equal(result.noul, 0.82);
  assert.equal(result.score, 82);
  // The local server reports the open-weights model, which is what gets stored.
  assert.equal(result.model, "Qwen/Qwen2.5-1.5B-Instruct");
});

test("the local judge parses jev-local's flat response shape", async () => {
  const fetchImpl = stubFetch({
    json: {
      model: "Qwen/Qwen2.5-1.5B-Instruct",
      answers: { verdict: { type: "noul", noul: 0.4218 } },
      usage: { input_tokens: 61, output_tokens: 1 },
    },
  });
  const result = await createLocalJudge({ fetchImpl })({
    state: "hello",
    question: "Is this happy?",
  });
  assert.equal(result.noul, 0.4218);
  assert.equal(result.score, 42);
});

test("the local judge honours JEVLOCAL_BASE_URL", async () => {
  process.env.JEVLOCAL_BASE_URL = "http://127.0.0.1:9999";
  assert.equal(judgeBaseUrl("local"), "http://127.0.0.1:9999");
  const fetchImpl = stubFetch({ json: jevLocalResponse(0.5) });
  await createLocalJudge({ fetchImpl })({ state: "hello", question: "Is this happy?" });
  assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:9999/v1/systemone");
});

test("a malformed local noul is rejected exactly as a hosted one is", async () => {
  for (const noul of ["0.5", null, NaN, 1.2, -0.1]) {
    const fetchImpl = stubFetch({ json: jevLocalResponse(noul) });
    await assert.rejects(
      createLocalJudge({ fetchImpl })({ state: "hello", question: "Is this happy?" }),
      (err) => {
        assert.equal(err.code, "JEV_MALFORMED");
        return true;
      },
      `for noul ${JSON.stringify(noul)}`,
    );
  }
});

test("an unreachable local judge is a typed, retryable error naming the address", async () => {
  const fetchImpl = stubFetch({ throws: new Error("ECONNREFUSED") });
  await assert.rejects(
    createLocalJudge({ baseUrl: "http://127.0.0.1:8000", fetchImpl })({
      state: "hello",
      question: "Is this happy?",
    }),
    (err) => {
      assert.equal(err.code, "JEV_UNREACHABLE");
      assert.equal(err.retryable, true);
      assert.match(err.message, /127\.0\.0\.1:8000/);
      return true;
    },
  );
});

// Requirement: hosted credit/API failures cannot affect local mode.
test("hosted credit exhaustion cannot affect local scoring", async () => {
  process.env.JUDGE_PROVIDER = "local";
  // A key that would be refused, and a hosted URL that 402s, are both
  // irrelevant: the local provider never touches either.
  process.env.JEV_API_KEY = "sk_exhausted_account";

  const hostedOutOfCredits = stubFetch({
    status: 402,
    text: JSON.stringify({ code: -1, message: "Insufficient credits." }),
  });
  await assert.rejects(
    createJevJudge({ fetchImpl: hostedOutOfCredits })({
      state: "hello",
      question: "Is this happy?",
    }),
    (err) => err.code === "JEV_INSUFFICIENT_CREDITS",
  );

  // Same moment, same environment: local still scores.
  const localOk = stubFetch({ json: jevLocalResponse(0.91) });
  const result = await createLocalJudge({ fetchImpl: localOk })({
    state: "hello",
    question: "Is this happy?",
  });
  assert.equal(result.score, 91);
  assert.equal(localOk.calls[0].url.startsWith("http://127.0.0.1:8000"), true);
});

test("local scoring works with no hosted configuration at all", async () => {
  delete process.env.JEV_API_KEY;
  delete process.env.JEV_API_BASE_URL;
  delete process.env.JEV_MODEL;

  const fetchImpl = stubFetch({ json: jevLocalResponse(0.73) });
  const result = await createLocalJudge({ fetchImpl })({
    state: "hello",
    question: "Is this happy?",
  });
  assert.equal(result.score, 73);
});

// --- health ----------------------------------------------------------------

test("health reports ok only for a true ok body", async () => {
  assert.deepEqual(
    await localJudgeHealth({ fetchImpl: stubFetch({ json: jevLocalHealth(true) }) }),
    { ok: true, reason: null },
  );

  const notOk = await localJudgeHealth({ fetchImpl: stubFetch({ json: jevLocalHealth(false) }) });
  assert.equal(notOk.ok, false);

  const down = await localJudgeHealth({ fetchImpl: stubFetch({ throws: new Error("refused") }) });
  assert.equal(down.ok, false);
  assert.match(down.reason, /refused/);

  const http500 = await localJudgeHealth({ fetchImpl: stubFetch({ status: 500, json: {} }) });
  assert.equal(http500.ok, false);
  assert.match(http500.reason, /500/);
});

test("health checks the /health path", async () => {
  const fetchImpl = stubFetch({ json: jevLocalHealth(true) });
  await localJudgeHealth({ baseUrl: "http://127.0.0.1:8000", fetchImpl });
  assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:8000/health");
});

// --- the hosted provider is still intact -----------------------------------

test("the hosted provider still requires a key and still sends it", async () => {
  const fetchImpl = stubFetch({ json: jevResponse(0.6) });
  const result = await createJevJudge({ apiKey: "sk_test", fetchImpl })({
    state: "hello",
    question: "Is this happy?",
  });
  assert.equal(fetchImpl.calls[0].options.headers.Authorization, "Bearer sk_test");
  assert.equal(result.score, 60);

  const noKey = stubFetch({ json: jevResponse(0.6) });
  await assert.rejects(
    createJevJudge({ apiKey: "", fetchImpl: noKey })({ state: "hello", question: "Is this happy?" }),
    (err) => err.code === "JEV_UNCONFIGURED",
  );
  assert.equal(noKey.callCount, 0);
});

// A local judge that loads weights from a directory reports the whole path.
const WINDOWS_PATH = String.raw`C:\Users\someone\Programs\jev-local\models\Qwen2.5-1.5B-Instruct`;

test("a filesystem model path is stored as its leaf name", () => {
  assert.equal(tidyModelName(WINDOWS_PATH), "Qwen2.5-1.5B-Instruct");
  assert.equal(tidyModelName("/home/someone/models/Qwen2.5-1.5B-Instruct"), "Qwen2.5-1.5B-Instruct");
  // Hub ids and plain names are left alone.
  assert.equal(tidyModelName("Qwen/Qwen2.5-1.5B-Instruct"), "Qwen/Qwen2.5-1.5B-Instruct");
  assert.equal(tidyModelName("typesafe/jev-1.13"), "typesafe/jev-1.13");
  assert.equal(tidyModelName("jev-1.13.0"), "jev-1.13.0");
  assert.equal(tidyModelName(""), "unknown");
  assert.equal(tidyModelName(undefined), "unknown");
});

test("the stored model never contains a directory path", async () => {
  const fetchImpl = stubFetch({
    json: jevLocalResponse(0.5, { model: WINDOWS_PATH }),
  });
  const result = await createLocalJudge({ fetchImpl })({ state: "x", question: "Is this happy?" });
  assert.equal(result.model, "Qwen2.5-1.5B-Instruct");
});
