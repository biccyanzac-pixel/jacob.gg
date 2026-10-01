/**
 * Real browser end-to-end test, using Playwright driving the system's
 * installed Microsoft Edge (Chromium) — no browser download needed.
 *
 * Exercises the actual deployed (or local preview) page: loads it, waits for
 * the real model to load via WebGPU or WASM, submits three genuinely
 * different interpretations through the real UI, and inspects the real DOM
 * and real network requests. No mocking.
 *
 *   node scripts/browser-test.mjs <frontend-url> [worker-url]
 *
 * When `worker-url` is given, this also verifies the frontend is genuinely
 * talking to that live Worker rather than silently falling back to
 * per-device localStorage: it checks for real outgoing requests to it, that
 * the local-fallback notice never appears, and - the strongest check - that
 * a second, completely fresh browser context (no shared localStorage) can
 * see the first player on its OWN leaderboard read, which is only possible
 * if the board came from the shared backend over the network.
 */
import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.argv[2];
const WORKER_URL = process.argv[3] || null;
if (!URL) {
  console.error("usage: node scripts/browser-test.mjs <frontend-url> [worker-url]");
  process.exit(1);
}

const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures += 1;
}

const browser = await chromium.launch({
  executablePath: EDGE_PATHS.find((p) => fs.existsSync(p)),
  headless: true,
});

async function waitForJudgeReady(page) {
  console.log("waiting for the real model to load (may download weights on first run)...");
  await page.locator("#play").waitFor({ state: "visible", timeout: 10 * 60 * 1000 });
}

// `expectedRows` must be the row count AFTER this submission - waiting on
// "the attempts panel is visible" alone is a no-op after the first attempt,
// since it stays visible from then on and the wait resolves instantly without
// the actual (async, model-inference-backed) submission having finished.
async function submitAndWait(page, name, answer, expectedRows) {
  await page.fill("#name", name);
  await page.fill("#answer", answer);
  await page.click("#submit");
  await page.waitForFunction(
    (n) => document.querySelectorAll(".attempt-row").length === n,
    expectedRows,
    { timeout: 5 * 60 * 1000 },
  );
  await page.waitForTimeout(500);
}

const uniqueName = (base) => `${base}${Date.now() % 100000}`;

try {
  console.log(`\n=== session 1 (player A) ===`);
  console.log(`opening ${URL}`);
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();

  const requestsA = [];
  pageA.on("request", (req) => requestsA.push(req.url()));
  const consoleErrors = [];
  pageA.on("pageerror", (err) => consoleErrors.push(String(err)));

  const response = await pageA.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  check("page loads", response && response.ok(), `HTTP ${response?.status()}`);

  const prompt = await pageA.locator("#prompt").textContent({ timeout: 10000 });
  check(
    "a riddle is shown (not the old fun-happy-thought prompt)",
    /\?\s*$/.test((prompt ?? "").trim()) && !/fun and happy thought/i.test(prompt ?? ""),
    `"${prompt}"`,
  );

  const note = await pageA.locator("#attempts-note").textContent();
  check("UI explains the average-of-3 mechanic", /average/i.test(note ?? ""), `"${note}"`);

  const riddleNote = await pageA.locator(".riddle-note").textContent();
  check(
    "UI states plainly there is no official answer",
    /no official answer|no correct answer/i.test(riddleNote ?? ""),
    `"${riddleNote}"`,
  );

  if (WORKER_URL) {
    const configReq = await pageA.waitForResponse((r) => r.url().includes("config.json"), {
      timeout: 10000,
    }).catch(() => null);
    const config = configReq ? await configReq.json().catch(() => null) : null;
    check(
      "the live page's config.json points at the deployed Worker (not null)",
      config?.leaderboardUrl === WORKER_URL,
      `got ${JSON.stringify(config)}`,
    );
  }

  await waitForJudgeReady(pageA);
  check("judge finished loading, play form visible", true);
  try {
    await pageA.locator("#preparing").waitFor({ state: "hidden", timeout: 5000 });
    check("loading indicator hidden once ready", true);
  } catch {
    check("loading indicator hidden once ready", false);
  }

  // --- three genuinely different interpretations --------------------------
  const ANSWERS = ["a room", "a competition", "a conversation"];
  const individualScores = [];
  const nameA = uniqueName("Ada");

  for (let i = 0; i < 3; i += 1) {
    await submitAndWait(pageA, nameA, ANSWERS[i], i + 1);
    const rows = await pageA.locator(".attempt-row").count();
    check(`attempt ${i + 1}: attempt list shows exactly ${i + 1} row(s)`, rows === i + 1, `rows=${rows}`);

    const scoreTexts = await pageA.locator(".attempt-score").allTextContents();
    check(
      `attempt ${i + 1}: every individual score has exactly two decimal places`,
      scoreTexts.every((t) => /^\d{1,3}\.\d{2}$/.test(t)),
      JSON.stringify(scoreTexts),
    );
    individualScores.push(Number(scoreTexts[i]));

    const answerTexts = await pageA.locator(".attempt-answer").allTextContents();
    check(
      `attempt ${i + 1}: the player's own answer text is shown next to its score`,
      answerTexts[i] === ANSWERS[i],
      `"${answerTexts[i]}" vs "${ANSWERS[i]}"`,
    );

    if (WORKER_URL) {
      check(
        `attempt ${i + 1}: a real request was sent to the deployed Worker`,
        requestsA.some((u) => u.startsWith(WORKER_URL)),
      );
    }
  }

  const dailyScoreText = await pageA.locator("#daily-score").textContent();
  const dailyScore = Number(dailyScoreText);
  const expectedAverage =
    Math.round((individualScores.reduce((a, b) => a + b, 0) / 3) * 100) / 100;
  check(
    "the daily score is the AVERAGE of the three individual scores",
    Math.abs(dailyScore - expectedAverage) < 0.02,
    `shown=${dailyScore} expected~${expectedAverage} individuals=${JSON.stringify(individualScores)}`,
  );
  check(
    "the daily score is NOT simply the highest of the three (regression check)",
    Math.abs(dailyScore - Math.max(...individualScores)) > 0.01 ||
      individualScores.every((s) => s === individualScores[0]),
    `daily=${dailyScore} max=${Math.max(...individualScores)}`,
  );

  // --- 4th attempt must be impossible -------------------------------------
  check("play form is hidden after 3 attempts (no 4th submission possible)", await pageA.locator("#play").isHidden());
  check("a clear 'all attempts used' message is shown", !(await pageA.locator("#attempts-done").isHidden()));

  // --- genuinely using the shared backend, not silently falling back -------
  if (WORKER_URL) {
    const localFallbackNoteVisible = !(await pageA.locator("#board-note").isHidden());
    const localFallbackText = localFallbackNoteVisible
      ? await pageA.locator("#board-note").textContent()
      : "";
    check(
      "the local-fallback notice never appeared (frontend used the real Worker throughout)",
      !/this device|not switched on/i.test(localFallbackText ?? ""),
      `note visible=${localFallbackNoteVisible} text="${localFallbackText}"`,
    );
  }

  // --- no Jev API, no secrets, no crashes ------------------------------------
  const jevCalls = requestsA.filter((u) => /thejevai\.com/i.test(u));
  check("no request ever made to the hosted Jev API", jevCalls.length === 0, `${jevCalls.length} calls`);
  const secretPattern = /sk_[A-Za-z0-9]{10,}|JEV_API_KEY|gho_[A-Za-z0-9]{10,}/i;
  check("no secret in any outgoing request URL", !requestsA.some((u) => secretPattern.test(u)));
  check("no uncaught page errors", consoleErrors.length === 0, consoleErrors.join(" | "));

  // --- the UI never names the model/AI mechanics -----------------------------
  const bodyText = await pageA.evaluate(() => document.body.innerText);
  check(
    "the visible page never mentions the model/AI implementation",
    !/kev-0\.6b|open-jev|transformers\.js|noul probability/i.test(bodyText),
  );

  // --- refresh persistence, and refresh does not silently drop the backend --
  await pageA.reload({ waitUntil: "domcontentloaded" });
  await pageA.waitForFunction(() => document.getElementById("attempts")?.hidden === false, {
    timeout: 15000,
  });
  const dailyAfterRefresh = Number(await pageA.locator("#daily-score").textContent());
  check(
    "daily score persists across a refresh",
    Math.abs(dailyAfterRefresh - dailyScore) < 0.01,
    `before=${dailyScore} after=${dailyAfterRefresh}`,
  );
  check("all 3 attempts still shown after refresh", (await pageA.locator(".attempt-row").count()) === 3);
  check("play form still hidden after refresh (3/3 used)", await pageA.locator("#play").isHidden());
  if (WORKER_URL) {
    const stillNoFallbackNote = await pageA.locator("#board-note").isHidden();
    check("after refresh, still no local-fallback notice (still using the Worker)", stillNoFallbackNote);
  }

  // --- yesterday's gallery: present or absent without crashing --------------
  const yesterdayHidden = await pageA.locator("#yesterday").isHidden();
  console.log(`  INFO  yesterday's-interpretations panel hidden: ${yesterdayHidden}`);

  await ctxA.close();

  // --- second player, fresh browser context = fresh localStorage ----------
  console.log(`\n=== session 2 (player B, clean browser profile) ===`);
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForJudgeReady(pageB);
  check("a second, independent browser session can load and play", true);

  if (WORKER_URL) {
    // Strongest shared-backend proof: B's fresh, empty localStorage still
    // shows A on the leaderboard - that data can only have come from the
    // network, never from this browser's own storage.
    await pageB.waitForFunction(() => document.getElementById("board")?.hidden === false, {
      timeout: 15000,
    }).catch(() => {});
    const boardRowNames = await pageB.locator(".row-name").allTextContents();
    check(
      "a brand-new browser session (empty localStorage) sees player A on ITS OWN leaderboard read - proof of a real shared backend",
      boardRowNames.some((t) => t.includes(nameA)),
      JSON.stringify(boardRowNames),
    );
    const boardRowAnswers = await pageB.locator(".row-answer").allTextContents();
    check(
      "player B, having made zero attempts yet, does NOT see A's answer text",
      boardRowAnswers.length === 0,
      JSON.stringify(boardRowAnswers),
    );
  }

  const nameB = uniqueName("Bea");
  await submitAndWait(pageB, nameB, "a password", 1);
  const bScore = Number((await pageB.locator(".attempt-score").allTextContents())[0]);
  check("second player gets a real per-attempt score", Number.isFinite(bScore) && bScore >= 0 && bScore <= 100);

  if (WORKER_URL) {
    await submitAndWait(pageB, nameB, "a dream", 2);
    await submitAndWait(pageB, nameB, "a trance", 3);
    const boardRowAnswersAfter = await pageB.locator(".row-answer").allTextContents();
    check(
      "after B's own 3rd attempt, A's real answer text is now visible to B",
      boardRowAnswersAfter.some((t) => t.length > 0),
      JSON.stringify(boardRowAnswersAfter),
    );
  }

  await ctxB.close();
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? "ALL BROWSER CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
