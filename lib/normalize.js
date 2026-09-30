import crypto from "node:crypto";

// Domain separator, so a hash from this app can never collide with a hash
// computed over the same fields by something else.
const HASH_DOMAIN = "jacob.gg/daily/answer-hash/v1";

/**
 * Normalise an answer for deduplication only.
 *
 * The rules, in order:
 *   1. Unicode NFKC normalisation (so composed and decomposed forms match).
 *   2. Remove zero-width and BOM characters, which are invisible to the player
 *      but would otherwise defeat deduplication.
 *   3. Normalise line endings (CRLF and CR both become LF).
 *   4. Collapse runs of horizontal whitespace to a single space.
 *   5. Strip spaces around newlines and collapse blank-line runs.
 *   6. Trim leading and trailing whitespace.
 *   7. Case-fold via toLowerCase(), then re-apply NFKC, because lowercasing
 *      can move a string out of normal form.
 *
 * Punctuation, wording, emoji and word order are left alone: this must not
 * change what the answer means, only how it is spelled.
 */
export function normalizeAnswer(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .toLowerCase()
    .normalize("NFKC");
}

/**
 * SHA-256 over (domain, challenge id, scoring version, normalised answer).
 *
 * Every field is length-prefixed before hashing, so no combination of field
 * values can be re-read as a different combination - plain concatenation would
 * let ("a", "bc") and ("ab", "c") collide.
 */
export function answerHash({ challengeId, scoringVersion, normalizedAnswer }) {
  if (typeof challengeId !== "string" || challengeId === "") {
    throw new TypeError("answerHash: challengeId must be a non-empty string");
  }
  if (!Number.isInteger(scoringVersion)) {
    throw new TypeError("answerHash: scoringVersion must be an integer");
  }
  if (typeof normalizedAnswer !== "string") {
    throw new TypeError("answerHash: normalizedAnswer must be a string");
  }

  const hash = crypto.createHash("sha256");
  for (const field of [HASH_DOMAIN, challengeId, String(scoringVersion), normalizedAnswer]) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}
