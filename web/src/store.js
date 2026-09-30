/**
 * Per-browser local state: this player's attempts at today's challenge, their
 * name, and the local-only leaderboard used when no backend is configured.
 *
 * When a shared backend is configured this is a cache/fallback, not the
 * authority - the server independently tracks and enforces the 3-attempt
 * limit (see worker/src/index.js), and on load the client reconciles against
 * the server's own record of this player's attempts. Without a backend, this
 * is all there is, and it is enforced here instead.
 */

import { MAX_ATTEMPTS } from "@shared/challenges.js";

const ATTEMPTS_PREFIX = "jgg.attempts.";
const NAME_KEY = "jgg.name";
const LOCAL_BOARD_PREFIX = "jgg.localboard.";

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing or full storage: play continues, nothing is remembered.
  }
}

export function savedName() {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function rememberName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Ignored.
  }
}

// --- attempts ----------------------------------------------------------
// Each attempt: { attemptNumber, answer, score, noul, at }. Score is full
// precision; formatting to two decimals happens only at render time.

export function localAttempts(challengeId) {
  const rows = read(ATTEMPTS_PREFIX + challengeId);
  return Array.isArray(rows) ? rows : [];
}

/** Append an attempt locally. Silently caps at MAX_ATTEMPTS. */
export function addLocalAttempt(challengeId, attempt) {
  const rows = localAttempts(challengeId);
  if (rows.length >= MAX_ATTEMPTS) return rows;
  const next = [...rows, { ...attempt, attemptNumber: rows.length + 1 }];
  write(ATTEMPTS_PREFIX + challengeId, next);
  return next;
}

/** Replace the whole attempt list - used to reconcile with the server's copy. */
export function setLocalAttempts(challengeId, attempts) {
  write(ATTEMPTS_PREFIX + challengeId, attempts);
}

// --- local-only leaderboard ------------------------------------------------
// Used only when no shared backend is configured. Keeps each name's best
// score, mirroring how the real backend ranks players.

export function localBoard(challengeId) {
  const rows = read(LOCAL_BOARD_PREFIX + challengeId);
  return Array.isArray(rows) ? rows : [];
}

export function addToLocalBoard(challengeId, entry) {
  const rows = localBoard(challengeId).filter((row) => row.name !== entry.name);
  rows.push(entry);
  rows.sort((a, b) => b.score - a.score || String(a.at).localeCompare(String(b.at)));
  write(LOCAL_BOARD_PREFIX + challengeId, rows.slice(0, 50));
  return rows;
}
