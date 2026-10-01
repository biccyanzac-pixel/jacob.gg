/**
 * Full apples-to-apples sweep of the REAL open-jev kev-0.6b model, forcing
 * explicit dtype: "q4" and dtype: "q4f16" in turn, across every riddle+answer
 * in scripts/riddle-bench/cases.mjs, using the exact production Noul
 * statement (shared/challenges.js's riddleStatement). Must run in a real
 * browser (Playwright) because q4/q4f16 require WebGPU, which Node does not
 * have - this is the one thing this sweep cannot do in Python.
 *
 *   node scripts/kev-wasm-export/run-sweep-q4-q4f16.mjs <url>
 *
 * Output: JSON array of { riddle, tier, answer, dtype, noul, score, ms,
 * device } written to kev-q4-q4f16-results.json next to this file.
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const base = process.argv[2] || "http://localhost:5173/";
const url = base.replace(/\/?$/, "/") + "scripts/kev-wasm-export/sweep-runner.html";

const browser = await chromium.launch({ executablePath: EDGE_PATHS.find((p) => fs.existsSync(p)), headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("[console error]", m.text()); });

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.sweepReady === true, undefined, { timeout: 30000 });

const result = [];
for (const dtype of ["q4", "q4f16"]) {
  console.log(`sweeping dtype=${dtype}...`);
  const rows = await page.evaluate((d) => window.runSweep(d), dtype);
  result.push(...rows);
  console.log(`  ${rows.filter((r) => r.ok).length}/${rows.length} ok`);
}

const outPath = path.join(here, "kev-q4-q4f16-results.json");
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(`wrote ${result.length} rows to ${outPath}`);
console.log(`ok: ${result.filter((r) => r.ok).length}, failed: ${result.filter((r) => !r.ok).length}`);
await browser.close();
