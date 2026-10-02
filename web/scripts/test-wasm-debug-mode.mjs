import { chromium } from "playwright-core";
import fs from "node:fs";
const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const url = process.argv[2] || "http://localhost:5173/";
const blockRuntime = process.argv.includes("--block-runtime");

const browser = await chromium.launch({ executablePath: EDGE_PATH, headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.addInitScript(() => {
  Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
});
if (blockRuntime) {
  // Simulate the ORT WASM runtime binary itself failing to load/instantiate
  // (stand-in for a real SIMD/memory/compile failure) by blocking the
  // specific jsdelivr request for the runtime .wasm/.mjs files only - the
  // model's own files from huggingface.co are left untouched, so this
  // isolates the "session-create" stage specifically.
  await page.route("**/cdn.jsdelivr.net/**", (route) => route.abort("failed"));
}
page.on("console", (m) => { if (m.type() === "error") console.log("[console error]", m.text()); });

await page.goto(`${url}?debug=1`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(
  () => {
    const t = document.getElementById("preparing-text")?.textContent ?? "";
    const n = document.getElementById("preparing-note")?.textContent ?? "";
    return t.includes("judge") && (n.includes("DEBUG") || document.getElementById("play")?.hidden === false);
  },
  undefined,
  { timeout: 5 * 60 * 1000, polling: 500 },
);

const text = await page.locator("#preparing-text").textContent().catch(() => "");
const note = await page.locator("#preparing-note").textContent().catch(() => "");
const playVisible = await page.locator("#play").isVisible().catch(() => false);
console.log("playVisible:", playVisible);
console.log("preparing-text:", text);
console.log("preparing-note:", note);
await browser.close();
