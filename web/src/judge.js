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
 * WebGPU when the browser has it, WebAssembly otherwise. Weights are fetched
 * from Hugging Face once and then live in the browser's Cache Storage, so a
 * second visit does not re-download them (see judgeInfo()'s isCached).
 *
 * This is NOT hosted Jev's model. It is an open reproduction of the shape of
 * System One (kev-0.6b, based on Qwen3-0.6B-Base). No API key, no credits, no
 * request to any Jev service.
 */

import { OpenJev, noul } from "open-jev";
import { assertNoul, scoreFromNoul } from "@shared/challenges.js";

// Smallest model open-jev ships. dtype "auto" picks q4f16 where the device
// supports shader-f16 and q4 otherwise, which is the smallest practical
// quantisation in each case.
const MODEL = "kev-0.6b";
const DTYPE = "auto";

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

/** What the loader is about to fetch, without fetching it. */
export async function judgeInfo() {
  try {
    const info = await OpenJev.info({ model: MODEL, dtype: DTYPE });
    return {
      isCached: Boolean(info.isCached),
      downloadBytes: Number(info.downloadSize) || 0,
      device: info.device,
      dtype: info.dtype,
    };
  } catch {
    // Not fatal: we can still try to load.
    return { isCached: false, downloadBytes: 0, device: "unknown", dtype: DTYPE };
  }
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

  let reachedFullDownload = false;

  loading = OpenJev.load({
    model: MODEL,
    dtype: DTYPE,
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
  })
    .then((jev) => {
      instance = jev;
      runtime = jev.runtime;
      onPhase?.({ phase: PHASE.READY, progress: 1 });
      return jev;
    })
    .catch((err) => {
      // Let the next attempt retry rather than caching a rejection.
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
 * Returns { noul, score, model, device, ms }. `score` is full precision
 * (noul * 100); nothing here rounds it.
 */
export async function scoreAnswer({ answer, statement }) {
  const jev = await loadJudge();
  const started = performance.now();

  const [verdict] = await jev.decide(answer, [noul(statement)]);

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
