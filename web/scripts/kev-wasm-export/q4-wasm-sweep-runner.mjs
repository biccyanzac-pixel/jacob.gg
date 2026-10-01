import { AutoTokenizer } from "@huggingface/transformers";
import * as ort from "onnxruntime-web/wasm";
import { RIDDLES } from "/scripts/riddle-bench/cases.mjs";

ort.env.wasm.wasmPaths = "/scripts/kev-wasm-export/wasm-runtime/";
ort.env.wasm.numThreads = 1;

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
  if (ids.length !== 1) throw new Error(`${text} is not a single token: ${ids}`);
  return ids[0];
}
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

window.runQ4WasmSweep = async () => {
  const tokenizer = await AutoTokenizer.from_pretrained("onnx-community/kev-0.6b-ONNX");
  const [modelBuf, dataBuf] = await Promise.all([
    fetch("/scripts/kev-wasm-export/model_q4.onnx").then((r) => r.arrayBuffer()),
    fetch("/scripts/kev-wasm-export/model_q4.onnx_data").then((r) => r.arrayBuffer()),
  ]);
  const session = await ort.InferenceSession.create(new Uint8Array(modelBuf), {
    executionProviders: ["wasm"],
    externalData: [{ path: "model_q4.onnx_data", data: new Uint8Array(dataBuf) }],
  });

  const rows = [];
  let i = 0;
  const total = RIDDLES.reduce((s, r) => s + r.cases.length, 0);
  for (const riddle of RIDDLES) {
    const statement = `Is the answer a plausible interpretation of the riddle "${riddle.prompt}" that resolves its apparent contradiction?`;
    for (const c of riddle.cases) {
      i += 1;
      console.log(`[${i}/${total}] ${riddle.id} t${c.tier} "${c.answer}"`);
      const { inputIds, optionPositions } = buildInputs(tokenizer, c.answer, statement);
      const t0 = performance.now();
      const results = await session.run({
        input_ids: new ort.Tensor("int64", BigInt64Array.from(inputIds.map(BigInt)), [1, inputIds.length]),
        attention_mask: new ort.Tensor("int64", BigInt64Array.from(inputIds.map(() => 1n)), [1, inputIds.length]),
      });
      const ms = performance.now() - t0;
      console.log(`  -> ${Math.round(ms)}ms`);
      const flat = Array.from(results.logits.data);
      const optLogits = optionPositions.map((p) => flat[p]);
      const max = Math.max(...optLogits);
      const exps = optLogits.map((v) => Math.exp(v - max));
      const sum = exps.reduce((a, b) => a + b, 0);
      const probs = exps.map((v) => v / sum);
      const pYes = probs[OPTIONS.indexOf("yes")];
      rows.push({ riddle: riddle.id, tier: c.tier, answer: c.answer, noul: pYes, score: pYes * 100, ms, ok: true });
    }
  }
  return rows;
};
window.q4WasmSweepReady = true;
