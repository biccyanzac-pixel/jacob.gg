const $ = (id) => document.getElementById(id);

const el = {
  card: $("card"),
  daynum: $("daynum"),
  countdown: $("countdown"),
  prompt: $("prompt"),
  hint: $("hint"),
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
};

const NAME_KEY = "jgg.name";
let maxAnswer = 280;

// --- api -------------------------------------------------------------------

async function api(path, options) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON body means an unexpected failure; fall through.
  }

  // 409 (already played) carries the player's existing result, so it is not
  // an error from the UI's point of view.
  if (!response.ok && response.status !== 409) {
    const error = new Error(body?.message || "Something went wrong. Try again.");
    error.status = response.status;
    throw error;
  }
  return body;
}

function showError(message) {
  el.error.textContent = message ?? "";
  el.error.hidden = !message;
}

// --- countdown -------------------------------------------------------------

let resetsAt = null;

function tickCountdown() {
  if (resetsAt == null) return;
  const remaining = resetsAt - Date.now();
  if (remaining <= 0) {
    el.countdown.textContent = "new challenge ready — refresh";
    resetsAt = null;
    return;
  }
  const total = Math.floor(remaining / 1000);
  const pad = (n) => String(n).padStart(2, "0");
  el.countdown.textContent = `next in ${pad(Math.floor(total / 3600))}:${pad(
    Math.floor((total % 3600) / 60),
  )}:${pad(total % 60)}`;
}

setInterval(tickCountdown, 1000);

// --- rendering -------------------------------------------------------------

function renderChallenge(state) {
  el.card.setAttribute("aria-busy", "false");
  el.daynum.textContent = `Daily #${state.number}`;
  el.prompt.textContent = state.prompt;
  el.hint.textContent = state.hint ?? "";
  el.hint.hidden = !state.hint;

  if (Number.isInteger(state.maxAnswer)) {
    maxAnswer = state.maxAnswer;
    el.answer.maxLength = maxAnswer;
  }
  if (Number.isInteger(state.maxName)) el.name.maxLength = state.maxName;

  resetsAt = Date.now() + state.resetsInMs;
  tickCountdown();

  if (state.result) {
    renderResult(state.result);
  } else {
    el.play.hidden = false;
    el.result.hidden = true;
    el.name.value = localStorage.getItem(NAME_KEY) ?? "";
    updateCounter();
  }

  renderBoard(state.leaderboard);
}

// Counts the score up on reveal. Purely presentational - the number the
// server sent is what lands, and it is set immediately if motion is reduced.
function revealScore(score) {
  el.score.classList.toggle("good", score >= 70);
  el.score.classList.toggle("bad", score < 35);

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || score === 0) {
    el.score.textContent = String(score);
    return;
  }

  const durationMs = 750;
  const started = performance.now();
  const step = (nowMs) => {
    const progress = Math.min(1, (nowMs - started) / durationMs);
    // Ease out, so it decelerates into the final number.
    const eased = 1 - (1 - progress) ** 3;
    el.score.textContent = String(Math.round(score * eased));
    if (progress < 1) requestAnimationFrame(step);
    else el.score.textContent = String(score);
  };
  requestAnimationFrame(step);
}

function renderResult(result) {
  el.play.hidden = true;
  el.result.hidden = false;
  el.yourAnswer.textContent = result.answer;
  revealScore(result.score);
}

function rowNode(entry) {
  const li = document.createElement("li");
  li.className = entry.you ? "row me" : "row";

  const rank = document.createElement("span");
  rank.className = "row-rank";
  rank.textContent = String(entry.rank);

  const main = document.createElement("div");
  main.className = "row-main";

  const name = document.createElement("div");
  name.className = "row-name";
  name.textContent = entry.you ? `${entry.name} (you)` : entry.name;

  const answer = document.createElement("div");
  answer.className = "row-answer";
  answer.textContent = entry.answer;

  main.append(name, answer);

  const score = document.createElement("span");
  score.className = "row-score";
  score.textContent = String(entry.score);

  li.append(rank, main, score);
  return li;
}

function renderBoard(board) {
  if (!board) return;
  el.board.hidden = false;
  el.rows.replaceChildren();

  el.players.textContent = board.players === 1 ? "1 player" : `${board.players} players`;
  el.boardEmpty.hidden = board.players > 0;

  for (const entry of board.top) el.rows.append(rowNode(entry));

  if (board.you) {
    const gap = document.createElement("li");
    gap.className = "row-gap";
    gap.textContent = "···";
    el.rows.append(gap, rowNode(board.you));
  }
}

// --- interactions ----------------------------------------------------------

function updateCounter() {
  // Count code points, matching the server's limit, so an emoji costs one.
  const used = [...el.answer.value].length;
  el.counter.textContent = `${used} / ${maxAnswer}`;
  el.counter.classList.toggle("near", used > maxAnswer - 40);
}

el.answer.addEventListener("input", updateCounter);

// Enter submits; Shift+Enter adds a newline.
el.answer.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    el.play.requestSubmit();
  }
});

el.play.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(null);

  const name = el.name.value.trim();
  const answer = el.answer.value.trim();
  if (!name) return showError("Pick a name first.");
  if (!answer) return showError("Write an answer first.");

  el.submit.disabled = true;
  el.submit.classList.add("busy");
  el.submit.querySelector(".submit-label").textContent = "Scoring…";

  try {
    const data = await api("/api/play", {
      method: "POST",
      body: JSON.stringify({ name, answer }),
    });
    localStorage.setItem(NAME_KEY, name);
    if (data?.result) renderResult(data.result);
    renderBoard(data?.leaderboard);
  } catch (err) {
    showError(err.message);
  } finally {
    el.submit.disabled = false;
    el.submit.classList.remove("busy");
    el.submit.querySelector(".submit-label").textContent = "Submit";
  }
});

// --- boot ------------------------------------------------------------------

try {
  renderChallenge(await api("/api/today"));
} catch (err) {
  el.card.setAttribute("aria-busy", "false");
  el.prompt.textContent = "Today's challenge could not load.";
  el.hint.textContent = err.message;
}
