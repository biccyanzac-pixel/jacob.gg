/**
 * Real browser end-to-end test, using Playwright driving the system's
 * installed Microsoft Edge (Chromium) — no browser download needed.
 *
 * Exercises the actual deployed (or local preview) page: loads it, waits for
 * the real model to load via WebGPU or WASM, submits three genuinely
 * different interpretations through the real UI, and inspects the real DOM
 * and real network requests. No mocking.
 *
 *   node scripts/browser-test.mjs <url>
 *
 * Note: with no shared backend deployed (config.json's leaderboardUrl is
 * null), this exercises the local-fallback leaderboard, not the cross-device
 * answer-visibility gating - that is covered separately and for real by
 * worker/test/e2e.mjs against a live Miniflare instance.
 */
import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.argv[2];
if (!URL) {
  console.error("usage: node scripts/browser-test.mjs <url>");
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

async function submitAndWait(page, name, answer) {
  await page.fill("#name", name);
  await page.fill("#answer", answer);
  await page.click("#submit");
  await page.waitForFunction(
    () => document.getElementById("attempts")?.hidden === false,
    { timeout: 5 * 60 * 1000 },
  );
  await page.waitForTimeout(500);
}

try {
  console.log(`\n=== session 1 (player A) ===`);
  console.log(`opening ${URL}`);
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();

  const requests = [];
  pageA.on("request", (req) => requests.push(req.url()));
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

  for (let i = 0; i < 3; i += 1) {
    await submitAndWait(pageA, "Ada", ANSWERS[i]);
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

  // --- no Jev API, no secrets, no crashes ------------------------------------
  const jevCalls = requests.filter((u) => /thejevai\.com/i.test(u));
  check("no request ever made to the hosted Jev API", jevCalls.length === 0, `${jevCalls.length} calls`);
  const secretPattern = /sk_[A-Za-z0-9]{10,}|JEV_API_KEY|gho_[A-Za-z0-9]{10,}/i;
  check("no secret in any outgoing request URL", !requests.some((u) => secretPattern.test(u)));
  check("no uncaught page errors", consoleErrors.length === 0, consoleErrors.join(" | "));

  // --- the UI never names the model/AI mechanics -----------------------------
  const bodyText = await pageA.evaluate(() => document.body.innerText);
  check(
    "the visible page never mentions the model/AI implementation",
    !/kev-0\.6b|open-jev|transformers\.js|noul probability/i.test(bodyText),
  );

  // --- refresh persistence --------------------------------------------------
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

  // --- yesterday's gallery: present or absent without crashing --------------
  const yesterdayHidden = await pageA.locator("#yesterday").isHidden();
  console.log(`  INFO  yesterday's-interpretations panel hidden: ${yesterdayHidden} (expected with no shared backend deployed)`);

  await ctxA.close();

  // --- second player, fresh browser context = fresh localStorage ----------
  console.log(`\n=== session 2 (player B, clean browser profile) ===`);
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForJudgeReady(pageB);
  check("a second, independent browser session can load and play", true);

  await submitAndWait(pageB, "Bea", "a password");
  const bScore = Number((await pageB.locator(".attempt-score").allTextContents())[0]);
  check("second player gets a real per-attempt score", Number.isFinite(bScore) && bScore >= 0 && bScore <= 100);

  await ctxB.close();
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? "ALL BROWSER CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
