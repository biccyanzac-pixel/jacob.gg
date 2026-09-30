/**
 * Per-browser local state: the player's own result for a challenge, their
 * name, and the local-only leaderboard used when no backend is configured.
 *
 * This is convenience and offline fallback, not the authority. When a backend
 * is configured it enforces one submission per player per challenge; this only
 * stops the same browser from replaying the form.
 */

const RESULT_PREFIX = "jgg.result.";
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

export function savedResult(challengeId) {
  const value = read(RESULT_PREFIX + challengeId);
  if (!value || typeof value.score !== "number" || typeof value.answer !== "string") return null;
  return value;
}

export function saveResult(challengeId, result) {
  write(RESULT_PREFIX + challengeId, result);
}

// --- local-only leaderboard ------------------------------------------------

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
