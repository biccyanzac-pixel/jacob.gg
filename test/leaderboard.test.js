import test from "node:test";
import assert from "node:assert/strict";
import { leaderboard, play } from "../lib/game.js";
import { fakeJudge, forbiddenJudge, freshDb, todaysChallenge } from "./helpers.js";

async function seed(db, challenge, rows) {
  for (const [playerId, name, answer, score, at] of rows) {
    await play({
      db,
      judge: fakeJudge({ noul: score / 100 }),
      challenge,
      playerId,
      name,
      answer,
      now: new Date(at),
    });
  }
}

// Requirement 11.
test("the leaderboard never calls Jev", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);

  await seed(db, challenge, [
    ["p1", "Ada", "sunlight on water", 90, "2026-09-30T10:00:00Z"],
    ["p2", "Bea", "a dog in a hat", 70, "2026-09-30T11:00:00Z"],
  ]);

  // leaderboard() is synchronous and takes no judge at all - there is no
  // parameter to pass one through. This asserts the shape as well as the
  // behaviour: (db, challengeId) plus an options bag.
  assert.equal(leaderboard.length, 2);
  assert.notEqual(leaderboard.constructor.name, "AsyncFunction");
  const board = leaderboard(db, challenge.id, { playerId: "p1" });
  assert.equal(board.players, 2);
  assert.deepEqual(
    board.top.map((row) => row.name),
    ["Ada", "Bea"],
  );
});

test("a cache hit reaches the leaderboard without any Jev involvement", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);

  // First player pays for the evaluation.
  await play({
    db,
    judge: fakeJudge({ noul: 0.88 }),
    challenge,
    playerId: "p1",
    name: "Ada",
    answer: "sunlight on water",
  });

  // Second player submits the same answer with a judge that throws if touched.
  await play({
    db,
    judge: forbiddenJudge("judge"),
    challenge,
    playerId: "p2",
    name: "Bea",
    answer: "SUNLIGHT ON WATER",
  });

  const board = leaderboard(db, challenge.id);
  assert.equal(board.players, 2);
  assert.deepEqual(
    board.top.map((row) => row.score),
    [88, 88],
  );
});

// Requirement 12 of the spec's ordering rules.
test("ties break by submission time, then by submission id", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);

  await seed(db, challenge, [
    ["p1", "First", "answer one", 50, "2026-09-30T10:00:00Z"],
    ["p2", "Second", "answer two", 50, "2026-09-30T09:00:00Z"],
    ["p3", "Third", "answer three", 90, "2026-09-30T12:00:00Z"],
  ]);

  const board = leaderboard(db, challenge.id);
  assert.deepEqual(
    board.top.map((row) => [row.rank, row.name, row.score]),
    [
      [1, "Third", 90],
      [2, "Second", 50],
      [3, "First", 50],
    ],
  );

  // Deterministic: repeated reads give the identical ordering.
  assert.deepEqual(leaderboard(db, challenge.id).top, board.top);
});

test("identical scores and identical timestamps still order deterministically", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);
  const at = "2026-09-30T10:00:00Z";

  await seed(db, challenge, [
    ["p1", "One", "answer one", 50, at],
    ["p2", "Two", "answer two", 50, at],
    ["p3", "Three", "answer three", 50, at],
  ]);

  const first = leaderboard(db, challenge.id).top.map((row) => row.name);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(leaderboard(db, challenge.id).top.map((row) => row.name), first);
  }
});

test("a player outside the top slice still gets their own row", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const challenge = todaysChallenge(db);

  const rows = [];
  for (let i = 0; i < 12; i += 1) {
    rows.push([`p${i}`, `Player ${i}`, `answer ${i}`, 100 - i, `2026-09-30T10:${String(i).padStart(2, "0")}:00Z`]);
  }
  await seed(db, challenge, rows);

  const board = leaderboard(db, challenge.id, { limit: 10, playerId: "p11" });
  assert.equal(board.top.length, 10);
  assert.equal(board.players, 12);
  assert.ok(board.you, "a player below the visible slice must still be shown");
  assert.equal(board.you.rank, 12);
  assert.equal(board.you.name, "Player 11");
  assert.equal(board.you.you, true);

  // A player inside the slice is flagged there instead of duplicated.
  const inside = leaderboard(db, challenge.id, { limit: 10, playerId: "p0" });
  assert.equal(inside.you, null);
  assert.equal(inside.top[0].you, true);
});

test("the leaderboard is scoped to one challenge", async (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const today = todaysChallenge(db, "2026-09-30");
  const tomorrow = todaysChallenge(db, "2026-10-01");

  await seed(db, today, [["p1", "Ada", "sunlight", 90, "2026-09-30T10:00:00Z"]]);

  assert.equal(leaderboard(db, today.id).players, 1);
  assert.equal(leaderboard(db, tomorrow.id).players, 0);
  assert.deepEqual(leaderboard(db, tomorrow.id).top, []);
});
