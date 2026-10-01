import { chromium } from "playwright-core";
import fs from "node:fs";
const browser = await chromium.launch({ executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const noGpu = process.argv.includes("--no-gpu");
if (noGpu) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
  });
}
page.on("console", (m) => console.log(`[${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));
await page.goto("http://localhost:5173/scripts/kev-wasm-export/q4-wasm-direct-test.html", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => document.getElementById("out")?.textContent.includes("DONE"), undefined, { timeout: 120000, polling: 500 });
console.log("--- final ---");
console.log(await page.locator("#out").textContent());
await browser.close();
