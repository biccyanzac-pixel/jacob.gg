/**
 * Determinism check (Phase 7, item 1): does the current production judge
 * (kev-0.6b, WebGPU, same browser/session) give the same Noul probability
 * for the exact same answer scored repeatedly?
 *
 * Loads the judge once in a real browser, then calls scoreAnswer() N times
 * in that same loaded session for a fixed (statement, answer) pair - no
 * rounding anywhere in what's reported, so a real difference can't hide.
 *
 *   node scripts/repeat-scoring-test.mjs [url] [N]
 */
import { chromium } from "playwright-core";
import fs from "node:fs";

const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const url = process.argv[2] || "http://localhost:5173/";
const N = Number(process.argv[3] || 8);

const browser = await chromium.launch({ executablePath: EDGE_PATHS.find((p) => fs.existsSync(p)), headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("[console error]", m.text()); });

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

const result = await page.evaluate(
  async ({ n }) => {
    const { loadJudge, scoreAnswer, judgeRuntime } = await import("/src/judge.js");
    await loadJudge();
    const statement =
      'Is the answer a plausible interpretation of the riddle "What can you enter without going in?" that resolves its apparent contradiction?';
    const answer = "a competition";
    const runs = [];
    for (let i = 0; i < n; i += 1) {
      const verdict = await scoreAnswer({ answer, statement });
      runs.push({ noul: verdict.noul, score: verdict.score });
    }
    return { runs, runtime: judgeRuntime() };
  },
  { n: N },
);

console.log(`runtime: ${JSON.stringify(result.runtime)}\n`);
console.log("run  raw noul (full precision)        score");
result.runs.forEach((r, i) => {
  console.log(`${String(i + 1).padStart(3)}  ${r.noul.toPrecision(17).padEnd(24)}  ${r.score}`);
});

const nouls = result.runs.map((r) => r.noul);
const scores = result.runs.map((r) => r.score);
const nMax = Math.max(...nouls), nMin = Math.min(...nouls);
const sMax = Math.max(...scores), sMin = Math.min(...scores);
console.log(`\nnoul  max-min = ${(nMax - nMin).toPrecision(17)}`);
console.log(`score max-min = ${sMax - sMin}`);
console.log(nMax === nMin ? "DETERMINISTIC: identical noul every run" : "NOT BIT-IDENTICAL across runs");

await browser.close();
