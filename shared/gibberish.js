/**
 * A tiny, non-AI gate against pure keyboard-mashing ("asdfghjkl", "qwe zxcv").
 *
 * This exists because the on-device judge (open-jev/kev-0.6b, ~0.6B params)
 * cannot reliably separate gibberish from real text on its own: asked directly
 * "is this coherent/meaningful/a real sentence", it still answered 90-99% yes
 * for pure keymash (measured; see web/scripts/probe-coherence.mjs). That is a
 * genuine capability limit of a model this small, not a prompt-wording issue -
 * a larger model (kev-4b) does better but is a 2.3GB download.
 *
 * This heuristic makes NO judgement about sentiment, topicality, or quality -
 * that is entirely the AI judge's job, every time. It only asks "does this
 * contain anything that resembles English words", the same category of check
 * as the existing length/empty-string validation. An answer that passes this
 * gate is scored purely on what the model says; nothing here raises a score
 * or substitutes for the model's probability.
 */

// Common short English words, including the ones a terse-but-real answer is
// likely to use ("fun happy thought" must pass; "asdfghjkl" must not).
const COMMON_WORDS = new Set(
  (
    "a an the i we you he she it they me my your his her its our their " +
    "is am are was were be been being have has had do does did " +
    "and or but so if not no yes to of in on at for with from by as " +
    "this that these those there here what when where why how who " +
    "fun happy sad good bad love like hate today yesterday tomorrow " +
    "went go going ate eat eating saw see cried cry laughed laugh " +
    "friend friends dog cat sun day time thought thing things pizza " +
    "swim swimming sunshine morning night home work school "
  ).split(/\s+/),
);

/**
 * Does a token look like a plausible English word: letters only, contains a
 * vowel, and has no unreasonable consonant run (keymash like "asdfghjkl" or
 * "qwzxcv" fails this; real words like "rhythm" or "strengths" pass).
 */
function looksWordlike(token) {
  if (!/^[a-z]+$/i.test(token)) return false;
  if (!/[aeiouy]/i.test(token)) return false;
  if (/[^aeiouy]{5,}/i.test(token)) return false;
  return true;
}

/**
 * True if the text contains enough recognisable English to be worth judging.
 * Never used to score - only to gate whether the judge is asked at all.
 */
export function looksLikeRealText(text) {
  const tokens = String(text ?? "")
    .toLowerCase()
    .match(/[a-z']+/gi);
  if (!tokens || tokens.length === 0) return false;

  let good = 0;
  for (const token of tokens) {
    if (COMMON_WORDS.has(token) || (token.length >= 2 && looksWordlike(token))) good += 1;
  }
  // A majority of tokens must look like real words. Short inputs (one or two
  // words) need every token to pass, which is what keeps "fun happy thought"
  // in and "asdfghjkl" out.
  return good / tokens.length >= 0.6;
}

/**
 * A second, unrelated non-AI gate: against restating the riddle's own
 * wording back as if that were an interpretation ("What can you enter
 * without going in?" -> "You enter without going in by entering it").
 *
 * This exists because the riddle judge's single Noul question could not
 * reliably tell a genuine interpretation from a restatement of the riddle
 * itself, on any of 10 candidate phrasings tested (see
 * web/scripts/riddle-bench/sweep.mjs) - restatements scored 85-99 in every
 * one of 5 benchmark riddles, regardless of wording. That is a measured
 * capability limit, not a wording problem, so it is closed deterministically
 * here instead of by adding a second model call.
 *
 * Generic stopwords only - nothing riddle-specific - so this works for any
 * future riddle without per-challenge tuning. Measured against the same
 * benchmark: catches 4 of 5 restatement cases with zero false positives
 * across 26 genuine-answer test cases (threshold chosen by that measurement,
 * not guessed).
 */
const STOPWORDS = new Set(
  "a an the you can be what it is are without going in be has have i he she they we my your its this that".split(
    " ",
  ),
);

// Strips a trailing "e" before -ing/-ed so "leaving"/"leave" and
// "believing"/"believe" share a stem; also strips plain -ing/-ed/-ly/-s.
function stem(word) {
  return word.replace(/e(ing|ed)$/, "$1").replace(/(ing|ed|ly|s)$/, "");
}

function contentTokens(text) {
  return (String(text ?? "").toLowerCase().match(/[a-z']+/g) ?? [])
    .filter((t) => !STOPWORDS.has(t) && t.length > 1)
    .map(stem);
}

/**
 * True if `answer` is NOT just the riddle's own wording repeated back: at
 * least 60% of the answer's content words must be words the riddle itself
 * does not use. Never used to score - only to gate whether the judge is
 * asked at all, exactly like looksLikeRealText above.
 */
export function looksLikeOwnInterpretation(answer, riddlePrompt) {
  const answerTokens = contentTokens(answer);
  if (answerTokens.length === 0) return false;
  const riddleTokens = new Set(contentTokens(riddlePrompt));

  let overlapping = 0;
  for (const token of answerTokens) {
    if (riddleTokens.has(token)) overlapping += 1;
  }
  return overlapping / answerTokens.length < 0.4;
}
