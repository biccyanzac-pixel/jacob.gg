/**
 * Leaderboard client.
 *
 * The scoring happens in the browser, so the only thing the backend does is
 * keep the shared leaderboard: validate a submission, store it once, and hand
 * back the board. If no backend is configured the game still plays and keeps
 * the player's own result locally - it just cannot show other people.
 *
 * config.json is read at runtime (not baked into the bundle) so the backend
 * can be switched on later by editing one file, with no rebuild.
 */

const CONFIG_URL = new URL("config.json", document.baseURI).href;

const SESSION_KEY = "jgg.session.v2";

let config = null;

export async function loadConfig() {
  if (config) return config;
  try {
    const response = await fetch(CONFIG_URL, { cache: "no-cache" });
    config = response.ok ? await response.json() : {};
  } catch {
    config = {};
  }
  const url = typeof config.leaderboardUrl === "string" ? config.leaderboardUrl.trim() : "";
  config.leaderboardUrl = url ? url.replace(/\/+$/, "") : null;
  return config;
}

export function leaderboardEnabled() {
  return Boolean(config?.leaderboardUrl);
}

async function call(path, options = {}) {
  const base = config?.leaderboardUrl;
  if (!base) throw new Error("no leaderboard configured");
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON body: treated as an error below.
  }
  if (!response.ok && response.status !== 409) {
    const error = new Error(body?.message || `Leaderboard error (HTTP ${response.status}).`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

/**
 * A server-issued player identity. The id is signed by the server, so a
 * browser cannot invent one: submissions carry the token and the server
 * verifies it. Stored locally so the same browser keeps the same identity.
 */
export async function session() {
  const cached = readSession();
  if (cached) return cached;

  const issued = await call("/api/session", { method: "POST", body: "{}" });
  if (!issued?.playerId || !issued?.token) throw new Error("could not start a session");
  const value = { playerId: issued.playerId, token: issued.token };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(value));
  } catch {
    // Private browsing: the session simply will not persist.
  }
  return value;
}

function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value?.playerId && value?.token ? value : null;
  } catch {
    return null;
  }
}

/** Today's shared leaderboard. */
export async function fetchLeaderboard(challengeId) {
  const cached = readSession();
  const query = new URLSearchParams({ challengeId });
  if (cached?.playerId) query.set("playerId", cached.playerId);
  return call(`/api/leaderboard?${query}`);
}

/**
 * Submit a played answer. The server recomputes today's challenge, re-derives
 * the score from the noul, checks the hash and stores at most one submission
 * per player per challenge.
 */
export async function submit(payload) {
  const { playerId, token } = await session();
  return call("/api/play", {
    method: "POST",
    body: JSON.stringify({ ...payload, playerId, token }),
  });
}
