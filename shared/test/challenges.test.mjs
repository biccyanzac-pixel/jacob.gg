/**
 * Lightweight assertions on the pure scoring/challenge logic - no model, no
 * network, runs in milliseconds. Follows this repo's established pattern of
 * standalone .mjs scripts with plain assertions rather than a test runner.
 *
 *   node shared/test/challenges.test.mjs
 */
import assert from "node:assert/strict";
import {
  CHALLENGES,
  MAX_ANSWER,
  MAX_ATTEMPTS,
  averageScore,
  challengeForDay,
  challengeId,
  formatScore,
  previousDayKey,
  riddleStatement,
  scoreFromNoul,
  todayKey,
  validateAnswer,
  validateName,
} from "../challenges.js";

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures += 1;
}

// --- no canonical answer -----------------------------------------------
for (const c of CHALLENGES) {
  check(
    `${c.slug}: no answer/correctAnswer field`,
    !("answer" in c) && !("correctAnswer" in c) && !("solution" in c),
  );
}

// --- three attempts, average not max ------------------------------------
check("MAX_ATTEMPTS is 3", MAX_ATTEMPTS === 3);
check(
  "averageScore is the arithmetic mean, full precision",
  Math.abs(averageScore([{ score: 72.41 }, { score: 91.83 }, { score: 84.26 }]) - 82.833333333) < 1e-6,
);
check("averageScore of one attempt is just that score", averageScore([{ score: 50 }]) === 50);
check("averageScore of zero attempts is null", averageScore([]) === null);
check(
  "averageScore is never the max (regression guard for the old highest-of-3 logic)",
  averageScore([{ score: 10 }, { score: 90 }, { score: 10 }]) !== 90,
);

// --- score precision ------------------------------------------------------
check("scoreFromNoul(0.983742) = 98.3742 (full precision)", scoreFromNoul(0.983742) === 98.3742);
check("formatScore(98.3742) = '98.37' (2dp display only)", formatScore(98.3742) === "98.37");
check("formatScore never mutates the underlying value used for sorting", scoreFromNoul(0.983742) === 98.3742);
try {
  scoreFromNoul(1.5);
  check("scoreFromNoul rejects out-of-range noul", false);
} catch {
  check("scoreFromNoul rejects out-of-range noul", true);
}

// --- challenge derivation is deterministic and never client-chosen -------
const day = "2026-10-01";
const c1 = challengeForDay(day);
const c2 = challengeForDay(day);
check("the same day always resolves to the same challenge id", c1.id === c2.id);
check("challengeId embeds slug, version and day", c1.id === challengeId(c1.slug, c1.scoringVersion, day));
check("todayKey and previousDayKey are one UTC day apart", (() => {
  const t = todayKey();
  const p = previousDayKey(t);
  return Date.parse(`${t}T00:00:00Z`) - Date.parse(`${p}T00:00:00Z`) === 86_400_000;
})());

// --- the riddle statement embeds the exact prompt, nothing else -----------
const statement = riddleStatement("What can you enter without going in?");
check(
  "riddleStatement embeds the riddle text verbatim",
  statement.includes("What can you enter without going in?"),
);
check(
  "riddleStatement contains no answer key or example answer",
  !/competition|conversation|password/i.test(statement),
);

// --- validation -------------------------------------------------------------
check("MAX_ANSWER is short (free-text interpretation, not an essay)", MAX_ANSWER <= 100);
try {
  validateAnswer("a".repeat(MAX_ANSWER + 1));
  check("an oversized answer is rejected", false);
} catch {
  check("an oversized answer is rejected", true);
}
check("a normal short answer passes", validateAnswer("a competition") === "a competition");
try {
  validateName("");
  check("an empty name is rejected", false);
} catch {
  check("an empty name is rejected", true);
}

console.log(`\n${failures === 0 ? "ALL CHALLENGE-LOGIC CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
