import { chromium } from "playwright-core";
import fs from "node:fs";
const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const url = process.argv[2] || "http://localhost:5173/scripts/riddle-bench/wasm-probe.html";
const forceNoGpu = process.argv.includes("--no-gpu");
const forceBrokenGpu = process.argv.includes("--broken-gpu");

const browser = await chromium.launch({ executablePath: EDGE_PATHS.find((p) => fs.existsSync(p)), headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
if (forceNoGpu) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
  });
} else if (forceBrokenGpu) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", {
      value: { requestAdapter: async () => { throw new DOMException("WebGPU is not supported on this device.", "NotSupportedError"); } },
      configurable: true,
    });
  });
}
page.on("console", (m) => console.log(`[${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(
  () => document.getElementById("out")?.textContent.includes("DONE"),
  undefined,
  { timeout: 3 * 60 * 1000, polling: 500 },
).catch((e) => console.log("TIMED OUT:", e?.message));

console.log("--- final output ---");
console.log(await page.locator("#out").textContent());
await browser.close();
