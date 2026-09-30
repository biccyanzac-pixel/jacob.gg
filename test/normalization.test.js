import test from "node:test";
import assert from "node:assert/strict";
import { answerHash, normalizeAnswer } from "../lib/normalize.js";

const CHALLENGE = "fun-happy-thought@v1:2026-09-30";

const hashOf = (answer, { challengeId = CHALLENGE, scoringVersion = 1 } = {}) =>
  answerHash({
    challengeId,
    scoringVersion,
    normalizedAnswer: normalizeAnswer(answer),
  });

// Requirement 3: case and whitespace differences must produce the same hash.
test("case and whitespace variants normalise to the same hash", () => {
  const variants = [
    "I love eating ice cream in the sunshine",
    "i LOVE eating   ice cream in the sunshine",
    "   I love eating ice cream in the sunshine   ",
    "I\tlove eating ice cream in the sunshine",
    "I love eating ice cream in the sunshine\n",
  ];

  const normalised = variants.map(normalizeAnswer);
  for (const value of normalised) {
    assert.equal(value, normalised[0], `normalised forms differ: ${JSON.stringify(normalised)}`);
  }

  const hashes = variants.map((v) => hashOf(v));
  for (const hash of hashes) assert.equal(hash, hashes[0]);
});

test("line endings normalise across CRLF, CR and LF", () => {
  assert.equal(normalizeAnswer("a\r\nb"), normalizeAnswer("a\nb"));
  assert.equal(normalizeAnswer("a\rb"), normalizeAnswer("a\nb"));
  assert.equal(hashOf("a\r\nb"), hashOf("a\nb"));
});

test("unicode composed and decomposed forms normalise together", () => {
  // "cafe" with a precomposed e-acute vs. e + combining acute.
  assert.equal(normalizeAnswer("café mornings"), normalizeAnswer("café mornings"));
  assert.equal(hashOf("café mornings"), hashOf("café mornings"));
});

test("zero-width characters do not defeat deduplication", () => {
  assert.equal(hashOf("sun​shine"), hashOf("sunshine"));
});

test("normalisation does not rewrite semantic content", () => {
  // Punctuation, emoji and word order are preserved: only spelling is folded.
  assert.equal(normalizeAnswer("Ice cream! In the sun? ☀️"), "ice cream! in the sun? ☀️");
  assert.notEqual(normalizeAnswer("dogs love rain"), normalizeAnswer("rain loves dogs"));
  assert.notEqual(normalizeAnswer("ice cream"), normalizeAnswer("ice-cream"));
});

// Requirement 4, at the hash level.
test("a different answer produces a different hash", () => {
  assert.notEqual(hashOf("I love summer"), hashOf("I love winter"));
});

// Requirement 5, at the hash level.
test("the same answer under a different challenge produces a different hash", () => {
  assert.notEqual(
    hashOf("I love summer"),
    hashOf("I love summer", { challengeId: "fun-happy-thought@v1:2026-10-01" }),
  );
});

// Requirement 6, at the hash level.
test("the same answer under a different scoring version produces a different hash", () => {
  assert.notEqual(hashOf("I love summer"), hashOf("I love summer", { scoringVersion: 2 }));
});

test("hashes are SHA-256 hex and stable across calls", () => {
  const hash = hashOf("I love summer");
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, hashOf("I love summer"));
});

test("field boundaries are unambiguous", () => {
  // Length-prefixed fields: moving a character across a boundary must change
  // the hash. Plain concatenation would collide here.
  assert.notEqual(
    answerHash({ challengeId: "ab", scoringVersion: 1, normalizedAnswer: "c" }),
    answerHash({ challengeId: "a", scoringVersion: 1, normalizedAnswer: "bc" }),
  );
});

test("hash inputs are validated", () => {
  assert.throws(() => answerHash({ challengeId: "", scoringVersion: 1, normalizedAnswer: "x" }));
  assert.throws(() => answerHash({ challengeId: "c", scoringVersion: 1.5, normalizedAnswer: "x" }));
  assert.throws(() => answerHash({ challengeId: "c", scoringVersion: 1, normalizedAnswer: null }));
});
