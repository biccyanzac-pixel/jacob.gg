import "./style.css";
import {
  MAX_ANSWER,
  challengeForDay,
  msUntilNextDay,
  todayKey,
  validateAnswer,
  validateName,
} from "@shared/challenges.js";
import { answerHash, normalizeAnswer } from "@shared/normalize.js";
import { looksLikeRealText } from "@shared/gibberish.js";
import { judgeInfo, loadJudge, scoreAnswer } from "./judge.js";
import { fetchLeaderboard, leaderboardEnabled, loadConfig, submit } from "./api.js";
import {
  addToLocalBoard,
  localBoard,
  rememberName,
  saveResult,
  savedName,
  savedResult,
} from "./store.js";

const $ = (id) => document.getElementById(id);
const el = {
  daynum: $("daynum"),
  countdown: $("countdown"),
  prompt: $("prompt"),
  hint: $("hint"),
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
  result: $("result"),
  score: $("score"),
  yourAnswer: $("your-answer"),
  board: $("board"),
  rows: $("rows"),
  players: $("players"),
  boardEmpty: $("board-empty"),
  boardNote: $("board-note"),
};

const challenge = challengeForDay(todayKey());

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
    el.countdown.textContent = "new challenge ready — refresh";
    return;
  }
  const total = Math.floor(remaining / 1000);
  el.countdown.textContent = `next in ${pad(Math.floor(total / 3600))}:${pad(
    Math.floor((total % 3600) / 60),
  )}:${pad(total % 60)}`;
}
setInterval(tickCountdown, 1000);

// --- rendering -------------------------------------------------------------

function renderChallenge() {
  el.daynum.textContent = `Daily #${challenge.dayNumber}`;
  el.prompt.textContent = challenge.prompt;
  el.hint.textContent = challenge.hint ?? "";
  el.answer.maxLength = MAX_ANSWER;
  tickCountdown();
}

function revealScore(score) {
  el.score.classList.toggle("good", score >= 70);
  el.score.classList.toggle("bad", score < 35);

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || score === 0) {
    el.score.textContent = String(score);
    return;
  }
  const duration = 800;
  const started = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - started) / duration);
    el.score.textContent = String(Math.round(score * (1 - (1 - t) ** 3)));
    if (t < 1) requestAnimationFrame(step);
    else el.score.textContent = String(score);
  };
  requestAnimationFrame(step);
}

function showResult(result, { animate = true } = {}) {
  el.preparing.hidden = true;
  el.play.hidden = true;
  el.result.hidden = false;
  el.yourAnswer.textContent = result.answer;
  if (animate) revealScore(result.score);
  else el.score.textContent = String(result.score);
}

function rowNode(entry, rank) {
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
  const answer = document.createElement("div");
  answer.className = "row-answer";
  answer.textContent = entry.answer ?? "";
  main.append(name, answer);

  const score = document.createElement("span");
  score.className = "row-score";
  score.textContent = String(entry.score);

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
  rows.forEach((entry, index) => el.rows.append(rowNode(entry, index + 1)));
  if (board?.you) {
    const gap = document.createElement("li");
    gap.className = "row-gap";
    gap.textContent = "···";
    el.rows.append(gap, rowNode(board.you, board.you.rank));
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

// --- judge loading ---------------------------------------------------------

function formatBytes(bytes) {
  if (!bytes) return null;
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
}

async function prepareJudge() {
  const info = await judgeInfo();
  const size = formatBytes(info.downloadBytes);

  if (info.isCached) {
    el.preparingText.textContent = "Waking up today's judge…";
    el.preparingNote.textContent = "Already downloaded on this device.";
  } else if (size) {
    el.preparingNote.textContent = `One-time ${size} download, then it is cached for next time.`;
  }

  let lastShown = -1;
  await loadJudge({
    onProgress: (progress) => {
      const percent = Math.round(progress * 100);
      if (percent === lastShown) return;
      lastShown = percent;
      el.preparingBar.style.width = `${percent}%`;
      el.preparingText.textContent = `Preparing today's judge… ${percent}%`;
    },
  });

  el.preparingBar.style.width = "100%";
  el.preparing.hidden = true;
  el.play.hidden = false;
  el.name.value = savedName();
  updateCounter();
}

// --- interactions ----------------------------------------------------------

function updateCounter() {
  const used = [...el.answer.value].length;
  el.counter.textContent = `${used} / ${MAX_ANSWER}`;
  el.counter.classList.toggle("near", used > MAX_ANSWER - 40);
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

  let name;
  let answer;
  try {
    name = validateName(el.name.value);
    answer = validateAnswer(el.answer.value);
  } catch (err) {
    return showError(err.message);
  }

  // A non-AI gate against pure keymash ("asdfghjkl"). It never scores
  // anything - it only decides whether the real judge is asked at all.
  // See shared/gibberish.js for why this exists.
  if (!looksLikeRealText(answer)) {
    return showError("Write an actual thought, not random characters.");
  }

  busy = true;
  el.submit.disabled = true;
  el.submit.classList.add("busy");
  el.submit.querySelector(".submit-label").textContent = "Scoring…";

  try {
    const verdict = await scoreAnswer({ answer, statement: challenge.noulStatement });

    const normalized = normalizeAnswer(answer);
    const hash = await answerHash({
      challengeId: challenge.id,
      scoringVersion: challenge.scoringVersion,
      normalizedAnswer: normalized,
    });

    const result = {
      answer,
      score: verdict.score,
      noul: verdict.noul,
      at: new Date().toISOString(),
    };

    rememberName(name);
    saveResult(challenge.id, result);
    showResult(result);

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
        if (response?.leaderboard) renderBoard(response.leaderboard);
        else await refreshBoard();
      } catch (err) {
        // The score is real and shown; only the shared board failed.
        addToLocalBoard(challenge.id, { name, answer, score: result.score, at: result.at, you: true });
        renderLocalBoard();
        el.boardNote.hidden = false;
        el.boardNote.textContent = `Your score is saved on this device. ${err.message}`;
      }
    } else {
      addToLocalBoard(challenge.id, { name, answer, score: result.score, at: result.at, you: true });
      renderLocalBoard();
    }
  } catch (err) {
    showError(err?.message || "Something went wrong scoring that. Try again.");
  } finally {
    busy = false;
    el.submit.disabled = false;
    el.submit.classList.remove("busy");
    el.submit.querySelector(".submit-label").textContent = "Submit";
  }
});

// --- boot ------------------------------------------------------------------

renderChallenge();

await loadConfig();

const already = savedResult(challenge.id);
if (already) {
  showResult(already, { animate: false });
  await refreshBoard();
} else {
  await refreshBoard();
  try {
    await prepareJudge();
  } catch (err) {
    el.preparing.hidden = false;
    el.preparingText.textContent = "Today's judge could not load.";
    el.preparingNote.textContent =
      err?.message ?? "Check your connection and refresh to try again.";
    el.preparingBar.style.width = "0%";
  }
}
