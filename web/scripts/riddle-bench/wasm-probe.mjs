import { pipeline } from "@huggingface/transformers";

const out = document.getElementById("out");
const log = (s) => { out.textContent += s + "\n"; console.log(s); };

try {
  log(`navigator.gpu present: ${typeof navigator.gpu !== "undefined"}`);
  const MODEL = "Xenova/nli-deberta-v3-xsmall";
  const t0 = performance.now();
  const classifier = await pipeline("zero-shot-classification", MODEL, {
    device: "wasm",
    dtype: "int8",
    progress_callback: (p) => {
      if (p.status === "progress") log(`  downloading ${p.file}: ${Math.round(p.progress)}%`);
    },
  });
  log(`LOAD_OK in ${Math.round(performance.now() - t0)}ms`);

  const t1 = performance.now();
  const result = await classifier("a password", ["yes", "no"], {
    hypothesis_template: "The answer makes the riddle true: {}.",
  });
  log(`INFER_OK in ${Math.round(performance.now() - t1)}ms`);
  log(`RESULT: ${JSON.stringify(result)}`);
  log("DONE");
} catch (err) {
  log(`ERROR: ${err?.stack || err}`);
  log("DONE_WITH_ERROR");
}
