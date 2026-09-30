/**
 * Real browser end-to-end test, using Playwright driving the system's
 * installed Microsoft Edge (Chromium) — no browser download needed.
 *
 * Exercises the actual deployed (or local preview) page: loads it, waits for
 * the real model to load via WebGPU or WASM, submits real answers through the
 * real UI, and inspects the real DOM and real network requests. No mocking.
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

  // Wait for the judge to finish loading: the play form becomes visible.
  console.log("waiting for the real model to load (this downloads weights on first run)...");
  await pageA.locator("#play").waitFor({ state: "visible", timeout: 10 * 60 * 1000 });
  check("judge finished loading, play form visible", true);

  const preparingHidden = await pageA.locator("#preparing").isHidden();
  check("loading indicator hidden once ready", preparingHidden);

  // Submit a clearly happy answer.
  await pageA.fill("#name", "Ada");
  await pageA.fill("#answer", "I ate ice cream in the sunshine and laughed with my friend.");
  await pageA.click("#submit");

  await pageA.locator("#result").waitFor({ state: "visible", timeout: 60000 });
  const scoreTextA = await pageA.locator("#score").textContent();
  const scoreA = Number(scoreTextA);
  check(
    "received a sensible non-error score",
    Number.isInteger(scoreA) && scoreA >= 0 && scoreA <= 100,
    `score=${scoreTextA}`,
  );
  check("happy answer scored reasonably high", scoreA >= 50, `score=${scoreA}`);

  const yourAnswerText = await pageA.locator("#your-answer").textContent();
  check(
    "player's own answer is shown back to them",
    (yourAnswerText ?? "").includes("ice cream"),
    `"${yourAnswerText}"`,
  );

  // No Jev API call.
  const jevCalls = requests.filter((u) => /thejevai\.com/i.test(u));
  check("no request ever made to the hosted Jev API", jevCalls.length === 0, `${jevCalls.length} calls`);

  // No secret anywhere in what left the browser.
  const secretPattern = /sk_[A-Za-z0-9]{10,}|JEV_API_KEY|gho_[A-Za-z0-9]{10,}/i;
  const leaked = requests.filter((u) => secretPattern.test(u));
  check("no secret in any outgoing request URL", leaked.length === 0, `${leaked.length} matches`);

  check("no uncaught page errors", consoleErrors.length === 0, consoleErrors.join(" | "));

  // WebGPU / WASM status - read from the page's own runtime info if exposed,
  // else infer from navigator.
  const webgpu = await pageA.evaluate(() => Boolean(navigator.gpu));
  console.log(`INFO  navigator.gpu present in this headless browser: ${webgpu}`);

  // Refresh: the result must persist (same browser, same localStorage).
  await pageA.reload({ waitUntil: "domcontentloaded" });
  await pageA.locator("#result").waitFor({ state: "visible", timeout: 15000 });
  const scoreAfterRefresh = await pageA.locator("#score").textContent();
  check(
    "result persists across a refresh (one attempt already used)",
    scoreAfterRefresh === scoreTextA,
    `before=${scoreTextA} after=${scoreAfterRefresh}`,
  );
  const playHiddenAfterRefresh = await pageA.locator("#play").isHidden();
  check("play form does not reappear after refresh (no re-submit)", playHiddenAfterRefresh);

  await ctxA.close();

  // --- second player, fresh browser context = fresh localStorage ----------
  console.log(`\n=== session 2 (player B, clean browser profile) ===`);
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await pageB.locator("#play").waitFor({ state: "visible", timeout: 10 * 60 * 1000 });
  check("a second, independent browser session can load and play", true);

  await pageB.fill("#name", "Bea");
  await pageB.fill("#answer", "My dog farted and everyone started laughing.");
  await pageB.click("#submit");
  await pageB.locator("#result").waitFor({ state: "visible", timeout: 60000 });
  const scoreB = Number(await pageB.locator("#score").textContent());
  check("second player gets their own real score", Number.isInteger(scoreB) && scoreB >= 0 && scoreB <= 100, `score=${scoreB}`);
  check(
    "two different answers get different scores (not a fixed/fake number)",
    scoreB !== scoreA,
    `A=${scoreA} B=${scoreB}`,
  );

  await ctxB.close();
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? "ALL BROWSER CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
