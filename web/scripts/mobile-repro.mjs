/**
 * Reproduces the mobile "Today's judge could not load" failure without a
 * physical mobile device, by injecting the exact condition known to occur on
 * real mobile browsers: `navigator.gpu` is PRESENT (so open-jev's device
 * auto-selection, which only checks typeof navigator.gpu, picks "webgpu")
 * but `requestAdapter()` fails - which is the documented real-world gap
 * (older/blocklisted Android GPU drivers, WebKit's younger WebGPU rollout,
 * partial/experimental support surfaces) - open-jev's device.js never calls
 * requestAdapter() before committing to the webgpu device, only to decide
 * the DTYPE afterwards.
 *
 * This also runs a CONTROL case (real desktop WebGPU, untouched) to confirm
 * the injection technique itself isn't what breaks things, and a third case
 * with navigator.gpu fully undefined (the case that already works, so the
 * fix must not disturb it).
 *
 *   node scripts/mobile-repro.mjs <url>
 */
import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.argv[2] || "https://biccyanzac-pixel.github.io/jacob.gg/";
const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const browser = await chromium.launch({
  executablePath: EDGE_PATHS.find((p) => fs.existsSync(p)),
  headless: true,
});

async function run(label, initScript, deviceOptions = {}) {
  console.log(`\n${"=".repeat(70)}\n${label}\n${"=".repeat(70)}`);
  const ctx = await browser.newContext(deviceOptions);
  const page = await ctx.newPage();

  const consoleLines = [];
  page.on("console", (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err?.stack || err)));
  const failedRequests = [];
  page.on("requestfailed", (req) => failedRequests.push(`${req.url()} - ${req.failure()?.errorText}`));
  let modelAssetRequests = 0;
  page.on("request", (req) => {
    if (/huggingface\.co|\.onnx|\.onnx_data/i.test(req.url())) modelAssetRequests += 1;
  });

  if (initScript) await page.addInitScript(initScript);

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  const gpuInfo = await page.evaluate(async () => {
    const hasGpu = typeof navigator.gpu !== "undefined";
    let adapterResult = "n/a (no navigator.gpu)";
    if (hasGpu) {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        adapterResult = adapter ? "adapter obtained" : "requestAdapter returned null";
      } catch (err) {
        adapterResult = `requestAdapter threw: ${err?.message || err}`;
      }
    }
    return { hasGpu, adapterResult, ua: navigator.userAgent };
  });
  console.log(`  navigator.gpu present: ${gpuInfo.hasGpu}`);
  console.log(`  requestAdapter() result: ${gpuInfo.adapterResult}`);
  console.log(`  UA: ${gpuInfo.ua}`);

  // Wait for either the play form (success) or the error state (failure),
  // whichever happens first, with a generous timeout for real model work.
  const outcome = await Promise.race([
    page.locator("#play").waitFor({ state: "visible", timeout: 4 * 60 * 1000 }).then(() => "loaded"),
    page
      .waitForFunction(
        () => /could not load|can't run today's judge/i.test(document.getElementById("preparing-text")?.textContent ?? ""),
        // waitForFunction's signature is (pageFunction, arg, options) - the
        // options object MUST go third. Passing it second (the mistake this
        // comment replaces) silently became `arg` instead, so Playwright's
        // default 30s timeout applied regardless of what was written here,
        // and the "success" race branch kept losing to a false "timeout" on
        // anything slower than 30s (e.g. the real ~60s production download).
        undefined,
        { timeout: 4 * 60 * 1000, polling: 500 },
      )
      .then(() => "failed"),
  ]).catch(() => "timeout");

  console.log(`  OUTCOME: ${outcome}`);
  console.log(`  model asset requests made: ${modelAssetRequests} (0 means it failed fast, before downloading anything)`);

  if (outcome === "failed") {
    const headline = await page.locator("#preparing-text").textContent();
    const note = await page.locator("#preparing-note").textContent();
    console.log(`  UI headline: "${headline}"`);
    console.log(`  UI note (this is err.message today): "${note}"`);
  } else if (outcome === "loaded") {
    const runtime = await page.evaluate(() => window.__jevRuntimeForDiagnostics ?? null);
    console.log(`  judge runtime actually used: ${JSON.stringify(runtime)}`);
  }

  console.log(`  console messages (${consoleLines.length}):`);
  for (const line of consoleLines.slice(-15)) console.log(`    ${line}`);
  console.log(`  uncaught page errors (${pageErrors.length}):`);
  for (const line of pageErrors) console.log(`    ${line}`);
  console.log(`  failed network requests (${failedRequests.length}):`);
  for (const line of failedRequests.slice(0, 10)) console.log(`    ${line}`);

  await ctx.close();
  return { outcome, gpuInfo, consoleLines, pageErrors };
}

const CASES = (process.argv[3] || "2,4").split(",").map((s) => s.trim());

if (CASES.includes("1")) {
  await run("CASE 1: control (real desktop WebGPU, no injection)", null);
}

if (CASES.includes("2")) {
  // The documented real-world mobile condition this script tests for.
  await run(
    "CASE 2: navigator.gpu present, requestAdapter() rejects (simulated mobile WebGPU failure)",
    () => {
      const fakeGpu = {
        requestAdapter: async () => {
          throw new DOMException("WebGPU is not supported on this device.", "NotSupportedError");
        },
        getPreferredCanvasFormat: () => "bgra8unorm",
      };
      Object.defineProperty(navigator, "gpu", { value: fakeGpu, configurable: true });
    },
  );
}

if (CASES.includes("3")) {
  await run(
    "CASE 3: navigator.gpu present, requestAdapter() resolves null (another real mobile pattern)",
    () => {
      const fakeGpu = {
        requestAdapter: async () => null,
        getPreferredCanvasFormat: () => "bgra8unorm",
      };
      Object.defineProperty(navigator, "gpu", { value: fakeGpu, configurable: true });
    },
  );
}

if (CASES.includes("4")) {
  await run("CASE 4: navigator.gpu fully undefined (old browser, no WebGPU API at all)", () => {
    Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
  });
}

await browser.close();
