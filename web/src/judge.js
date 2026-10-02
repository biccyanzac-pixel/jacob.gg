/**
 * The judge, running in this browser.
 *
 * open-jev (github.com/nico-martin/open-jev) via Transformers.js. It is a
 * typed-decision model: one forward pass returns a probability distribution
 * over options we supply. Nothing is generated, so it cannot "write a score" -
 * a noul question returns p(yes) for a statement, and that probability is the
 * game's score.
 *
 * Exactly one Noul call per answer, by design: the statement asks a single
 * question - does this answer make the riddle true under a plausible
 * interpretation - and a second model call was tested and rejected (it
 * performed worse; see web/scripts/riddle-bench/). The one deterministic,
 * non-AI defense that measurement showed necessary (against restating the
 * riddle's own wording) lives in shared/gibberish.js and runs before this is
 * ever called, not as a second model evaluation.
 *
 * WebGPU is the primary path, with a same-model WASM fallback for devices
 * without usable WebGPU. kev-0.6b's published weights (onnx-community/
 * kev-0.6b-ONNX) ship only as q4 and q4f16, both using the
 * GatherBlockQuantized/MatMulNBits ONNX operators. Those operators turned
 * out to have a genuinely working CPU/WASM implementation all along - but
 * only in onnxruntime-web's plain "wasm" bundle, not the combined
 * "webgpu" bundle that open-jev/Transformers.js's own model loader always
 * resolves to regardless of the requested device (confirmed via the actual
 * failing stack trace - see web/scripts/kev-wasm-export/
 * PART_A_AND_B_REPORT.md for the full investigation and the 58-case
 * benchmark showing q4-via-WebGPU and q4-via-plain-WASM agree to within
 * 0.01 points, 100% binary agreement, 0 flips). judge-wasm.js talks to
 * that plain bundle directly, bypassing open-jev's loader for the WASM
 * case only, and reimplements the same "kev" family input construction
 * open-jev's own code uses - same model file, same math, same statement.
 *
 * dtype is always explicit "q4" on both paths, never "auto": open-jev's
 * auto-selection can pick "q4f16" when the WebGPU adapter reports
 * shader-f16, and q4f16 has no WASM-path equivalent (it is a WebGPU-only
 * dtype). Using "q4" unconditionally means every player, on either
 * backend, gets literally the same model file - see isWebGpuUsable() below
 * for the separate mobile bug (WebGPU existing but non-functional) this
 * module also guards against.
 *
 * Weights are fetched from Hugging Face once and then live in the browser's
 * cache (judgeInfo()'s isCached tracks the WebGPU path's own Transformers.js
 * cache; the WASM path relies on ordinary HTTP caching of the same
 * immutable files) - but only once a usable backend is known, so a device
 * with neither working WebGPU nor WASM never pays for a download that is
 * guaranteed to fail.
 *
 * This is NOT hosted Jev's model. It is an open reproduction of the shape of
 * System One (kev-0.6b, based on Qwen3-0.6B-Base). No API key, no credits, no
 * request to any Jev service.
 */

import { OpenJev, noul } from "open-jev";
import { assertNoul, scoreFromNoul } from "@shared/challenges.js";
import { canonicalizeForJudge } from "@shared/judge-canonicalize.js";
import { loadJudgeWasm } from "./judge-wasm.js";

// Smallest model open-jev ships. dtype is always explicit "q4" - never
// "auto" - so WebGPU and WASM always load the identical representation;
// see the module comment.
const MODEL = "kev-0.6b";
const DTYPE = "q4";

/** Thrown by loadJudge() when this device cannot run the judge at all,
 * distinct from a transient load failure (network, OOM, etc). main.js
 * branches on this to show a specific, honest message instead of a generic
 * "could not load". */
export class UnsupportedDeviceError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "UnsupportedDeviceError";
    this.cause = cause;
  }
}

let webGpuUsable = null;

/**
 * Does WebGPU actually work here, not just exist? `typeof navigator.gpu` is
 * not enough - plenty of real mobile browsers expose the API surface with a
 * non-functional or blocklisted backend underneath (older/blocklisted
 * Android GPU drivers, WebKit's younger WebGPU rollout, partial/experimental
 * builds). requestAdapter() is the actual capability probe; open-jev's own
 * "auto" device selection never calls it, which is the root cause of the
 * production mobile bug this guards against. Cached after the first call -
 * the answer cannot change mid-session.
 */
async function isWebGpuUsable() {
  if (webGpuUsable !== null) return webGpuUsable;
  if (typeof navigator === "undefined" || typeof navigator.gpu === "undefined") {
    webGpuUsable = false;
    return false;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    webGpuUsable = Boolean(adapter);
  } catch (err) {
    console.error("[judge] navigator.gpu.requestAdapter() failed - WebGPU unusable here:", err);
    webGpuUsable = false;
  }
  return webGpuUsable;
}

let loading = null;
let instance = null;
let runtime = null;

/**
 * Four distinct phases a caller can show distinct UI for. "initializing"
 * exists because Transformers.js's onProgress callback only fires during file
 * download - once every file has arrived there is still real work (building
 * the ONNX Runtime session, allocating on the WebGPU/WASM backend) with no
 * further progress events, and it is not instant. Without a name for that gap
 * the UI would sit at "100%" looking stuck for a few seconds.
 */
export const PHASE = {
  DOWNLOADING: "downloading",
  INITIALIZING: "initializing",
  READY: "ready",
  JUDGING: "judging",
};

/** Cheap, synchronous, no-download check: does this JS engine have WASM at
 * all? Unlike WebGPU there is no equivalent "looks present but doesn't
 * actually work" failure mode worth probing for here - WebAssembly is a
 * baseline, near-universal engine feature, not a capability that varies by
 * GPU driver. This only exists to catch the genuinely ancient-browser case
 * before downloading anything. */
function wasmUsable() {
  return typeof WebAssembly !== "undefined";
}

/** What the loader is about to fetch, without fetching it. `unsupported:
 * true` means this device cannot run the judge at all (see isWebGpuUsable) -
 * checked before anything is fetched, so an unsupported device never pays
 * for a download that is guaranteed to fail at model-init time. */
export async function judgeInfo() {
  if (await isWebGpuUsable()) {
    try {
      const info = await OpenJev.info({ model: MODEL, dtype: DTYPE, device: "webgpu" });
      return {
        isCached: Boolean(info.isCached),
        downloadBytes: Number(info.downloadSize) || 0,
        device: info.device,
        dtype: info.dtype,
        unsupported: false,
      };
    } catch {
      // Not fatal: we can still try to load.
      return { isCached: false, downloadBytes: 0, device: "unknown", dtype: DTYPE, unsupported: false };
    }
  }
  if (wasmUsable()) {
    // Same model file either way; exact size isn't probed ahead of time for
    // the WASM path (no Transformers.js cache-metadata API to ask here,
    // unlike the WebGPU path's OpenJev.info()) - reporting the known q4
    // download size directly instead of a network round trip just to ask.
    return { isCached: false, downloadBytes: 323_000_000, device: "wasm", dtype: DTYPE, unsupported: false };
  }
  return { isCached: false, downloadBytes: 0, device: "unsupported", dtype: DTYPE, unsupported: true };
}

/**
 * Load the judge once. `onPhase` is called with ({ phase, progress, loaded,
 * total }) as loading moves through PHASE.DOWNLOADING (progress 0..1, loaded
 * and total in bytes when known) then PHASE.INITIALIZING (no further
 * progress, just the phase change) then resolves once ready.
 *
 * Concurrent callers share one load and each gets their own phase callbacks.
 */
export function loadJudge({ onPhase } = {}) {
  if (instance) return Promise.resolve(instance);

  if (loading) {
    // A second caller joining an in-flight load: it should still see phase
    // updates, not silence, so give it at least the ready/initializing signal
    // once the shared promise settles (the initial download progress is
    // already gone by the time a second caller arrives, which is fine - the
    // UI only needs this for the very first caller in practice).
    return loading;
  }

  loading = isWebGpuUsable()
    .then((usable) => {
      if (usable) return loadWithWebGpu(onPhase);
      if (!wasmUsable()) {
        // Checked before any download: neither backend exists here, so
        // there is nothing to gain by attempting a load that cannot
        // possibly succeed.
        throw new UnsupportedDeviceError(
          "This browser can't run today's judge. Try a recent version of Chrome, Edge, or Safari with WebGPU enabled.",
        );
      }
      return loadWithWasm(onPhase).catch((err) => {
        console.error("[judge] WASM fallback failed after WebGPU was unusable:", err);
        throw new UnsupportedDeviceError(
          "This browser can't run today's judge. Try a recent version of Chrome, Edge, or Safari with WebGPU enabled.",
          err,
        );
      });
    })
    .then((jev) => {
      instance = jev;
      runtime = jev.runtime;
      onPhase?.({ phase: PHASE.READY, progress: 1 });
      return jev;
    })
    .catch((err) => {
      // Let the next attempt retry rather than caching a rejection -
      // transient failures (network, OOM) deserve a retry; an
      // UnsupportedDeviceError will just be thrown again immediately, which
      // is correct (the device's capability has not changed).
      loading = null;
      throw err;
    });

  // If the model was already fully cached, Transformers.js may fire no
  // download progress at all (nothing to fetch) and jump straight to session
  // init - tell the caller it is at least initializing so the UI never shows
  // a bare, unexplained blank loading state.
  onPhase?.({ phase: PHASE.INITIALIZING, progress: 0 });

  return loading;
}

/** The actual OpenJev.load() call, once WebGPU is confirmed usable. `device`
 * is passed explicitly rather than "auto" - open-jev's own auto-detection
 * only checks `typeof navigator.gpu`, which is exactly the check that let
 * the mobile bug through; by the time this runs that capability has already
 * been verified with a real requestAdapter() call. */
function loadWithWebGpu(onPhase) {
  let reachedFullDownload = false;
  return OpenJev.load({
    model: MODEL,
    dtype: DTYPE,
    device: "webgpu",
    onProgress: ({ progress, loaded, total }) => {
      if (typeof progress !== "number") return;
      if (progress >= 1 && !reachedFullDownload) {
        reachedFullDownload = true;
        onPhase?.({ phase: PHASE.INITIALIZING, progress: 1, loaded, total });
        return;
      }
      if (!reachedFullDownload) {
        onPhase?.({ phase: PHASE.DOWNLOADING, progress, loaded, total });
      }
    },
  }).catch((err) => {
    // Wrap whatever ONNX Runtime/Transformers.js threw so the real cause is
    // always logged in full (stack, nested cause chain), not just whatever
    // .message happens to say - this is what makes a production failure
    // diagnosable instead of just "today's judge could not load".
    console.error("[judge] OpenJev.load() failed after WebGPU was confirmed usable:", err);
    throw err;
  });
}

/** The WASM fallback, once WebGPU is confirmed unusable. Talks to
 * onnxruntime-web's plain WASM bundle directly via judge-wasm.js, not
 * through open-jev/Transformers.js's own loader - see the module comment
 * for why that distinction is the entire reason this path works at all. */
function loadWithWasm(onPhase) {
  return loadJudgeWasm({ onPhase }).catch((err) => {
    console.error("[judge] loadJudgeWasm() failed:", err);
    throw err;
  });
}

/** { model, family, device, dtype } once loaded. Diagnostics only. */
export function judgeRuntime() {
  return runtime;
}

/**
 * Score one answer.
 *
 * The player's text is the `state`; the proposition is a separate argument, so
 * text inside the answer is data being judged, never an instruction. The model
 * does not read it as a prompt at all - it scores a fixed pair of options
 * ("no", "yes") against it.
 *
 * `answer` is canonicalised (see @shared/judge-canonicalize.js) before it
 * reaches the model - lowercase, whitespace, and whole-answer wrapping/
 * trailing punctuation only, never wording - applied here so both the
 * WebGPU and WASM paths always see identical input for the same answer,
 * with no separate call needed at either call site. This is NOT the same
 * normalisation used for duplicate-answer detection (shared/normalize.js) -
 * what gets stored, displayed, and hashed is still the player's original
 * text; only what the model sees is canonicalised.
 *
 * Returns { noul, score, model, device, ms }. `score` is full precision
 * (noul * 100); nothing here rounds it.
 */
export async function scoreAnswer({ answer, statement }) {
  const jev = await loadJudge();
  const started = performance.now();

  const [verdict] = await jev.decide(canonicalizeForJudge(answer), [noul(statement)]);

  if (!verdict || verdict.type !== "noul") {
    throw new Error("The judge returned an unexpected answer type.");
  }

  // p(yes). Validated before it can become a score.
  const probability = assertNoul(verdict.probability);

  return {
    noul: probability,
    score: scoreFromNoul(probability),
    model: `${runtime?.model ?? MODEL}/${runtime?.dtype ?? DTYPE}`,
    device: runtime?.device ?? "unknown",
    ms: Math.round(performance.now() - started),
  };
}
