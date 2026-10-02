/**
 * Wired into production judge.js as the WASM fallback when WebGPU is
 * unusable. See web/scripts/kev-wasm-export/PART_A_AND_B_REPORT.md for the
 * investigation this implements: the exact production kev-0.6b q4 ONNX
 * model (same file
 * open-jev fetches, unmodified) genuinely runs through onnxruntime-web's
 * plain WASM bundle - but only when that bundle is loaded directly. Calling
 * open-jev/Transformers.js with device:"wasm" does NOT reach this bundle:
 * their model loader always resolves to the combined webgpu+wasm bundle
 * (confirmed via the actual failing stack trace in the investigation
 * report), whose WASM path genuinely lacks a working GatherBlockQuantized
 * kernel. This module bypasses open-jev's model loading for the WASM case
 * only and talks to onnxruntime-web's plain "wasm" bundle directly, while
 * reusing the real tokenizer and reimplementing exactly the same "kev"
 * family input construction and readout open-jev's own F()/run() use
 * (node_modules/open-jev/dist/index.js) - same model, same math, same
 * statement, different loading path.
 *
 * dtype is always "q4" here - this bundle was only verified against q4,
 * and q4f16 is a WebGPU-oriented dtype (needs shader-f16 to pick it, which
 * is a WebGPU adapter feature with no WASM equivalent) - never requested.
 */
import { AutoTokenizer } from "@huggingface/transformers";
import * as ort from "onnxruntime-web/wasm";

const MODEL_REPO = "onnx-community/kev-0.6b-ONNX";
const MODEL_BASE_URL = `https://huggingface.co/${MODEL_REPO}/resolve/main`;

// Mirrors open-jev's "kev" family defaults exactly (node_modules/open-jev/dist/index.js,
// function te()): these are the literal delimiter strings for kev-0.6b's
// config, not something this module invents.
const DELIMS = {
  state: "<|fim_prefix|>",
  question: "<|fim_middle|>",
  option_start: "<|box_start|>",
  option_end: "<|box_end|>",
  decide: "<|fim_suffix|>",
};
const OPTIONS = ["no", "yes"];

function tok(tokenizer, text) {
  return Array.from(tokenizer(text, { add_special_tokens: false }).input_ids.data, Number);
}

function markerId(tokenizer, text) {
  const ids = tok(tokenizer, text);
  if (ids.length !== 1) throw new Error(`[judge-wasm] "${text}" is not a single token: ${ids}`);
  return ids[0];
}

/** Mirrors open-jev's F() (the "kev" family's encode()) for the single-
 * question, two-option (noul) case this game always uses. */
function buildInputs(tokenizer, stateText, instructionsText) {
  const markers = {};
  for (const [k, v] of Object.entries(DELIMS)) markers[k] = markerId(tokenizer, v);
  const instrIds = tok(tokenizer, instructionsText);
  const branch = [markers.question, ...instrIds];
  const ends = [];
  for (const opt of OPTIONS) {
    const optIds = tok(tokenizer, opt);
    branch.push(markers.option_start, ...optIds, markers.option_end);
    ends.push(branch.length - 1);
  }
  branch.push(markers.decide);
  const stateIds = tok(tokenizer, stateText);
  const inputIds = [markers.state, ...stateIds, ...branch];
  const base = 1 + stateIds.length;
  const optionPositions = ends.map((e) => base + e);
  return { inputIds, optionPositions };
}

/** Fetch with byte-level progress, matching judge.js's onPhase contract.
 *
 * Writes directly into a single pre-sized output buffer instead of
 * collecting chunks in an array and concatenating afterward - for the
 * ~375MB external-data file, the chunks-then-concatenate pattern briefly
 * held both the chunk array and the final buffer in memory at once (close
 * to double the file's size), which is exactly the kind of avoidable
 * overhead that contributed to a confirmed real-device
 * `RangeError: Out of memory` at the next stage (session-create). This
 * still requires a trustworthy `content-length` header (true for both
 * huggingface.co model files); if it's missing, falls back to the
 * old collect-and-concatenate path rather than guessing a size. */
async function fetchWithProgress(url, onBytes) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`[judge-wasm] fetch failed (${response.status}): ${url}`);
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body || !onBytes) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  if (!total) {
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onBytes(loaded, total);
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
    onBytes(offset, total);
  }
  return offset === total ? out : out.subarray(0, offset);
}

class WasmJev {
  constructor({ session, tokenizer }) {
    this.session = session;
    this.tokenizer = tokenizer;
    this.runtime = { model: MODEL_REPO, family: "kev", device: "wasm", dtype: "q4" };
    this.disposed = false;
  }

  /** Same shape as open-jev's decide(): takes a state string and an array
   * of question objects, returns an array of verdicts. This game only ever
   * passes one noul() question, so only that shape is implemented. */
  async decide(state, questions) {
    if (this.disposed) throw new Error("[judge-wasm] instance has been disposed.");
    if (!Array.isArray(questions) || questions.length !== 1 || questions[0]?.type !== "noul") {
      throw new Error("[judge-wasm] only a single noul() question is supported.");
    }
    const { inputIds, optionPositions } = await stage("input-construction", () =>
      buildInputs(this.tokenizer, state, questions[0].instructions),
    );
    const results = await stage("inference", () =>
      this.session.run({
        input_ids: new ort.Tensor("int64", BigInt64Array.from(inputIds.map(BigInt)), [1, inputIds.length]),
        attention_mask: new ort.Tensor("int64", BigInt64Array.from(inputIds.map(() => 1n)), [1, inputIds.length]),
      }),
    );
    const flat = results.logits.data;
    const optLogits = optionPositions.map((p) => Number(flat[p]));
    const max = Math.max(...optLogits);
    const exps = optLogits.map((v) => Math.exp(v - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    const probs = exps.map((v) => v / sum);
    const probability = probs[OPTIONS.indexOf("yes")];
    return [{ type: "noul", answer: probability >= 0.5, probability, confidence: Math.max(probability, 1 - probability) }];
  }

  async dispose() {
    this.disposed = true;
    await this.session.release?.();
  }
}

/** Thrown with a `stage` tag identifying exactly which step failed - a
 * real-device WASM failure was previously indistinguishable from any other
 * ("This device can't run today's judge" could mean anything from
 * WebAssembly genuinely not existing to a session-creation OOM). The
 * original error is always preserved as `.cause`. */
export class WasmStageError extends Error {
  constructor(stageName, cause) {
    super(`[judge-wasm:${stageName}] ${cause?.message ?? cause}`);
    this.name = "WasmStageError";
    this.stage = stageName;
    this.cause = cause;
  }
}

async function stage(name, fn) {
  try {
    return await fn();
  } catch (err) {
    throw new WasmStageError(name, err);
  }
}

/** Reports what can be checked cheaply, without proving anything on its
 * own - SharedArrayBuffer/crossOriginIsolated absence does not necessarily
 * break a `numThreads: 1` session, and its presence does not guarantee
 * success either. Logged so a real failure's context is visible alongside
 * the actual error, rather than guessed at separately. */
export function wasmCapabilitySnapshot() {
  const snapshot = {
    webAssembly: typeof WebAssembly !== "undefined",
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    crossOriginIsolated: typeof self !== "undefined" ? Boolean(self.crossOriginIsolated) : null,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
  };
  // Neither is available everywhere - performance.memory is Chromium-only
  // and non-standard, deviceMemory is Chromium-only and coarse-bucketed, and
  // WebKit/Safari (the iOS case) exposes neither. Logged as context only:
  // their absence proves nothing, but their presence is a real clue when a
  // real-device OOM report comes in without devtools attached.
  if (typeof navigator !== "undefined" && navigator.deviceMemory) {
    snapshot.deviceMemoryGB = navigator.deviceMemory;
  }
  if (typeof performance !== "undefined" && performance.memory) {
    snapshot.jsHeapUsedMB = Math.round(performance.memory.usedJSHeapSize / 1e6);
    snapshot.jsHeapLimitMB = Math.round(performance.memory.jsHeapSizeLimit / 1e6);
  }
  return snapshot;
}

/** Load the exact production q4 model through onnxruntime-web's plain WASM
 * bundle directly, bypassing open-jev/Transformers.js's own model loader
 * (which always resolves to the combined webgpu+wasm bundle - see the
 * module comment). `onPhase` matches judge.js's { phase, progress, loaded,
 * total } contract so the existing loading UI needs no changes. */
export async function loadJudgeWasm({ onPhase } = {}) {
  console.error("[judge-wasm] capability snapshot before attempting WASM load:", wasmCapabilitySnapshot());
  ort.env.wasm.numThreads = 1;
  // Resolving the plain WASM binary's own URL from a bundler-relative path
  // is exactly the fragile step that broke in local dev (Vite's dependency
  // optimizer serves it at a different path than onnxruntime-web's default
  // resolution expects). Transformers.js sidesteps this itself, for its own
  // combined bundle, by pointing at a CDN mirror of the exact pinned
  // version (confirmed: that is genuinely what loads in production today).
  // Mirroring that here, for the plain (non-asyncify) bundle specifically,
  // is the same fix, not a new risk - jsdelivr serves every published npm
  // version, including this dev-tagged one.
  if (!ort.env.wasm.wasmPaths) {
    const version = ort.env.versions?.web;
    if (version) {
      const prefix = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/`;
      ort.env.wasm.wasmPaths = {
        mjs: `${prefix}ort-wasm-simd-threaded.mjs`,
        wasm: `${prefix}ort-wasm-simd-threaded.wasm`,
      };
    }
  }

  const tokenizer = await stage("tokenizer", () => AutoTokenizer.from_pretrained(MODEL_REPO));

  let graphLoaded = 0;
  let dataLoaded = 0;
  let graphTotal = 0;
  let dataTotal = 0;
  const reportProgress = () => {
    const loaded = graphLoaded + dataLoaded;
    const total = graphTotal + dataTotal;
    if (total > 0) onPhase?.({ phase: "downloading", progress: Math.min(1, loaded / total), loaded, total });
  };

  const [modelBuf, dataBuf] = await stage("model-download", () =>
    Promise.all([
      fetchWithProgress(`${MODEL_BASE_URL}/onnx/model_q4.onnx`, (l, t) => {
        graphLoaded = l;
        graphTotal = t;
        reportProgress();
      }),
      fetchWithProgress(`${MODEL_BASE_URL}/onnx/model_q4.onnx_data`, (l, t) => {
        dataLoaded = l;
        dataTotal = t;
        reportProgress();
      }),
    ]),
  );

  onPhase?.({ phase: "initializing", progress: 1 });
  console.error(
    "[judge-wasm] download complete, about to call session-create. sizes:",
    { modelBufBytes: modelBuf.byteLength, dataBufBytes: dataBuf.byteLength },
    "memory:",
    wasmCapabilitySnapshot(),
  );

  // This is where onnxruntime-web actually fetches and instantiates the
  // WASM runtime binary itself (ort-wasm-simd-threaded.wasm) - everything
  // before this point only downloaded the model's own bytes. A failure
  // here (WASM compile/instantiate, SIMD, memory, or the q4 operators
  // themselves) happens AFTER the model download the player already saw
  // complete - tagged "session-create" specifically so that distinction is
  // visible in the error rather than looking identical to a download
  // failure.
  // enableCpuMemArena/enableMemPattern default to true, which make ORT
  // pre-reserve and keep growing a memory arena, and build extra bookkeeping
  // buffers to reuse allocations across runs - both are peak-memory
  // optimizations for *repeated* inference, not relevant to this game's
  // one-shot-per-load usage, and both add overhead on top of the model's own
  // ~375MB. Disabling them trades a little speed for a smaller, more
  // predictable memory footprint, which is the actual constraint on a
  // mobile device that just hit RangeError: Out of memory at this stage.
  const session = await stage("session-create", () =>
    ort.InferenceSession.create(modelBuf, {
      executionProviders: ["wasm"],
      externalData: [{ path: "model_q4.onnx_data", data: dataBuf }],
      enableCpuMemArena: false,
      enableMemPattern: false,
    }),
  );

  return new WasmJev({ session, tokenizer });
}
