import * as ort from "onnxruntime-web/wasm";

const out = document.getElementById("out");
const log = (s) => { out.textContent += s + "\n"; console.log(s); };

ort.env.wasm.wasmPaths = "/scripts/kev-wasm-export/wasm-runtime/";
ort.env.wasm.numThreads = 1;

try {
  log(`navigator.gpu present: ${typeof navigator.gpu !== "undefined"}`);
  const [modelBuf, dataBuf] = await Promise.all([
    fetch("/scripts/kev-wasm-export/model_q4.onnx").then((r) => r.arrayBuffer()),
    fetch("/scripts/kev-wasm-export/model_q4.onnx_data").then((r) => r.arrayBuffer()),
  ]);
  log(`model graph: ${modelBuf.byteLength} bytes, external data: ${dataBuf.byteLength} bytes`);

  const t0 = performance.now();
  const session = await ort.InferenceSession.create(new Uint8Array(modelBuf), {
    executionProviders: ["wasm"],
    externalData: [{ path: "model_q4.onnx_data", data: new Uint8Array(dataBuf) }],
  });
  log(`SESSION_LOAD_OK in ${Math.round(performance.now() - t0)}ms`);
  log(`inputNames: ${session.inputNames}, outputNames: ${session.outputNames}`);

  const seqLen = 36;
  const inputIds = new BigInt64Array(seqLen).fill(1n);
  const mask = new BigInt64Array(seqLen).fill(1n);
  const t1 = performance.now();
  const results = await session.run({
    input_ids: new ort.Tensor("int64", inputIds, [1, seqLen]),
    attention_mask: new ort.Tensor("int64", mask, [1, seqLen]),
  });
  log(`INFER_OK in ${Math.round(performance.now() - t1)}ms`);
  log(`output shape: ${results.logits.dims}`);
  log("DONE");
} catch (err) {
  log(`ERROR: ${err?.stack || err}`);
  log("DONE_WITH_ERROR");
}
