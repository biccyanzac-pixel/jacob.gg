/**
 * Answer normalisation and hashing, isomorphic.
 *
 * Same rules as lib/normalize.js, but hashing uses Web Crypto so the browser,
 * a Cloudflare Worker and Node can all produce identical hashes. Web Crypto's
 * digest is async, hence the Promise.
 *
 * test/shared-parity.test.js asserts this and lib/normalize.js agree on a
 * corpus, so the browser, the worker and the Express server can never disagree
 * about what counts as the same answer.
 */

const HASH_DOMAIN = "jacob.gg/daily/answer-hash/v1";

/**
 * Normalise an answer for deduplication only.
 *
 *   1. Unicode NFKC normalisation.
 *   2. Remove zero-width characters and BOMs.
 *   3. Normalise line endings (CRLF and CR both become LF).
 *   4. Collapse runs of horizontal whitespace to a single space.
 *   5. Strip spaces around newlines and collapse blank-line runs.
 *   6. Trim.
 *   7. Lowercase, then re-apply NFKC (lowercasing can break normal form).
 *
 * Punctuation, wording, emoji and word order are left alone: this changes how
 * an answer is spelled, never what it means.
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

function lengthPrefixed(fields) {
  const encoder = new TextEncoder();
  const parts = [];
  let total = 0;
  for (const field of fields) {
    const bytes = encoder.encode(field);
    const header = new Uint8Array(4);
    // 4-byte big-endian length, so no combination of field values can be
    // re-read as a different combination.
    new DataView(header.buffer).setUint32(0, bytes.length, false);
    parts.push(header, bytes);
    total += header.length + bytes.length;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/**
 * SHA-256 over (domain, challenge id, scoring version, normalised answer),
 * every field length-prefixed. Returns lowercase hex.
 */
export async function answerHash({ challengeId, scoringVersion, normalizedAnswer }) {
  if (typeof challengeId !== "string" || challengeId === "") {
    throw new TypeError("answerHash: challengeId must be a non-empty string");
  }
  if (!Number.isInteger(scoringVersion)) {
    throw new TypeError("answerHash: scoringVersion must be an integer");
  }
  if (typeof normalizedAnswer !== "string") {
    throw new TypeError("answerHash: normalizedAnswer must be a string");
  }

  const bytes = lengthPrefixed([
    HASH_DOMAIN,
    challengeId,
    String(scoringVersion),
    normalizedAnswer,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
