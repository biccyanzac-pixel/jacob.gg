import { canonicalizeForJudge } from "../judge-canonicalize.js";

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures += 1;
}

// --- cosmetic variants that must all canonicalise to the same thing -------
const roomVariants = [
  "A room",
  " a room ",
  "A  ROOM",
  "a room.",
  "A room!",
  "A room?",
  "A room,",
  '"A room"',
  "(A room)",
  "  A  room  ",
  "'A room'",
];
const canonicalRoom = canonicalizeForJudge("A room");
check("baseline canonicalises to 'a room'", canonicalRoom === "a room", `got "${canonicalRoom}"`);
for (const variant of roomVariants) {
  const got = canonicalizeForJudge(variant);
  check(`"${variant}" canonicalises to "a room"`, got === "a room", `got "${got}"`);
}

// --- semantic/wording variants that must remain distinct -------------------
const distinctPairs = [
  ["competition", "a competition"],
  ["exit", "an exit"],
  ["dead-end", "dead end"],
  ["don't look back", "dont look back"],
];
for (const [a, b] of distinctPairs) {
  const ca = canonicalizeForJudge(a);
  const cb = canonicalizeForJudge(b);
  check(`"${a}" and "${b}" remain distinct after canonicalisation`, ca !== cb, `"${ca}" vs "${cb}"`);
}

// --- specific preservation checks -------------------------------------------
check("hyphen inside a word is preserved", canonicalizeForJudge("a dead-end") === "a dead-end");
check("apostrophe inside a contraction is preserved", canonicalizeForJudge("don't look back") === "don't look back");
check("article 'a' is preserved, not stripped", canonicalizeForJudge("a competition") === "a competition");
check("article 'an' is preserved, not stripped", canonicalizeForJudge("an exit") === "an exit");
check(
  "mid-sentence period in an abbreviation is preserved (not trailing)",
  canonicalizeForJudge("4 p.m. sharp") === "4 p.m. sharp",
);
check(
  "a lone leading or trailing apostrophe from a contraction at the edge is not treated as wrapping",
  canonicalizeForJudge("'tis the season") === "'tis the season",
);

// --- edge cases --------------------------------------------------------------
check("empty string stays empty", canonicalizeForJudge("") === "");
check("null/undefined does not throw", canonicalizeForJudge(undefined) === "");
check(
  "multiple trailing punctuation marks all stripped",
  canonicalizeForJudge("A room?!") === "a room",
);
check(
  "wrapping quotes with internal padding handled",
  canonicalizeForJudge('"  A room  "') === "a room",
);
check(
  "tabs and newlines collapse like spaces",
  canonicalizeForJudge("A\troom\n\nhere") === "a room here",
);

console.log(`\n${failures === 0 ? "ALL CANONICALIZATION CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
