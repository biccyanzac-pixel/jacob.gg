/**
 * Part 3: does explicit dtype:"q4" behave identically regardless of
 * shader-f16 availability, and is it deterministic across repeated runs?
 * Only ONE real GPU/browser family is available in this environment
 * (this machine's Edge/Chromium + its one Intel GPU) - this script makes
 * that limitation explicit rather than implying broader hardware coverage.
 * The "no shader-f16" condition is simulated by wrapping the real adapter
 * so its .features.has("shader-f16") reports false while requestDevice()
 * still goes to the real adapter/GPU - actual compute, simulated capability.
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const url = process.argv[2] || "http://localhost:5173/scripts/kev-wasm-export/sweep-runner.html";
const browserPath = process.argv[3] || EDGE_PATHS.find((p) => fs.existsSync(p));

async function run(label, simulateNoF16) {
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (simulateNoF16) {
    await page.addInitScript(() => {
      const realRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
      navigator.gpu.requestAdapter = async (...args) => {
        const real = await realRequestAdapter(...args);
        if (!real) return real;
        return new Proxy(real, {
          get(target, prop) {
            if (prop === "features") {
              const realFeatures = target.features;
              return new Proxy(realFeatures, {
                get(ftarget, fprop) {
                  if (fprop === "has") {
                    return (name) => (name === "shader-f16" ? false : ftarget.has(name));
                  }
                  return ftarget[fprop]?.bind ? ftarget[fprop].bind(ftarget) : ftarget[fprop];
                },
              });
            }
            return typeof target[prop] === "function" ? target[prop].bind(target) : target[prop];
          },
        });
      };
    });
  }
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.sweepReady === true, undefined, { timeout: 30000 });

  const result = await page.evaluate(() => window.runQ4CrossEnvCheck());

  console.log(`\n=== ${label} ===`);
  console.log(`  dtype:auto resolved to: device=${result.autoRuntime.device} dtype=${result.autoRuntime.dtype}  noul=${result.autoNoul.toPrecision(12)}`);
  console.log(`  explicit dtype:q4 runtime: device=${result.q4Runtime.device} dtype=${result.q4Runtime.dtype}`);
  console.log(`  explicit q4, 5 repeated runs: ${result.q4Runs.map((n) => n.toPrecision(12)).join(", ")}`);
  const max = Math.max(...result.q4Runs), min = Math.min(...result.q4Runs);
  console.log(`  q4 max-min across repeats = ${(max - min).toPrecision(6)}`);

  await browser.close();
  return result;
}

const real = await run("real GPU, real adapter (no simulation)", false);
const simulated = await run("same GPU, shader-f16 REPORTED absent (simulated)", true);

console.log("\n=== cross-condition q4 comparison ===");
const diff = Math.abs(real.q4Runs[0] - simulated.q4Runs[0]);
console.log(`explicit q4 noul: real-adapter=${real.q4Runs[0].toPrecision(12)}  f16-hidden=${simulated.q4Runs[0].toPrecision(12)}  diff=${diff.toPrecision(6)}`);
console.log(diff === 0 ? "IDENTICAL: explicit q4 ignores shader-f16 entirely, as expected" : "NOT IDENTICAL - unexpected, investigate");
