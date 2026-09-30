import test from "node:test";
import assert from "node:assert/strict";
import { play, resolveEvaluation } from "../lib/game.js";
import { fakeJudge, freshDb, gatedJudge, todaysChallenge } from "./helpers.js";

// Requirement 9. Two requests arrive with the same previously unseen answer.
// The first calls the judge; the second must wait for that result rather than
// starting a second evaluation.
test("concurrent identical answers produce one judge call and one evaluation", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);
  const judge = gatedJudge({ noul: 0.77 });

  // Both start before either can finish: the judge is held open.
  const a = play({ db, judge, challenge, playerId: "player-a", name: "A", answer: "I love summer" });
  const b = play({ db, judge, challenge, playerId: "player-b", name: "B", answer: "i love summer" });

  assert.equal(judge.callCount, 1, "the second request must not start its own Jev call");

  judge.release();
  const [first, second] = await Promise.all([a, b]);

  assert.equal(judge.callCount, 1);
  assert.equal(first.evaluation.id, second.evaluation.id);
  assert.equal(first.evaluation.score, 77);
  assert.equal(second.evaluation.score, 77);

  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM evaluations`).get().n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM submissions`).get().n, 2);
});

test("concurrent different answers each get their own evaluation", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);
  const judge = gatedJudge();

  const a = resolveEvaluation({ db, judge, challenge, answer: "I love summer" });
  const b = resolveEvaluation({ db, judge, challenge, answer: "I love winter" });

  assert.equal(judge.callCount, 2);
  judge.release();
  const [first, second] = await Promise.all([a, b]);

  assert.notEqual(first.evaluation.id, second.evaluation.id);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM evaluations`).get().n, 2);
});

test("a failed Jev call does not block a later retry of the same answer", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);

  const failing = async () => {
    throw new Error("network down");
  };
  await assert.rejects(
    resolveEvaluation({ db, judge: failing, challenge, answer: "I love summer" }),
    /network down/,
  );

  // The in-flight entry must have been cleared, not left holding a rejection.
  const judge = fakeJudge({ noul: 0.6 });
  const { evaluation, judged } = await resolveEvaluation({
    db,
    judge,
    challenge,
    answer: "I love summer",
  });

  assert.equal(judged, true);
  assert.equal(judge.callCount, 1);
  assert.equal(evaluation.score, 60);
});
