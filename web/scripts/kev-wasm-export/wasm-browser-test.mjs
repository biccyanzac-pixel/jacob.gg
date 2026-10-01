import { AutoTokenizer } from "@huggingface/transformers";
import * as ort from "onnxruntime-web/wasm";

const out = document.getElementById("out");
const log = (s) => { out.textContent += s + "\n"; console.log(s); };

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

function buildInputs(tokenizer, stateText, instructionsText, maxStateTokens = 8192, maxLength = 8192) {
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

  let stateIds = tok(tokenizer, stateText);
  const c = maxLength - 1 - branch.length;
  const u = Math.min(maxStateTokens, c);
  stateIds = stateIds.slice(0, u);

  const inputIds = [markers.state, ...stateIds];
  const base = inputIds.length;
  inputIds.push(...branch);
  const optionPositions = ends.map((e) => base + e);
  const decidePosition = inputIds.length - 1;
  return { inputIds, optionPositions, decidePosition };
}

try {
  log(`navigator.gpu present: ${typeof navigator.gpu !== "undefined"}`);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = "/scripts/kev-wasm-export/";

  log("loading tokenizer...");
  const tokenizer = await AutoTokenizer.from_pretrained("onnx-community/kev-0.6b-ONNX");
  log("tokenizer loaded");

  const prompt = "What can you enter without going in?";
  const statement = `Is the answer a plausible interpretation of the riddle "${prompt}" that resolves its apparent contradiction?`;
  const answer = "a keyboard";
  const { inputIds, optionPositions, decidePosition } = buildInputs(tokenizer, answer, statement);
  log(`seq len: ${inputIds.length}`);

  log("fetching model + external weights...");
  const [modelBuf, dataBuf] = await Promise.all([
    fetch("/scripts/kev-wasm-export/kev06b_wasm_w8.onnx").then((r) => r.arrayBuffer()),
    fetch("/scripts/kev-wasm-export/kev06b_wasm_w8.onnx.data").then((r) => r.arrayBuffer()),
  ]);
  log(`model graph: ${modelBuf.byteLength} bytes, external data: ${dataBuf.byteLength} bytes`);

  log("creating ONNX Runtime WASM session (navigator.gpu untouched by this call - executionProviders forced to wasm)...");
  const t0 = performance.now();
  const session = await ort.InferenceSession.create(new Uint8Array(modelBuf), {
    executionProviders: ["wasm"],
    externalData: [{ path: "kev06b_wasm_w8.onnx.data", data: new Uint8Array(dataBuf) }],
  });
  log(`SESSION_LOAD_OK in ${Math.round(performance.now() - t0)}ms`);
  log(`inputNames: ${session.inputNames}`);

  const t1 = performance.now();
  const feeds = {
    input_ids: new ort.Tensor("int64", BigInt64Array.from(inputIds.map(BigInt)), [1, inputIds.length]),
    attention_mask: new ort.Tensor("int64", BigInt64Array.from(inputIds.map(() => 1n)), [1, inputIds.length]),
    decide_position: new ort.Tensor("int64", BigInt64Array.from([BigInt(decidePosition)]), []),
    option_positions: new ort.Tensor("int64", BigInt64Array.from(optionPositions.map(BigInt)), [optionPositions.length]),
  };
  const results = await session.run(feeds);
  log(`INFER_OK in ${Math.round(performance.now() - t1)}ms`);
  const logits = Array.from(results.logits.data);
  const max = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map((v) => v / sum);
  const pYes = probs[OPTIONS.indexOf("yes")];
  log(`logits: ${logits}`);
  log(`P(yes) = ${pYes.toFixed(4)} -> score = ${(pYes * 100).toFixed(2)}`);
  log("REFERENCE (Python onnxruntime, same file, same inputs): score = 58.18");
  log("DONE");
} catch (err) {
  log(`ERROR: ${err?.stack || err}`);
  log("DONE_WITH_ERROR");
}
