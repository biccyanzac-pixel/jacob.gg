/**
 * Narrow text canonicalisation applied ONLY to the text sent to the judge,
 * never to what is stored, displayed, hashed, or used for duplicate-answer
 * detection (see shared/normalize.js's normalizeAnswer() for that - a
 * deliberately separate concern: duplicate detection decides whether a
 * second attempt is allowed at all; this decides what text the model
 * actually sees for scoring. They happen to overlap on case/whitespace
 * today, but that is incidental, not a reason to share one function - if
 * either rule set changes independently later, nothing here should break.
 *
 * Evidence for exactly this scope (web/scripts/kev-wasm-export/
 * BENCHMARK.md and formatting_results_v2.json): capitalisation, leading/
 * trailing whitespace, repeated internal whitespace, and whole-answer
 * wrapping/trailing punctuation all moved the judge's score by a
 * meaningful amount (6-42 points) between inputs a player would reasonably
 * consider "the same answer" typed differently. Hyphens and contraction
 * apostrophes also measurably moved the score (3.8 and 8.6 points) but are
 * deliberately NOT touched here - that data does not prove collapsing them
 * is safe, only that they have an effect, and an effect is not evidence
 * the model is wrong to have it. Articles ("a"/"an") moved the score by
 * even more (up to ~38 points) and are a genuine wording difference, not
 * formatting - never touched here, regardless of magnitude.
 */

// Pairs of characters that, when they are literally the first and last
// character of the whole (already trimmed) answer, are read as wrapping
// the entire thing rather than being part of any word - e.g. the stray
// quote marks a player adds around their answer. A lone apostrophe at only
// one end (a contraction like "it's" or "'cause") never matches this: both
// ends have to agree, which a contraction's apostrophe does not do.
const WRAPPING_PAIRS = [
  ['"', '"'],
  ["'", "'"],
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["“", "”"], // “ ”
  ["‘", "’"], // ‘ ’
];

// Only sentence-ending marks, stripped only when they are the LAST
// character(s) of the whole answer - never mid-word, so "4 p.m." and
// "dead-end" and "don't" are untouched (none of ".!?," appear at their
// very end, and even if they did, this never looks inside the string).
const TRAILING_PUNCTUATION = /[.!?,]+$/;

function stripWrapping(text) {
  if (text.length < 2) return text;
  for (const [open, close] of WRAPPING_PAIRS) {
    if (text[0] === open && text[text.length - 1] === close) {
      return text.slice(1, -1).trim();
    }
  }
  return text;
}

/**
 * Canonicalise one answer for the judge only.
 *
 *   1. Lowercase.
 *   2. Collapse any run of whitespace (including tabs/newlines) to a
 *      single space.
 *   3. Trim.
 *   4. Strip one layer of whole-answer wrapping punctuation, if present.
 *   5. Trim again (the wrapped text may have had its own padding).
 *   6. Strip trailing sentence punctuation, if present.
 *   7. Trim once more, defensively.
 *
 * Deliberately NOT done, by design, regardless of any score effect
 * measured for it: removing hyphens or apostrophes, touching articles,
 * reordering words, stemming, or any synonym/semantic normalisation.
 */
export function canonicalizeForJudge(text) {
  let s = String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  s = stripWrapping(s).trim();
  s = s.replace(TRAILING_PUNCTUATION, "").trim();
  return s;
}
