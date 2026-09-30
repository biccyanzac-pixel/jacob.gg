import test from "node:test";
import assert from "node:assert/strict";
import { resolveEvaluation } from "../lib/game.js";
import { isUniqueViolation } from "../lib/db.js";
import { DAY, OTHER_DAY, customChallenge, fakeJudge, freshDb, todaysChallenge } from "./helpers.js";

const countEvaluations = (db) => db.prepare(`SELECT COUNT(*) AS n FROM evaluations`).get().n;

// Requirement 1.
test("a new answer calls Jev once and stores the noul and the score", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);
  const judge = fakeJudge({ noul: 0.8734 });

  const { evaluation, judged } = await resolveEvaluation({
    db,
    judge,
    challenge,
    answer: "I love eating ice cream in the sunshine",
  });

  assert.equal(judge.callCount, 1);
  assert.equal(judged, true);
  assert.equal(countEvaluations(db), 1);

  const row = db.prepare(`SELECT * FROM evaluations WHERE id = ?`).get(evaluation.id);
  assert.equal(row.challenge_id, challenge.id);
  assert.equal(row.noul, 0.8734, "the raw probability is stored");
  assert.equal(row.score, 87, "the score is the noul as a percentage");
  assert.equal(row.model, "jev-test-1.0");
  assert.equal(row.scoring_version, challenge.scoring_version);
  assert.equal(row.scoring_question, challenge.scoring_question);
  assert.equal(row.criteria, challenge.criteria);
  assert.equal(row.original_answer, "I love eating ice cream in the sunshine");
  assert.equal(row.normalized_answer, "i love eating ice cream in the sunshine");
  assert.match(row.answer_hash, /^[0-9a-f]{64}$/);
});

test("the judge is asked the challenge's question with the answer as state", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);
  const judge = fakeJudge();

  await resolveEvaluation({ db, judge, challenge, answer: "sunlight on water" });

  const call = judge.calls[0];
  assert.equal(call.state, "sunlight on water");
  assert.equal(call.question, "Is this text actually a fun and happy thought?");
  assert.equal(typeof call.criteria.true, "string");
  assert.equal(typeof call.criteria.false, "string");
});

test("the stored noul keeps full precision", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);

  const noul = 0.123456789012345;
  const { evaluation } = await resolveEvaluation({
    db,
    judge: fakeJudge({ noul }),
    challenge,
    answer: "precise",
  });

  assert.equal(evaluation.noul, noul);
  assert.equal(evaluation.score, 12);
});

// Requirement 2.
test("the same answer is never sent to Jev twice", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);
  const judge = fakeJudge({ noul: 0.82 });

  const first = await resolveEvaluation({ db, judge, challenge, answer: "I love summer" });
  const second = await resolveEvaluation({ db, judge, challenge, answer: "I love summer" });

  assert.equal(judge.callCount, 1);
  assert.equal(second.judged, false);
  assert.equal(second.evaluation.id, first.evaluation.id);
  assert.equal(second.evaluation.noul, 0.82);
  assert.equal(countEvaluations(db), 1);
});

// Requirement 3.
test("a case and whitespace variant reuses the stored evaluation", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);
  const judge = fakeJudge();

  const first = await resolveEvaluation({
    db,
    judge,
    challenge,
    answer: "I love eating ice cream in the sunshine",
  });
  const second = await resolveEvaluation({
    db,
    judge,
    challenge,
    answer: "i LOVE eating   ice cream in the sunshine",
  });

  assert.equal(judge.callCount, 1);
  assert.equal(second.evaluation.id, first.evaluation.id);
  assert.equal(second.evaluation.score, first.evaluation.score);
  assert.equal(countEvaluations(db), 1);
});

// Requirement 4.
test("a different answer gets its own Jev evaluation", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);
  const judge = fakeJudge();

  const a = await resolveEvaluation({ db, judge, challenge, answer: "I love summer" });
  const b = await resolveEvaluation({ db, judge, challenge, answer: "I love winter" });

  assert.equal(judge.callCount, 2);
  assert.notEqual(a.evaluation.id, b.evaluation.id);
  assert.notEqual(a.hash, b.hash);
  assert.equal(countEvaluations(db), 2);
});

// Requirement 5.
test("the same answer on a different challenge is evaluated separately", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const today = todaysChallenge(db, DAY);
  const tomorrow = todaysChallenge(db, OTHER_DAY);
  const judge = fakeJudge();

  assert.notEqual(today.id, tomorrow.id);

  const a = await resolveEvaluation({ db, judge, challenge: today, answer: "I love summer" });
  const b = await resolveEvaluation({ db, judge, challenge: tomorrow, answer: "I love summer" });

  assert.equal(judge.callCount, 2);
  assert.notEqual(a.evaluation.id, b.evaluation.id);
  assert.equal(countEvaluations(db), 2);
});

// Requirement 6.
test("bumping the scoring version forces a fresh evaluation", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const judge = fakeJudge();

  const v1 = customChallenge(db, { id: "demo@v1:2026-09-30", scoringVersion: 1 });
  const v2 = customChallenge(db, { id: "demo@v2:2026-09-30", scoringVersion: 2 });

  const a = await resolveEvaluation({ db, judge, challenge: v1, answer: "I love summer" });
  const b = await resolveEvaluation({ db, judge, challenge: v2, answer: "I love summer" });

  assert.equal(judge.callCount, 2);
  assert.notEqual(a.hash, b.hash, "the scoring version must be part of the hash");
  assert.notEqual(a.evaluation.id, b.evaluation.id);
  assert.equal(a.evaluation.scoring_version, 1);
  assert.equal(b.evaluation.scoring_version, 2);
  assert.equal(countEvaluations(db), 2);
});

// A later Jev model must never rewrite history.
test("a newer Jev model does not re-score a stored answer", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);

  const older = fakeJudge({ noul: 0.4, model: "jev-1.13.0" });
  const first = await resolveEvaluation({ db, judge: older, challenge, answer: "I love summer" });

  const newer = fakeJudge({ noul: 0.95, model: "jev-9.0.0" });
  const second = await resolveEvaluation({ db, judge: newer, challenge, answer: "I love summer" });

  assert.equal(newer.callCount, 0, "a newer model must not be consulted for a stored answer");
  assert.equal(second.evaluation.id, first.evaluation.id);
  assert.equal(second.evaluation.noul, 0.4);
  assert.equal(second.evaluation.score, 40);
  assert.equal(second.evaluation.model, "jev-1.13.0");
});

test("the unique index rejects a second evaluation for the same challenge and hash", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);

  const { evaluation } = await resolveEvaluation({
    db,
    judge: fakeJudge(),
    challenge,
    answer: "I love summer",
  });

  // Bypass the service layer entirely: the database itself must refuse.
  const insert = () =>
    db
      .prepare(
        `INSERT INTO evaluations
           (id, challenge_id, answer_hash, original_answer, normalized_answer,
            noul, score, model, scoring_version, scoring_question, criteria, created_at)
         VALUES ('dupe', ?, ?, 'x', 'x', 0.5, 50, 'm', 1, 'q', NULL,
                 '2026-09-30T00:00:00.000Z')`,
      )
      .run(challenge.id, evaluation.answer_hash);

  assert.throws(insert, (err) => isUniqueViolation(err));
  assert.equal(countEvaluations(db), 1);
});

test("the database refuses a noul outside 0 to 1", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);

  const insert = (noul) => () =>
    db
      .prepare(
        `INSERT INTO evaluations
           (id, challenge_id, answer_hash, original_answer, normalized_answer,
            noul, score, model, scoring_version, scoring_question, criteria, created_at)
         VALUES (?, ?, ?, 'x', 'x', ?, 50, 'm', 1, 'q', NULL, '2026-09-30T00:00:00.000Z')`,
      )
      .run(`id-${noul}`, challenge.id, `hash-${noul}`, noul);

  assert.throws(insert(1.5));
  assert.throws(insert(-0.5));
  assert.equal(countEvaluations(db), 0);
});

test("nothing in the evaluations table records a model confidence", async (t) => {
  const db = freshDb();
  t.after(() => db.close());

  const columns = db.prepare(`PRAGMA table_info(evaluations)`).all().map((c) => c.name);
  assert.ok(columns.includes("noul"));
  assert.ok(columns.includes("score"));
  assert.ok(!columns.some((name) => /confidence/i.test(name)));

  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map((row) => row.name);
  assert.ok(!tables.some((name) => /confidence|self_report/i.test(name)));
});
