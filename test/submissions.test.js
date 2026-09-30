import test from "node:test";
import assert from "node:assert/strict";
import { GameError, findSubmission, play } from "../lib/game.js";
import { isUniqueViolation } from "../lib/db.js";
import { fakeJudge, freshDb, todaysChallenge } from "./helpers.js";

const counts = (db) => ({
  evaluations: db.prepare(`SELECT COUNT(*) AS n FROM evaluations`).get().n,
  submissions: db.prepare(`SELECT COUNT(*) AS n FROM submissions`).get().n,
});

// Requirement 7.
test("a player gets one submission per challenge", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);
  const judge = fakeJudge({ noul: 0.82 });

  await play({ db, judge, challenge, playerId: "player-a", name: "A", answer: "I love summer" });

  await assert.rejects(
    play({ db, judge, challenge, playerId: "player-a", name: "A", answer: "I love winter" }),
    (err) => {
      assert.ok(err instanceof GameError);
      assert.equal(err.code, "already_played");
      assert.equal(err.status, 409);
      // The original result comes back rather than a bare error.
      assert.equal(err.submission.original_answer, "I love summer");
      return true;
    },
  );

  assert.deepEqual(counts(db), { evaluations: 1, submissions: 1 });
  assert.equal(judge.callCount, 1, "a blocked second attempt must not reach Jev");
});

test("the same player may play a different challenge", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const today = todaysChallenge(db, "2026-09-30");
  const tomorrow = todaysChallenge(db, "2026-10-01");
  const judge = fakeJudge();

  await play({ db, judge, challenge: today, playerId: "p", name: "P", answer: "I love summer" });
  await play({ db, judge, challenge: tomorrow, playerId: "p", name: "P", answer: "I love summer" });

  assert.equal(counts(db).submissions, 2);
});

test("the unique index enforces one attempt per player per challenge", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);
  const judge = fakeJudge();

  const { evaluation } = await play({
    db,
    judge,
    challenge,
    playerId: "player-a",
    name: "A",
    answer: "I love summer",
  });

  // Bypass the service layer: the database itself must refuse.
  const insert = () =>
    db
      .prepare(
        `INSERT INTO submissions
           (id, player_id, challenge_id, evaluation_id, display_name, original_answer, submitted_at)
         VALUES ('dupe', 'player-a', ?, ?, 'A', 'again', '2026-09-30T01:00:00.000Z')`,
      )
      .run(challenge.id, evaluation.id);

  assert.throws(insert, (err) => isUniqueViolation(err));
  assert.equal(counts(db).submissions, 1);
});

// Requirement 8.
test("two players sharing an answer share one evaluation", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);
  const judge = fakeJudge({ noul: 0.82 });

  const a = await play({
    db,
    judge,
    challenge,
    playerId: "player-a",
    name: "A",
    answer: "I love summer",
  });
  const b = await play({
    db,
    judge,
    challenge,
    playerId: "player-b",
    name: "B",
    answer: "I LOVE SUMMER",
  });

  assert.equal(judge.callCount, 1, "Jev must be called once for a shared answer");
  assert.equal(a.evaluation.id, b.evaluation.id);
  assert.equal(a.evaluation.score, 82);
  assert.equal(b.evaluation.score, 82);
  assert.deepEqual(counts(db), { evaluations: 1, submissions: 2 });

  // Each player's own wording is preserved for display.
  assert.equal(a.submission.original_answer, "I love summer");
  assert.equal(b.submission.original_answer, "I LOVE SUMMER");
  assert.equal(findSubmission(db, "player-b", challenge.id).original_answer, "I LOVE SUMMER");
});

test("the submission links a player to an evaluation without copying the score", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);

  const { submission } = await play({
    db,
    judge: fakeJudge({ noul: 0.82 }),
    challenge,
    playerId: "player-a",
    name: "A",
    answer: "I love summer",
  });

  const row = db.prepare(`SELECT * FROM submissions WHERE id = ?`).get(submission.id);
  assert.equal(row.player_id, "player-a");
  assert.equal(row.challenge_id, challenge.id);
  assert.ok(row.evaluation_id);
  assert.equal(row.score, undefined, "the score lives on the evaluation, not the submission");
});
