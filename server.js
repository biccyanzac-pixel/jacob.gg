import crypto from "node:crypto";
import express from "express";
import { loadEnv } from "./lib/env.js";

// Must run before any module reads process.env at import time.
loadEnv();

let openDatabase;
try {
  ({ openDatabase } = await import("./lib/db.js"));
} catch (err) {
  if (err?.code === "ERR_UNKNOWN_BUILTIN_MODULE" || /node:sqlite/.test(String(err?.message))) {
    console.error(
      "This app uses Node's built-in SQLite (node:sqlite), which needs Node 22.5 or newer.\n" +
        "On Node 22.x, start it with:  node --experimental-sqlite server.js\n" +
        "On Node 24+ it works with:    npm start",
    );
    process.exit(1);
  }
  throw err;
}

const { ensureChallenge, msUntilNextDay, todayKey } = await import("./lib/challenges.js");
const { GameError, MAX_ANSWER, MAX_NAME, findSubmission, leaderboard, play } = await import(
  "./lib/game.js"
);
const { jevJudge, judgeModel } = await import("./lib/judge.js");

const PORT = Number(process.env.PORT) || 3000;
const TOKEN_COOKIE = "jgg_player";
const BOARD_SIZE = 10;

const db = openDatabase();

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "8kb" }));

// --- player identity -------------------------------------------------------
// DEMO IDENTITY. The cookie is the player id. It is not authentication: a
// player who clears cookies or opens a private window gets a new identity and
// another attempt. The point of the cookie is that the *server* derives the
// identity and the database enforces one attempt per identity - the browser is
// never asked whether it has already played. Swap this for real accounts and
// the rest of the model (unique(player_id, challenge_id)) is unchanged.

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim()) || null;
    } catch {
      return null;
    }
  }
  return null;
}

// A cookie value is attacker-controlled, so accept only our own shape.
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

app.use((req, res, next) => {
  const raw = readCookie(req, TOKEN_COOKIE);
  let token = raw && TOKEN_PATTERN.test(raw) ? raw : null;
  if (!token) {
    token = crypto.randomUUID();
    res.cookie(TOKEN_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 400 * 24 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === "production",
    });
  }
  req.playerId = token;
  next();
});

// --- rate limiting ---------------------------------------------------------
// A cached answer costs nothing, but a new one costs an API call, so cap
// submissions per IP. In-memory, which matches the single-process deployment.

const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 20;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.set(ip, recent);
  if (recent.length >= RATE_MAX) return true;
  recent.push(now);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of hits) {
    if (times.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

// --- views -----------------------------------------------------------------
// Player-facing shapes only. The raw noul, the model name, the answer hash and
// the scoring version are all deliberately absent - the player sees a score.

function resultView(submission, evaluation) {
  if (!submission) return null;
  return {
    answer: submission.original_answer,
    score: evaluation?.score ?? submission.score,
    submittedAt: submission.submitted_at,
  };
}

function todayState(playerId) {
  const challenge = ensureChallenge(db, todayKey());
  const submission = findSubmission(db, playerId, challenge.id);
  return {
    day: challenge.day_key,
    number: challenge.dayNumber,
    prompt: challenge.prompt,
    hint: challenge.hint,
    maxAnswer: MAX_ANSWER,
    maxName: MAX_NAME,
    resetsInMs: msUntilNextDay(),
    result: resultView(submission, null),
    leaderboard: leaderboard(db, challenge.id, { limit: BOARD_SIZE, playerId }),
  };
}

// --- routes ----------------------------------------------------------------

app.get("/api/today", (req, res, next) => {
  try {
    res.json(todayState(req.playerId));
  } catch (err) {
    next(err);
  }
});

// Reads stored rows only. There is no path from here to the judge.
app.get("/api/leaderboard", (req, res, next) => {
  try {
    const challenge = ensureChallenge(db, todayKey());
    res.json(leaderboard(db, challenge.id, { limit: BOARD_SIZE, playerId: req.playerId }));
  } catch (err) {
    next(err);
  }
});

app.post("/api/play", async (req, res, next) => {
  try {
    const challenge = ensureChallenge(db, todayKey());
    const playerId = req.playerId;

    if (rateLimited(req.ip)) {
      return res.status(429).json({
        error: "rate_limited",
        message: "Too many submissions from here. Try again later.",
      });
    }

    const { submission, evaluation } = await play({
      db,
      judge: jevJudge,
      challenge,
      playerId,
      name: req.body?.name,
      answer: req.body?.answer,
    });

    res.json({
      result: resultView(submission, evaluation),
      leaderboard: leaderboard(db, challenge.id, { limit: BOARD_SIZE, playerId }),
    });
  } catch (err) {
    next(err);
  }
});

app.use(express.static("public", { extensions: ["html"] }));

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "not_found", message: "No such endpoint." });
  }
  res.status(404).sendFile("404.html", { root: "public" }, (err) => {
    if (err) res.status(404).type("text/plain").send("Not found");
  });
});

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
app.use((err, req, res, next) => {
  // Expected, player-facing outcomes: validation and one-attempt-per-day.
  if (err instanceof GameError) {
    const body = { error: err.code, message: err.message };
    if (err.code === "already_played") {
      const challenge = ensureChallenge(db, todayKey());
      body.result = resultView(err.submission, null);
      body.leaderboard = leaderboard(db, challenge.id, {
        limit: BOARD_SIZE,
        playerId: req.playerId,
      });
    }
    return res.status(err.status || 400).json(body);
  }

  console.error("[jacob.gg]", err);

  // Scoring is misconfigured: an operator fix, not a player one.
  if (err.code === "JEV_UNCONFIGURED" || err.code === "JEV_UNAUTHORIZED") {
    return res.status(503).json({
      error: "scoring_unconfigured",
      message: "Scoring is not configured. Add JEV_API_KEY to .env, then submit again.",
    });
  }

  // Any other judge failure. Nothing was stored and no attempt was consumed,
  // so the honest message is that it did not count and can be retried.
  if (err.name === "JudgeError") {
    const temporary = err.retryable === true;
    return res.status(temporary ? 503 : 502).json({
      error: "scoring_unavailable",
      message: temporary
        ? "Scoring is busy right now. Your answer was not counted - try again in a moment."
        : "Scoring is unavailable right now. Your answer was not counted - try again.",
      retryable: true,
    });
  }

  res.status(500).json({
    error: "server_error",
    message: "Something broke on our side. Your answer was not counted.",
  });
});

const server = app.listen(PORT, () => {
  const challenge = ensureChallenge(db, todayKey());
  console.log(`jacob.gg daily is on http://localhost:${PORT}`);
  console.log(`challenge: ${challenge.id} | judge: ${judgeModel}`);
  if (!process.env.JEV_API_KEY) {
    console.warn(
      "warning: no JEV_API_KEY set. Add your key to .env (no restart needed),\n" +
        "         or new answers cannot be scored (stored ones still work).",
    );
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
