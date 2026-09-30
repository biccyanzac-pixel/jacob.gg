/**
 * Live Jev integration test. Makes a real, billable request to
 * POST https://thejevai.com/v1/systemone.
 *
 * Skipped unless JEV_API_KEY is set, and kept out of `test/` so that
 * `npm test` never spends money. Run it deliberately:
 *
 *   npm run test:live
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadEnv } from "../lib/env.js";
import { openDatabase } from "../lib/db.js";
import { ensureChallenge, todayKey } from "../lib/challenges.js";
import { resolveEvaluation } from "../lib/game.js";
import { createJevJudge, scoreFromNoul } from "../lib/judge.js";

loadEnv();

const hasKey = Boolean(process.env.JEV_API_KEY);
const skip = hasKey ? false : "JEV_API_KEY is not set - skipping the live Jev test";

const ANSWER = "I ate ice cream in the sunshine and laughed with my friend.";

test("the real Jev API scores an answer and the result is cached", { skip }, async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  const challenge = ensureChallenge(db, todayKey());

  // Count real calls by wrapping the real judge.
  let calls = 0;
  const realJudge = createJevJudge();
  const judge = async (args) => {
    calls += 1;
    return realJudge(args);
  };

  // 1. Jev accepts the request; 2. the response carries a usable noul.
  const first = await resolveEvaluation({ db, judge, challenge, answer: ANSWER });
  assert.equal(calls, 1);
  assert.equal(first.judged, true);

  const noul = first.evaluation.noul;
  console.log(
    `live Jev: model=${first.evaluation.model} noul=${noul} score=${first.evaluation.score}`,
  );

  assert.equal(typeof noul, "number");
  assert.ok(Number.isFinite(noul));
  assert.ok(noul >= 0 && noul <= 1, `noul out of range: ${noul}`);

  // 3. The conversion to 0-100 is correct.
  assert.equal(first.evaluation.score, scoreFromNoul(noul));
  assert.equal(first.evaluation.score, Math.round(noul * 100));
  assert.ok(Number.isInteger(first.evaluation.score));

  // A cheerful answer should land above the midpoint. This is the one
  // assertion that depends on Jev's judgement rather than our plumbing.
  assert.ok(noul > 0.5, `expected a happy answer to score above 0.5, got ${noul}`);

  // 4. It is stored.
  const stored = db
    .prepare(`SELECT * FROM evaluations WHERE challenge_id = ?`)
    .all(challenge.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].noul, noul);
  assert.equal(stored[0].scoring_question, challenge.scoring_question);

  // 5. Repeating the same answer does not call Jev again.
  const second = await resolveEvaluation({ db, judge, challenge, answer: ANSWER.toUpperCase() });
  assert.equal(calls, 1, "a repeat submission must not reach Jev");
  assert.equal(second.judged, false);
  assert.equal(second.evaluation.id, first.evaluation.id);
  assert.equal(second.evaluation.noul, noul);
});

test("a clearly unhappy answer scores lower than a happy one", { skip }, async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  const challenge = ensureChallenge(db, todayKey());
  const judge = createJevJudge();

  const happy = await resolveEvaluation({ db, judge, challenge, answer: ANSWER });
  const sad = await resolveEvaluation({
    db,
    judge,
    challenge,
    answer: "Everything is bleak and I am miserable about all of it.",
  });

  console.log(`live Jev: happy=${happy.evaluation.score} sad=${sad.evaluation.score}`);
  assert.ok(
    sad.evaluation.noul < happy.evaluation.noul,
    `expected the unhappy answer to score lower: sad=${sad.evaluation.noul} happy=${happy.evaluation.noul}`,
  );
});
