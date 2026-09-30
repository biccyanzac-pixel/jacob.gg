/**
 * Real browser end-to-end test, using Playwright driving the system's
 * installed Microsoft Edge (Chromium) — no browser download needed.
 *
 * Exercises the actual deployed (or local preview) page: loads it, waits for
 * the real model to load via WebGPU or WASM, submits real answers through the
 * real UI across all 3 attempts, and inspects the real DOM and real network
 * requests. No mocking.
 *
 *   node scripts/browser-test.mjs <url>
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
  await page.waitForTimeout(800);
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
  check("challenge prompt shown", /fun and happy thought/i.test(prompt ?? ""), `"${prompt}"`);

  const attemptsNote = await pageA.locator("#attempts-note").textContent();
  check("UI explicitly states 3 attempts", /3 attempts/i.test(attemptsNote ?? ""), `"${attemptsNote}"`);

  // --- loading phases: must see a real progress state, not a bare spinner --
  const loadingTexts = new Set();
  const watchPhases = (async () => {
    const until = Date.now() + 9 * 60 * 1000;
    while (Date.now() < until) {
      const hidden = await pageA.locator("#preparing").isHidden().catch(() => true);
      if (hidden) break;
      const text = await pageA.locator("#preparing-text").textContent().catch(() => "");
      if (text) loadingTexts.add(text);
      await pageA.waitForTimeout(300);
    }
  })();

  await waitForJudgeReady(pageA);
  await watchPhases;

  check("judge finished loading, play form visible", true);
  const sawDownloading = [...loadingTexts].some((t) => /download/i.test(t));
  const sawInitializing = [...loadingTexts].some((t) => /initializ/i.test(t));
  console.log(`  loading phase texts observed: ${JSON.stringify([...loadingTexts])}`);
  check(
    "loading UI showed a distinct downloading or initializing phase (not just a bare spinner)",
    sawDownloading || sawInitializing,
  );

  try {
    await pageA.locator("#preparing").waitFor({ state: "hidden", timeout: 5000 });
    check("loading indicator hidden once ready", true);
  } catch {
    check("loading indicator hidden once ready", false);
  }

  // --- attempt 1 --------------------------------------------------------
  await submitAndWait(pageA, "Ada", "I ate ice cream in the sunshine and laughed with my friend.");
  const best1 = await pageA.locator("#best-score").textContent();
  check(
    "attempt 1: score has exactly two decimal places",
    /^\d{1,3}\.\d{2}$/.test(best1 ?? ""),
    `"${best1}"`,
  );
  const score1 = Number(best1);
  check("attempt 1: score is in range", score1 >= 0 && score1 <= 100, `${score1}`);

  let rows = await pageA.locator(".attempt-row").count();
  check("attempt list shows exactly 1 row after attempt 1", rows === 1, `rows=${rows}`);

  const submitLabel2 = await pageA.locator("#submit .submit-label").textContent();
  check("submit button now offers attempt 2 of 3", /2 of 3/.test(submitLabel2 ?? ""), `"${submitLabel2}"`);

  // --- attempt 2 (deliberately worse answer) -----------------------------
  await submitAndWait(pageA, "Ada", "The train timetable was updated on Tuesday.");
  rows = await pageA.locator(".attempt-row").count();
  check("attempt list shows exactly 2 rows after attempt 2", rows === 2, `rows=${rows}`);

  // --- attempt 3 (deliberately best answer) ------------------------------
  await submitAndWait(
    pageA,
    "Ada",
    "Watching my dog sprint through long grass with her ears flapping, pure joy.",
  );
  rows = await pageA.locator(".attempt-row").count();
  check("attempt list shows exactly 3 rows after attempt 3", rows === 3, `rows=${rows}`);

  const bestFinal = Number(await pageA.locator("#best-score").textContent());
  const rowScores = await pageA.locator(".attempt-score").allTextContents();
  const numericRowScores = rowScores.map(Number);
  console.log(`  all 3 attempt scores: ${JSON.stringify(numericRowScores)}, best shown: ${bestFinal}`);
  check(
    "BEST SCORE equals the maximum of the 3 individual attempts, not the latest",
    Math.abs(bestFinal - Math.max(...numericRowScores)) < 0.01,
    `best=${bestFinal} max(attempts)=${Math.max(...numericRowScores)}`,
  );

  // --- 4th attempt must be impossible -------------------------------------
  const playHiddenNow = await pageA.locator("#play").isHidden();
  check("play form is hidden/disabled after 3 attempts (no 4th submission possible)", playHiddenNow);
  const doneMsgHidden = await pageA.locator("#attempts-done").isHidden();
  check("a clear 'all attempts used' message is shown", !doneMsgHidden);

  // --- no Jev API, no secrets ----------------------------------------------
  const jevCalls = requests.filter((u) => /thejevai\.com/i.test(u));
  check("no request ever made to the hosted Jev API", jevCalls.length === 0, `${jevCalls.length} calls`);
  const secretPattern = /sk_[A-Za-z0-9]{10,}|JEV_API_KEY|gho_[A-Za-z0-9]{10,}/i;
  const leaked = requests.filter((u) => secretPattern.test(u));
  check("no secret in any outgoing request URL", leaked.length === 0, `${leaked.length} matches`);
  check("no uncaught page errors", consoleErrors.length === 0, consoleErrors.join(" | "));

  const usingSharedBackend = requests.some(
    (u) => !u.includes("biccyanzac-pixel.github.io") && /\/api\//.test(u),
  );
  console.log(`  INFO  shared backend in use: ${usingSharedBackend}`);

  // --- refresh persistence --------------------------------------------------
  await pageA.reload({ waitUntil: "domcontentloaded" });
  await pageA.waitForFunction(() => document.getElementById("attempts")?.hidden === false, {
    timeout: 15000,
  });
  const bestAfterRefresh = Number(await pageA.locator("#best-score").textContent());
  check(
    "best score persists across a refresh",
    Math.abs(bestAfterRefresh - bestFinal) < 0.01,
    `before=${bestFinal} after=${bestAfterRefresh}`,
  );
  const rowsAfterRefresh = await pageA.locator(".attempt-row").count();
  check("all 3 attempts still shown after refresh", rowsAfterRefresh === 3, `rows=${rowsAfterRefresh}`);
  const playHiddenAfterRefresh = await pageA.locator("#play").isHidden();
  check("play form still hidden after refresh (3/3 used)", playHiddenAfterRefresh);

  await ctxA.close();

  // --- second player, fresh browser context = fresh localStorage ----------
  console.log(`\n=== session 2 (player B, clean browser profile) ===`);
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForJudgeReady(pageB);
  check("a second, independent browser session can load and play", true);

  await submitAndWait(pageB, "Bea", "My dog farted and everyone started laughing.");
  const scoreB = Number(await pageB.locator("#best-score").textContent());
  check(
    "second player gets their own real score",
    Number.isFinite(scoreB) && scoreB >= 0 && scoreB <= 100,
    `score=${scoreB}`,
  );
  check(
    "two different players' answers get different scores (not a fixed/fake number)",
    Math.abs(scoreB - bestFinal) > 0.001,
    `A=${bestFinal} B=${scoreB}`,
  );

  await ctxB.close();
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? "ALL BROWSER CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
