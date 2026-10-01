import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));

const browser = await chromium.launch({ executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.addInitScript(() => {
  Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
});
page.on("console", (m) => { console.log("[console error]", m.text()); });
await page.goto("http://localhost:5173/scripts/kev-wasm-export/q4-wasm-sweep.html", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.q4WasmSweepReady === true, undefined, { timeout: 30000 });
console.log("navigator.gpu present:", await page.evaluate(() => typeof navigator.gpu !== "undefined"));
console.log("running sweep (58 cases, real WASM, no GPU)...");
const rows = await page.evaluate(() => window.runQ4WasmSweep());
console.log(`done: ${rows.length} rows, ${rows.filter((r) => r.ok).length} ok`);
fs.writeFileSync(path.join(here, "q4_wasm_results.json"), JSON.stringify(rows, null, 2));
await browser.close();
