/**
 * The judge, running in this browser.
 *
 * open-jev (github.com/nico-martin/open-jev) via Transformers.js. It is a
 * typed-decision model: one forward pass returns a probability distribution
 * over options we supply. Nothing is generated, so it cannot "write a score" -
 * a noul question returns p(yes) for a statement, and that probability is the
 * game's score.
 *
 * WebGPU when the browser has it, WebAssembly otherwise. Weights are fetched
 * from Hugging Face once and then live in the browser's cache.
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
 * Load the judge once. `onProgress` gets 0..1 while files download.
 * Concurrent callers share one load.
 */
export function loadJudge({ onProgress } = {}) {
  if (instance) return Promise.resolve(instance);
  if (loading) return loading;

  loading = OpenJev.load({
    model: MODEL,
    dtype: DTYPE,
    onProgress: ({ progress }) => {
      if (typeof progress === "number" && onProgress) onProgress(progress);
    },
  })
    .then((jev) => {
      instance = jev;
      runtime = jev.runtime;
      return jev;
    })
    .catch((err) => {
      // Let the next attempt retry rather than caching a rejection.
      loading = null;
      throw err;
    });

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
 * Returns { noul, score, model, device, ms }.
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
