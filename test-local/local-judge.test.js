/**
 * Real local-model integration test. No stubs, no mocks: every noul here is
 * produced by the open-weights model running in the jev-local server on this
 * machine.
 *
 * Needs the local judge up and warm. `start-game.cmd`, `npm run play` and
 * `npm run judge:start` all do that. Kept out of `test/` so `npm test` stays
 * offline and instant.
 *
 *   npm run test:local
 *
 * The judge is jev-local with an open-weights model. It is interface
 * compatible with hosted Jev; it is not Jev's model, and scores from the two
 * are not comparable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadEnv } from "../lib/env.js";
import { openDatabase } from "../lib/db.js";
import { ensureChallenge, todayKey } from "../lib/challenges.js";
import { leaderboard, play, resolveEvaluation } from "../lib/game.js";
import { createJevJudge, createLocalJudge, localJudgeHealth, scoreFromNoul } from "../lib/judge.js";

loadEnv();

const health = await localJudgeHealth();
const skip = health.ok
  ? false
  : `local judge not reachable (${health.reason}) - run: npm run judge:start`;

const HAPPY = "I ate ice cream in the sunshine and laughed with my friend.";
const BLEAK = "Everything is bleak and I am miserable about all of it.";

/** The real local judge, wrapped so tests can count actual model calls. */
function countingJudge() {
  const real = createLocalJudge();
  const judge = async (args) => {
    judge.calls.push(args);
    return real(args);
  };
  judge.calls = [];
  Object.defineProperty(judge, "callCount", { get: () => judge.calls.length });
  return judge;
}

// Requirements 1 and 2.
test("the local judge is running and healthy", { skip }, () => {
  assert.equal(health.ok, true);
  assert.equal(health.reason, null);
});

// Requirements 3, 4, 5, 7.
test("a real local noul is returned, converted and persisted", { skip }, async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const challenge = ensureChallenge(db, todayKey());
  const judge = countingJudge();

  const started = Date.now();
  const { evaluation, judged } = await resolveEvaluation({ db, judge, challenge, answer: HAPPY });
  const latencyMs = Date.now() - started;

  console.log(
    `local model: ${evaluation.model} noul=${evaluation.noul} score=${evaluation.score} ` +
      `(${(latencyMs / 1000).toFixed(1)}s)`,
  );

  assert.equal(judge.callCount, 1);
  assert.equal(judged, true);

  // The noul is a real number in range.
  assert.equal(typeof evaluation.noul, "number");
  assert.ok(Number.isFinite(evaluation.noul));
  assert.ok(evaluation.noul >= 0 && evaluation.noul <= 1, `noul out of range: ${evaluation.noul}`);

  // The score is exactly the documented conversion.
  assert.equal(evaluation.score, Math.round(evaluation.noul * 100));
  assert.equal(evaluation.score, scoreFromNoul(evaluation.noul));
  assert.ok(Number.isInteger(evaluation.score));

  // It is persisted, with the model that produced it.
  const rows = db.prepare("SELECT * FROM evaluations WHERE challenge_id = ?").all(challenge.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].noul, evaluation.noul);
  assert.equal(rows[0].score, evaluation.score);
  assert.equal(rows[0].scoring_question, challenge.scoring_question);
  assert.ok(rows[0].model.length > 0);
  // Not the deterministic stub: that would mean fake, unintelligent scoring.
  assert.ok(
    !/stub/i.test(rows[0].model),
    `the local server is serving its deterministic stub (${rows[0].model}); ` +
      "JEVLOCAL_SCORER=hf selects the real model",
  );
});

// Requirement 6.
test("the local model separates a happy answer from a bleak one", { skip }, async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const challenge = ensureChallenge(db, todayKey());
  const judge = countingJudge();

  const happy = await resolveEvaluation({ db, judge, challenge, answer: HAPPY });
  const bleak = await resolveEvaluation({ db, judge, challenge, answer: BLEAK });

  console.log(`local model: happy=${happy.evaluation.score} bleak=${bleak.evaluation.score}`);

  assert.equal(judge.callCount, 2);
  assert.ok(
    bleak.evaluation.noul < happy.evaluation.noul,
    `expected the bleak answer to score lower: bleak=${bleak.evaluation.noul} happy=${happy.evaluation.noul}`,
  );
});

// Requirement 8.
test("a repeated normalized answer reuses the stored evaluation", { skip }, async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const challenge = ensureChallenge(db, todayKey());
  const judge = countingJudge();

  const first = await resolveEvaluation({ db, judge, challenge, answer: HAPPY });
  // Same sentence, different spelling: uppercased and re-spaced.
  const second = await resolveEvaluation({
    db,
    judge,
    challenge,
    answer: `  ${HAPPY.toUpperCase().replace(/ /g, "   ")}  `,
  });

  assert.equal(judge.callCount, 1, "the model must not be asked twice for the same answer");
  assert.equal(second.judged, false);
  assert.equal(second.evaluation.id, first.evaluation.id);
  assert.equal(second.evaluation.noul, first.evaluation.noul);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM evaluations").get().n, 1);
});

// Requirement 9.
test("the leaderboard uses stored scores and never calls the model", { skip }, async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const challenge = ensureChallenge(db, todayKey());
  const judge = countingJudge();

  await play({ db, judge, challenge, playerId: "p1", name: "Ada", answer: HAPPY });
  // A second player submitting the same answer shares the one evaluation.
  await play({ db, judge, challenge, playerId: "p2", name: "Bea", answer: HAPPY.toUpperCase() });

  const callsAfterPlay = judge.callCount;
  assert.equal(callsAfterPlay, 1);

  const board = leaderboard(db, challenge.id, { playerId: "p1" });
  assert.equal(judge.callCount, callsAfterPlay, "the leaderboard must not call the model");
  assert.equal(board.players, 2);
  assert.equal(board.top[0].score, board.top[1].score);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM evaluations").get().n, 1);
});

// Requirement 10.
test("a broken hosted Jev cannot affect local scoring", { skip }, async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const challenge = ensureChallenge(db, todayKey());

  // Point the hosted provider at a dead address with a bogus key and prove it
  // fails, then score locally in the same process moments later.
  const hosted = createJevJudge({
    apiKey: "sk_not_a_real_key",
    baseUrl: "http://127.0.0.1:9",
    timeoutMs: 2000,
  });
  await assert.rejects(
    hosted({ state: HAPPY, question: challenge.scoring_question }),
    (err) => {
      assert.ok(["JEV_UNREACHABLE", "JEV_HTTP_ERROR"].includes(err.code), err.code);
      return true;
    },
  );

  const { evaluation } = await resolveEvaluation({
    db,
    judge: createLocalJudge(),
    challenge,
    answer: "The first warm day of spring after a long winter.",
  });
  assert.ok(evaluation.score >= 0 && evaluation.score <= 100);
  assert.equal(evaluation.score, Math.round(evaluation.noul * 100));
});
