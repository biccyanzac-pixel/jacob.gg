import "./style.css";
import {
  MAX_ANSWER,
  MAX_ATTEMPTS,
  averageScore,
  challengeForDay,
  formatScore,
  msUntilNextDay,
  previousDayKey,
  todayKey,
  validateAnswer,
  validateName,
} from "@shared/challenges.js";
import { answerHash, normalizeAnswer } from "@shared/normalize.js";
import { looksLikeOwnInterpretation, looksLikeRealText } from "@shared/gibberish.js";
import { PHASE, UnsupportedDeviceError, judgeInfo, loadJudge, scoreAnswer } from "./judge.js";
import { fetchAttempts, fetchLeaderboard, leaderboardEnabled, loadConfig, submit } from "./api.js";
import {
  addLocalAttempt,
  addToLocalBoard,
  localAttempts,
  localBoard,
  rememberName,
  savedName,
  setLocalAttempts,
} from "./store.js";

const $ = (id) => document.getElementById(id);
const el = {
  daynum: $("daynum"),
  countdown: $("countdown"),
  prompt: $("prompt"),
  attemptsNote: $("attempts-note"),
  preparing: $("preparing"),
  preparingText: $("preparing-text"),
  preparingBar: $("preparing-bar"),
  preparingNote: $("preparing-note"),
  play: $("play"),
  name: $("name"),
  answer: $("answer"),
  counter: $("counter"),
  error: $("error"),
  submit: $("submit"),
  attemptNumber: $("attempt-number"),
  attempts: $("attempts"),
  dailyScore: $("daily-score"),
  dailyScoreCaption: $("daily-score-caption"),
  attemptList: $("attempt-list"),
  attemptsDone: $("attempts-done"),
  board: $("board"),
  rows: $("rows"),
  players: $("players"),
  boardEmpty: $("board-empty"),
  boardLocked: $("board-locked"),
  boardNote: $("board-note"),
  yesterday: $("yesterday"),
  yesterdayRows: $("yesterday-rows"),
  yesterdayEmpty: $("yesterday-empty"),
};

const challenge = challengeForDay(todayKey());

// The player's attempts at today's riddle, authoritative copy once a backend
// is configured (reconciled from the server on load and after every submit),
// otherwise the local-only record.
let attempts = [];

// --- small helpers ---------------------------------------------------------

function showError(message) {
  el.error.textContent = message ?? "";
  el.error.hidden = !message;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

let resetsAt = Date.now() + msUntilNextDay();
function tickCountdown() {
  const remaining = resetsAt - Date.now();
  if (remaining <= 0) {
    el.countdown.textContent = "new riddle ready — refresh";
    return;
  }
  const total = Math.floor(remaining / 1000);
  el.countdown.textContent = `next in ${pad(Math.floor(total / 3600))}:${pad(
    Math.floor((total % 3600) / 60),
  )}:${pad(total % 60)}`;
}
setInterval(tickCountdown, 1000);

function hasCompletedToday() {
  return attempts.length >= MAX_ATTEMPTS;
}

// The single highest-scoring individual attempt's text - shown as the
// representative answer on the local-only fallback board, matching how the
// worker picks a representative answer for the shared leaderboard.
function bestAnswerOf(list) {
  return list.reduce((best, a) => (a.score > best.score ? a : best), list[0]).answer;
}

// --- rendering: challenge ----------------------------------------------

function renderChallenge() {
  el.daynum.textContent = `Daily #${challenge.dayNumber}`;
  el.prompt.textContent = challenge.prompt;
  el.answer.maxLength = MAX_ANSWER;
  tickCountdown();
}

// --- rendering: attempts -------------------------------------------------

function scoreClass(score) {
  if (score >= 70) return "good";
  if (score < 35) return "bad";
  return "";
}

// Two-line row: "Attempt N — score" then the player's own answer text below
// it, so they can see whether a reinterpretation actually improved things.
function attemptRow(attempt) {
  const li = document.createElement("li");
  li.className = "attempt-row";

  const head = document.createElement("div");
  head.className = "attempt-head";
  const label = document.createElement("span");
  label.className = "attempt-label";
  label.textContent = `Attempt ${attempt.attemptNumber}`;
  const score = document.createElement("span");
  score.className = `attempt-score ${scoreClass(attempt.score)}`;
  score.textContent = formatScore(attempt.score);
  head.append(label, score);

  const answer = document.createElement("blockquote");
  answer.className = "attempt-answer";
  answer.textContent = attempt.answer;

  li.append(head, answer);
  return li;
}

/** Render the attempts panel and the running/final daily average. */
function renderAttempts() {
  if (attempts.length === 0) {
    el.attempts.hidden = true;
    return;
  }

  el.preparing.hidden = true;
  el.attempts.hidden = false;

  const daily = averageScore(attempts);
  el.dailyScore.textContent = formatScore(daily);
  el.dailyScore.className = `score ${scoreClass(daily)}`;
  el.dailyScoreCaption.textContent = hasCompletedToday()
    ? "Daily score — average of all 3 attempts"
    : `Daily score so far — average of ${attempts.length} of ${MAX_ATTEMPTS}`;

  el.attemptList.replaceChildren();
  for (const attempt of attempts) el.attemptList.append(attemptRow(attempt));

  const done = hasCompletedToday();
  el.attemptsDone.hidden = !done;
  el.play.hidden = done;
  if (!done) el.attemptNumber.textContent = String(attempts.length + 1);
}

// --- rendering: today's leaderboard ----------------------------------------
//
// Answer text for today's board only ever arrives from the server once this
// player has completed all 3 attempts - see api.js/worker: the worker itself
// omits `answer` from every row until the requesting player's own attempt
// count reaches MAX_ATTEMPTS, so there is nothing to redact here client-side
// and no answer text to accidentally render even by mistake.

function todayRowNode(entry, rank) {
  const li = document.createElement("li");
  li.className = entry.you ? "row me" : "row";

  const rankEl = document.createElement("span");
  rankEl.className = "row-rank";
  rankEl.textContent = String(entry.rank ?? rank);

  const main = document.createElement("div");
  main.className = "row-main";
  const name = document.createElement("div");
  name.className = "row-name";
  name.textContent = entry.you ? `${entry.name} (you)` : entry.name;
  main.append(name);
  if (entry.answer) {
    const answer = document.createElement("div");
    answer.className = "row-answer";
    answer.textContent = entry.answer;
    main.append(answer);
  }

  const score = document.createElement("span");
  score.className = "row-score";
  score.textContent = formatScore(entry.score);

  li.append(rankEl, main, score);
  return li;
}

function renderBoard(board, note) {
  el.board.hidden = false;
  el.rows.replaceChildren();
  const rows = board?.top ?? [];
  const players = board?.players ?? rows.length;
  el.players.textContent = players === 1 ? "1 player" : `${players} players`;
  el.boardEmpty.hidden = rows.length > 0;
  el.boardLocked.hidden = hasCompletedToday() || !leaderboardEnabled();
  rows.forEach((entry, index) => el.rows.append(todayRowNode(entry, index + 1)));
  if (board?.you) {
    const gap = document.createElement("li");
    gap.className = "row-gap";
    gap.textContent = "···";
    el.rows.append(gap, todayRowNode(board.you, board.you.rank));
  }
  el.boardNote.textContent = note ?? "";
  el.boardNote.hidden = !note;
}

function renderLocalBoard() {
  const rows = localBoard(challenge.id).map((row, index) => ({ ...row, rank: index + 1 }));
  renderBoard(
    { players: rows.length, top: rows.slice(0, 10), you: null },
    "Showing only this device — the shared leaderboard is not switched on yet.",
  );
}

async function refreshBoard() {
  if (!leaderboardEnabled()) return renderLocalBoard();
  try {
    const board = await fetchLeaderboard(challenge.id);
    renderBoard(board);
  } catch {
    renderLocalBoard();
  }
}

// Live updates: everyone already on the page sees new scores without
// reloading. 7s sits inside the "5-10s polling is fine" range; paused while
// the tab is hidden, with an immediate refresh when it becomes visible again.
let pollTimer = null;
function startPolling() {
  if (!leaderboardEnabled() || pollTimer) return;
  pollTimer = setInterval(() => {
    if (!document.hidden) refreshBoard();
  }, 7000);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshBoard();
});

// --- rendering: yesterday's strongest interpretations -----------------------
//
// Reuses the same leaderboard endpoint against yesterday's challenge id - no
// new route. Past-day answers are never redacted (see worker), so this always
// shows real text once there is a previous day to show. Deliberately no
// names and no rank numbers here: this is "discovery", not a leaderboard.

async function renderYesterday() {
  if (!leaderboardEnabled()) {
    el.yesterday.hidden = true;
    return;
  }
  const yesterdayId = challengeForDay(previousDayKey(challenge.dayKey)).id;
  try {
    const board = await fetchLeaderboard(yesterdayId);
    const rows = board?.top ?? [];
    el.yesterday.hidden = false;
    el.yesterdayRows.replaceChildren();
    el.yesterdayEmpty.hidden = rows.length > 0;
    for (const entry of rows) {
      if (!entry.answer) continue; // defensive: never render a missing answer
      const li = document.createElement("li");
      li.className = "yesterday-row";
      const score = document.createElement("span");
      score.className = "yesterday-score";
      score.textContent = formatScore(entry.score);
      const answer = document.createElement("span");
      answer.className = "yesterday-answer";
      answer.textContent = entry.answer;
      li.append(score, answer);
      el.yesterdayRows.append(li);
    }
  } catch {
    el.yesterday.hidden = true;
  }
}

// --- judge loading ---------------------------------------------------------

function formatBytes(bytes) {
  if (!bytes) return null;
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
}

async function prepareJudge() {
  const info = await judgeInfo();

  if (info.unsupported) {
    // Known ahead of time, before anything is downloaded: this device has no
    // working WebGPU, and there is no in-browser fallback for this model -
    // see web/src/judge.js's module comment for why. Fail immediately with a
    // specific, honest message rather than attempting (and wasting a
    // download on) a load that is guaranteed to crash.
    throw new UnsupportedDeviceError(
      "This browser can't run today's judge. Try a recent version of Chrome, Edge, or Safari with WebGPU enabled.",
    );
  }

  const totalSize = formatBytes(info.downloadBytes);

  if (info.isCached) {
    el.preparingText.textContent = "Loading the judge…";
    el.preparingNote.textContent = "Already downloaded on this device — no redownload needed.";
  } else if (totalSize) {
    el.preparingText.textContent = "Downloading judge…";
    el.preparingNote.textContent = `One-time ${totalSize} download. It will be cached on this device afterwards.`;
  }

  await loadJudge({
    onPhase: ({ phase, progress, loaded, total }) => {
      if (phase === PHASE.DOWNLOADING) {
        const percent = Math.round(progress * 100);
        el.preparingBar.style.width = `${percent}%`;
        el.preparingBar.classList.remove("indeterminate");
        const byteNote =
          typeof loaded === "number" && typeof total === "number" && total > 0
            ? ` (${formatBytes(loaded) ?? "0 MB"} / ${formatBytes(total) ?? totalSize})`
            : "";
        el.preparingText.textContent = `Downloading judge… ${percent}%${byteNote}`;
      } else if (phase === PHASE.INITIALIZING) {
        el.preparingBar.style.width = "100%";
        el.preparingBar.classList.add("indeterminate");
        el.preparingText.textContent = "Initializing judge…";
        el.preparingNote.textContent = "Setting up the model on this device. Almost ready.";
      } else if (phase === PHASE.READY) {
        el.preparingBar.classList.remove("indeterminate");
        el.preparingText.textContent = "Judge ready.";
      }
    },
  });

  el.preparingBar.style.width = "100%";
  el.preparing.hidden = true;
  if (attempts.length < MAX_ATTEMPTS) {
    el.play.hidden = false;
    el.name.value = savedName();
    updateCounter();
  }
}

// --- interactions ----------------------------------------------------------

function updateCounter() {
  const used = [...el.answer.value].length;
  el.counter.textContent = `${used} / ${MAX_ANSWER}`;
  el.counter.classList.toggle("near", used > MAX_ANSWER - 15);
}
el.answer.addEventListener("input", updateCounter);
el.answer.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    el.play.requestSubmit();
  }
});

let busy = false;

el.play.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  showError(null);

  if (hasCompletedToday()) {
    return showError("All 3 attempts are used for today.");
  }

  let name;
  let answer;
  try {
    name = validateName(el.name.value);
    answer = validateAnswer(el.answer.value);
  } catch (err) {
    return showError(err.message);
  }

  // Two non-AI gates, neither of which ever scores anything - they only
  // decide whether the real judge is asked at all. See shared/gibberish.js.
  if (!looksLikeRealText(answer)) {
    return showError("Write an actual interpretation, not random characters.");
  }
  if (!looksLikeOwnInterpretation(answer, challenge.prompt)) {
    return showError("That just repeats the riddle back — give your own interpretation.");
  }

  busy = true;
  el.submit.disabled = true;
  el.submit.classList.add("busy");
  el.submit.querySelector(".submit-label").textContent = "Judging…";

  try {
    const verdict = await scoreAnswer({ answer, statement: challenge.noulStatement });

    const normalized = normalizeAnswer(answer);
    const hash = await answerHash({
      challengeId: challenge.id,
      scoringVersion: challenge.scoringVersion,
      normalizedAnswer: normalized,
    });

    const localAttempt = {
      answer,
      score: verdict.score,
      noul: verdict.noul,
      at: new Date().toISOString(),
    };

    rememberName(name);

    if (leaderboardEnabled()) {
      try {
        const response = await submit({
          challengeId: challenge.id,
          dayKey: challenge.dayKey,
          scoringVersion: challenge.scoringVersion,
          name,
          answer,
          normalizedAnswer: normalized,
          answerHash: hash,
          noul: verdict.noul,
          score: verdict.score,
          model: verdict.model,
        });
        // The server assigns the true attempt number and is the source of
        // truth for the full list - use its copy, not a locally-guessed one.
        if (Array.isArray(response?.attempts)) {
          attempts = response.attempts;
          setLocalAttempts(challenge.id, attempts);
        } else {
          attempts = addLocalAttempt(challenge.id, localAttempt);
        }
        renderAttempts();
        if (response?.leaderboard) renderBoard(response.leaderboard);
        else await refreshBoard();
      } catch (err) {
        if (err.status === 409 && err.body?.error === "max_attempts") {
          try {
            const server = await fetchAttempts(challenge.id);
            attempts = server.attempts ?? attempts;
            setLocalAttempts(challenge.id, attempts);
          } catch {
            // Keep what we had; the form stays disabled by the count below.
          }
          renderAttempts();
          showError("All 3 attempts are already used for today.");
        } else {
          // The score is real and shown locally; only the shared board failed.
          attempts = addLocalAttempt(challenge.id, localAttempt);
          renderAttempts();
          addToLocalBoard(challenge.id, {
            name,
            answer: bestAnswerOf(attempts),
            score: averageScore(attempts),
            at: localAttempt.at,
            you: true,
          });
          renderLocalBoard();
          el.boardNote.hidden = false;
          el.boardNote.textContent = `Your score is saved on this device. ${err.message}`;
        }
      }
    } else {
      attempts = addLocalAttempt(challenge.id, localAttempt);
      renderAttempts();
      addToLocalBoard(challenge.id, {
        name,
        answer: bestAnswerOf(attempts),
        score: averageScore(attempts),
        at: localAttempt.at,
        you: true,
      });
      renderLocalBoard();
    }
  } catch (err) {
    showError(err?.message || "Something went wrong scoring that. Try again.");
  } finally {
    busy = false;
    el.submit.disabled = false;
    el.submit.classList.remove("busy");
    el.submit.querySelector(".submit-label").textContent = `Submit attempt ${Math.min(
      attempts.length + 1,
      MAX_ATTEMPTS,
    )} of ${MAX_ATTEMPTS}`;
  }
});

// --- boot ------------------------------------------------------------------

renderChallenge();

await loadConfig();

// Reconcile attempts: prefer the server's copy (authoritative once a backend
// exists), fall back to the local cache if the network fails or no backend
// is configured at all.
if (leaderboardEnabled()) {
  try {
    const server = await fetchAttempts(challenge.id);
    attempts = Array.isArray(server?.attempts) ? server.attempts : [];
    setLocalAttempts(challenge.id, attempts);
  } catch {
    attempts = localAttempts(challenge.id);
  }
} else {
  attempts = localAttempts(challenge.id);
}

renderAttempts();
await refreshBoard();
await renderYesterday(); // a different, already-closed riddle - safe to show any time
startPolling();

if (hasCompletedToday()) {
  // Already done for today: no reason to download a 365MB model just to show
  // a screen that says so.
  el.preparing.hidden = true;
} else {
  try {
    await prepareJudge();
  } catch (err) {
    // Always logged in full (stack, name, cause) regardless of what the
    // player sees - this is what makes a production failure diagnosable
    // instead of just the generic headline below.
    console.error("[main] judge failed to load:", err);
    el.preparing.hidden = false;
    el.preparingText.textContent =
      err instanceof UnsupportedDeviceError
        ? "This device can't run today's judge."
        : "Today's judge could not load.";
    el.preparingNote.textContent =
      err?.message ?? "Check your connection and refresh to try again.";
    el.preparingBar.style.width = "0%";
  }
}
