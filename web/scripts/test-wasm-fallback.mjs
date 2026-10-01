import { chromium } from "playwright-core";
import fs from "node:fs";
const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const url = process.argv[2] || "http://localhost:5173/";
const mode = process.argv[3] || "no-gpu"; // no-gpu | broken-gpu | neither

const browser = await chromium.launch({ executablePath: EDGE_PATHS.find((p) => fs.existsSync(p)), headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

if (mode === "no-gpu") {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
  });
} else if (mode === "broken-gpu") {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", {
      value: { requestAdapter: async () => { throw new DOMException("WebGPU is not supported on this device.", "NotSupportedError"); } },
      configurable: true,
    });
  });
} else if (mode === "neither") {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
    // Simulate a genuinely ancient engine with no WebAssembly at all.
    Object.defineProperty(window, "WebAssembly", { value: undefined, configurable: true });
  });
}

page.on("console", (m) => { if (m.type() === "error") console.log("[console error]", m.text()); });
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

const result = await page.evaluate(async () => {
  const { loadJudge, scoreAnswer, judgeInfo, UnsupportedDeviceError } = await import("/src/judge.js");
  const info = await judgeInfo();
  const out = { info };
  try {
    await loadJudge();
    const prompt = "What can you enter without going in?";
    const statement = `Is the answer a plausible interpretation of the riddle "${prompt}" that resolves its apparent contradiction?`;
    const verdict = await scoreAnswer({ answer: "a keyboard", statement });
    out.verdict = verdict;
  } catch (err) {
    out.error = { name: err?.name, message: err?.message, isUnsupported: err instanceof UnsupportedDeviceError };
  }
  return out;
});

console.log(`mode=${mode}`);
console.log(JSON.stringify(result, null, 2));
await browser.close();
