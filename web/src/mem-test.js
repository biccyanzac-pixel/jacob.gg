/**
 * Isolated memory/diagnostic harness for the real-device WASM OOM
 * investigation - deliberately has NO dependency on judge.js, judge-wasm.js,
 * the tokenizer, or Transformers.js. It loads the exact same production
 * kev-0.6b q4 model (model_q4.onnx + model_q4.onnx_data, unmodified) through
 * plain onnxruntime-web/wasm, using the same fetch/session-create strategy
 * judge-wasm.js uses, so a pass/fail here tells us whether a real-device
 * failure is caused by onnxruntime-web + this model on this device, or by
 * something in the surrounding app. Not linked from the game UI - reached
 * directly at /mem-test.html for manual testing only.
 */
import * as ort from "onnxruntime-web/wasm";

const MODEL_BASE_URL = "https://huggingface.co/onnx-community/kev-0.6b-ONNX/resolve/main";

const logEl = document.getElementById("log");
const runBtn = document.getElementById("run");

function log(line) {
  const text = typeof line === "string" ? line : JSON.stringify(line, null, 2);
  logEl.textContent += text + "\n";
  console.log("[mem-test]", line);
  logEl.scrollTop = logEl.scrollHeight;
}

/** Whatever memory info this browser exposes - none of these are available
 * everywhere (performance.memory is Chromium-only and non-standard;
 * deviceMemory is Chromium-only and coarse-bucketed; WebKit/Safari exposes
 * neither), so this is "whatever we can get," not a complete picture. */
function memorySnapshot(label) {
  const info = { label, t: Math.round(performance.now()) };
  if (performance.memory) {
    info.jsHeapUsedMB = Math.round(performance.memory.usedJSHeapSize / 1e6);
    info.jsHeapTotalMB = Math.round(performance.memory.totalJSHeapSize / 1e6);
    info.jsHeapLimitMB = Math.round(performance.memory.jsHeapSizeLimit / 1e6);
  }
  if (navigator.deviceMemory) info.deviceMemoryGB = navigator.deviceMemory;
  log(info);
  return info;
}

async function fetchWithProgress(url, onBytes) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch failed (${response.status}): ${url}`);
  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  if (!total) {
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onBytes?.(loaded, total);
    }
    const out = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, offset);
    offset += value.length;
    onBytes?.(offset, total);
  }
  return offset === total ? out : out.subarray(0, offset);
}

async function run() {
  logEl.textContent = "";
  runBtn.disabled = true;
  try {
    log(`onnxruntime-web version: ${ort.env.versions?.web ?? "unknown"}`);
    log({
      webAssembly: typeof WebAssembly !== "undefined",
      sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
      crossOriginIsolated: Boolean(self.crossOriginIsolated),
      userAgent: navigator.userAgent,
      deviceMemoryGB: navigator.deviceMemory ?? "unavailable (non-Chromium)",
    });
    memorySnapshot("before anything");

    ort.env.wasm.numThreads = 1;
    const version = ort.env.versions?.web;
    if (version) {
      const prefix = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/`;
      ort.env.wasm.wasmPaths = {
        mjs: `${prefix}ort-wasm-simd-threaded.mjs`,
        wasm: `${prefix}ort-wasm-simd-threaded.wasm`,
      };
    }

    log("downloading model_q4.onnx (graph) ...");
    const modelBuf = await fetchWithProgress(`${MODEL_BASE_URL}/onnx/model_q4.onnx`);
    log(`graph downloaded: ${modelBuf.byteLength} bytes`);
    memorySnapshot("after graph download");

    log("downloading model_q4.onnx_data (~375MB) ...");
    let lastPct = -1;
    const dataBuf = await fetchWithProgress(`${MODEL_BASE_URL}/onnx/model_q4.onnx_data`, (loaded, total) => {
      const pct = Math.floor((loaded / total) * 100);
      if (pct !== lastPct && pct % 10 === 0) {
        lastPct = pct;
        log(`  ${pct}% (${loaded} / ${total} bytes)`);
      }
    });
    log(`external data downloaded: ${dataBuf.byteLength} bytes`);
    memorySnapshot("after external-data download, before session-create");

    log("calling ort.InferenceSession.create() ...");
    const t0 = performance.now();
    const session = await ort.InferenceSession.create(modelBuf, {
      executionProviders: ["wasm"],
      externalData: [{ path: "model_q4.onnx_data", data: dataBuf }],
      enableCpuMemArena: false,
      enableMemPattern: false,
    });
    log(`session created in ${Math.round(performance.now() - t0)}ms`);
    log({ inputNames: session.inputNames, outputNames: session.outputNames });
    memorySnapshot("after session-create");

    log("running a trivial dummy inference (no tokenizer - raw placeholder ids) ...");
    const ids = [1n, 2n, 3n, 4n, 5n];
    const t1 = performance.now();
    const results = await session.run({
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids), [1, ids.length]),
      attention_mask: new ort.Tensor("int64", BigInt64Array.from(ids.map(() => 1n)), [1, ids.length]),
    });
    log(`inference ran in ${Math.round(performance.now() - t1)}ms, output shape: ${results.logits?.dims}`);
    memorySnapshot("after first inference");

    log("\n=== RESULT: SUCCESS - this device can load and run the exact production q4 model via plain WASM. ===");
  } catch (err) {
    memorySnapshot("at failure");
    log("\n=== RESULT: FAILED ===");
    log(`${err?.name}: ${err?.message}`);
    log(String(err?.stack || err));
    let cause = err?.cause;
    let depth = 0;
    while (cause && depth < 6) {
      log(`caused by: ${cause?.name ?? ""} ${cause?.message ?? cause}`);
      cause = cause?.cause;
      depth++;
    }
  } finally {
    runBtn.disabled = false;
  }
}

runBtn.addEventListener("click", run);
