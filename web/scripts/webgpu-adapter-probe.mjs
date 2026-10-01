/**
 * Reports everything requestAdapter()/requestDevice() can tell us, across
 * every legitimate adapter-request option WebGPU exposes, so we can tell
 * whether any of them changes the outcome versus the zero-argument call
 * judge.js currently makes. No spoofing: this only tries real, spec-defined
 * GPURequestAdapterOptions.
 *
 *   node scripts/webgpu-adapter-probe.mjs <url> [--broken-gpu|--no-gpu]
 */
import { chromium } from "playwright-core";
import fs from "node:fs";

const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const url = process.argv[2] || "https://biccyanzac-pixel.github.io/jacob.gg/";
const simulate = process.argv[3];

const browser = await chromium.launch({ executablePath: EDGE_PATHS.find((p) => fs.existsSync(p)), headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

if (simulate === "--no-gpu") {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
  });
} else if (simulate === "--broken-gpu") {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", {
      value: {
        requestAdapter: async () => {
          throw new DOMException("WebGPU is not supported on this device.", "NotSupportedError");
        },
        getPreferredCanvasFormat: () => "bgra8unorm",
      },
      configurable: true,
    });
  });
}

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

const report = await page.evaluate(async () => {
  const out = { navigatorGpuExists: typeof navigator.gpu !== "undefined", attempts: [] };
  if (!out.navigatorGpuExists) return out;

  const optionSets = [
    { label: "default (no options)", options: undefined },
    { label: "powerPreference: low-power", options: { powerPreference: "low-power" } },
    { label: "powerPreference: high-performance", options: { powerPreference: "high-performance" } },
    { label: "forceFallbackAdapter: true", options: { forceFallbackAdapter: true } },
  ];

  for (const { label, options } of optionSets) {
    const attempt = { label, options };
    try {
      const adapter = await navigator.gpu.requestAdapter(options);
      if (!adapter) {
        attempt.requestAdapterResult = "null (no adapter)";
      } else {
        attempt.requestAdapterResult = "adapter obtained";
        attempt.isFallbackAdapter = adapter.isFallbackAdapter ?? "unknown";
        try {
          const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
          attempt.adapterInfo = info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : "unavailable";
        } catch (e) {
          attempt.adapterInfo = `error: ${e?.message || e}`;
        }
        attempt.features = Array.from(adapter.features ?? []);
        attempt.limits = adapter.limits
          ? {
              maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
              maxBufferSize: adapter.limits.maxBufferSize,
              maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
              maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
            }
          : "unavailable";
        try {
          const device = await adapter.requestDevice();
          attempt.requestDeviceResult = "device obtained";
          device.destroy?.();
        } catch (e) {
          attempt.requestDeviceResult = `threw: ${e?.name}: ${e?.message}`;
        }
      }
    } catch (e) {
      attempt.requestAdapterResult = `threw: ${e?.name}: ${e?.message}`;
    }
    out.attempts.push(attempt);
  }
  return out;
});

console.log(JSON.stringify(report, null, 2));
await browser.close();
