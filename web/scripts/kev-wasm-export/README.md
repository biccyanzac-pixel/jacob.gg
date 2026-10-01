# kev-0.6b WASM-export investigation (not shipped)

Investigates whether the *same* kev-0.6b weights (not a different model) can be
exported to a WASM-compatible ONNX representation, avoiding the
`GatherBlockQuantized`/`MatMulNBits` ops that block the published
q4/q4f16 ONNX export from running under `onnxruntime-web`'s WASM backend.

## Setup

Requires the real upstream checkpoint, loaded via the model author's own
public library (not a private dependency):

```
pip install torch transformers peft huggingface_hub onnx onnxruntime safetensors
pip install --no-deps "git+https://github.com/jaredpalmer/kev.git@90990a5fac2995b9faa3190f7d437e84f2067768"
```

`common.py` loads `jaredpalmer/kev-0.6b` (LoRA adapter + pointer head) merged
onto `Qwen/Qwen3-0.6B-Base` via `kev.checkpoint.Checkpoint` - the exact
assembly the model's own author uses, not a reverse-engineered guess. It also
reimplements open-jev's "kev" family tokenization (`F()` in
`node_modules/open-jev/dist/index.js`) exactly, so test inputs match
production token-for-token.

## What was found

1. **Architecture is not the obstacle.** `export_onnx.py` traces the model
   through a standard `transformers.Qwen3Model` forward (no custom CUDA/GPU
   kernels) and exports via plain `torch.onnx.export`. The result uses only
   `MatMul`/`Gemm`/`Gather`/`Softmax`/etc - confirmed via `onnx.load()` op
   inventory, zero `GatherBlockQuantized`/`MatMulNBits`. `verify_onnx.py`
   confirms the ONNX graph's output is numerically identical to PyTorch
   (same logits to 5+ significant figures).

2. **fp32 export is a real, working ground truth but too large**: ~2.3GB
   (596M params x 4 bytes, external weights). Not practical for mobile.

3. **Standard dynamic INT8 quantization (`onnxruntime.quantization.
   quantize_dynamic`) is NOT behaviorally safe for this model.** Tested
   three configurations - default (per-tensor), `per_channel=True`, and
   `per_channel=True, reduce_range=True` - all using exactly the WASM-
   compatible ops (`DynamicQuantizeLinear`/`MatMulInteger`/
   `DequantizeLinear`, confirmed via op inventory). `compare_quality.py`
   runs the same riddle-bench cases through fp32 and int8 side by side:

   | config | max \|diff\| | mean \|diff\| | corr(tier, score) |
   |---|---|---|---|
   | fp32 (ground truth) | - | - | 0.16 |
   | int8, per-tensor | 86.7 | 18.6 | 0.51 |
   | int8, per-channel | 66.9 | 20.5 | 0.20 |
   | int8, per-channel + reduce_range | 89.9 | 24.5 | -0.16 |

   Individual answers swing by up to ~90 points (e.g. a tier-1 "excellent"
   answer dropping from 69.94 to 11.39; obvious nonsense jumping from 14.07
   to 64.24). None of these are "sufficiently equivalent" to the source
   model - this is not a close call, and no per_channel/reduce_range
   combination fixed it. Size was ~571-600MB either way, dominated by the
   still-fp32 embedding table (594MB alone - `quantize_dynamic` does not
   touch `Gather`).

4. **Why this likely diverges from third-party evidence of 8-bit success**:
   FluidInference's CoreML conversion of this same model
   (huggingface.co/FluidInference/kev-0.6b-coreml) reports an 8-bit
   ("W8") variant staying within 0.0086 probability of the true model -
   consistent with *weight-only* quantization (int8-stored weights,
   dequantized to fp32/fp16 before every matmul, activations never
   quantized). ONNX Runtime's `quantize_dynamic` is "dynamic" by definition:
   it also quantizes activations at runtime via `DynamicQuantizeLinear` on
   every matmul. That additional activation quantization, compounding
   across 28 transformer layers into a margin-sensitive pointer-head
   decision (a small logit difference between two options), is the most
   likely explanation for the gap between these results and FluidInference's
   numbers - but this was not independently confirmed; `onnxruntime.
   quantization` has no high-level weight-only INT8 API (`quantize_dynamic`
   always quantizes activations; `matmul_4bits_quantizer` targets the
   GPU-oriented `MatMulNBits` op this investigation is specifically avoiding).
   Building a true weight-only INT8 graph would require manual ONNX graph
   surgery (inserting `DequantizeLinear` only on weights, leaving
   activations in fp32/fp16) - not attempted here; flagged as the concrete
   next step if this is pursued further.

5. **Manual weight-only INT8 graph surgery (`weight_only_quantize.py`) works
   and is behaviorally close.** Built the thing flagged above as the
   unattempted next step: for every `MatMul` whose weight is a constant,
   store it as int8 (symmetric, per-output-channel scale) with a
   `DequantizeLinear` right before the matmul; same for the embedding
   table (per-tensor scale, `Gather` on the int8 table then
   `DequantizeLinear` only on the gathered rows). Activations are never
   touched - no `DynamicQuantizeLinear`/`QuantizeLinear` anywhere in the
   resulting graph (confirmed via op inventory), only `DequantizeLinear` +
   ordinary `MatMul`/`Gather`. Result, `compare_quality_full.py` across all
   5 riddles in `cases.mjs` (58 cases), fp32 vs this candidate:

   | | max \|diff\| | mean \|diff\| | corr(tier,fp32) | corr(tier,candidate) | binary agreement |
   |---|---|---|---|---|---|
   | weight-only int8 | **7.56** | **1.80** | 0.08 | 0.10 | **58/58** |

   Compare to the dynamic-quant numbers above (max 67-90, mean 18-25): this
   is a different order of magnitude. For reference, the live production
   q4/q4f16 WebGPU judge's own score on one spot-checked case ("a keyboard"
   / "What can you enter without going in?") was 66.10, versus this fp32
   ground truth's 59.72 (a 6.38-point gap) and this candidate's 58.18 (a
   7.92-point gap from production, 1.54 from fp32) - i.e. this candidate's
   deviation from the fp32 source model is *smaller* than production's own
   existing q4/q4f16 deviation from the same source, not larger.

   Size: 599MB (`kev06b_wasm_w8.onnx` + `.onnx_data`), ~1/4 of fp32 (2.3GB)
   per the usual 8-bit ratio, still dominated by the embedding table (149MB
   int8, down from 594MB fp32) plus quantized transformer weights (~450MB).

6. **Confirmed in a real browser, not just Python.** `wasm-browser-test.mjs`
   (run via `run-wasm-browser-test.mjs` through Playwright) loads this exact
   file through `onnxruntime-web`'s actual WASM execution provider, with
   `navigator.gpu` forced undefined via `page.addInitScript` - genuinely no
   WebGPU involved, not simulated. It tokenizes the same answer/statement
   pair with the real tokenizer, builds the same input tensors, and runs
   real inference:

   ```
   navigator.gpu present: false
   SESSION_LOAD_OK in 5808ms
   INFER_OK in 3846ms
   P(yes) = 0.5821 -> score = 58.21   (Python onnxruntime, same file: 58.18)
   ```

   No `GatherBlockQuantized`/`MatMulNBits` failure; the tiny 58.21-vs-58.18
   gap is ordinary floating-point non-determinism between C++ and WASM
   kernels, not a correctness issue.

## Bottom line

A WASM-compatible same-model representation was found and **passes** the
fidelity bar: weight-only INT8 (no activation quantization) stays within
~1.8 points of the fp32 source model on average, 7.56 at worst, across the
full riddle benchmark, with 100% binary agreement - closer to the source
model than production's own existing q4/q4f16 WebGPU quantization is.
Verified genuinely loading and running under real browser WASM with
`navigator.gpu` absent.

**Not yet production-ready as a drop-in**, for two reasons, both tracked as
follow-up rather than done here:

- This export's ONNX graph takes `decide_position`/`option_positions` as
  explicit extra inputs, computed client-side. The real kev-0.6b-ONNX
  graph (as open-jev's unmodified `run()`/`F()` code expects) instead
  outputs per-position pointer logits for the *whole* sequence and lets the
  JS side index into it - this candidate would need re-exporting with that
  same output shape to be a true drop-in for open-jev's existing loading
  code without modifying open-jev itself.
- The resulting ~600MB file needs to be hosted somewhere a browser can
  fetch it from. It's too large for this git repo and wasn't published
  anywhere external (Hugging Face Hub, Cloudflare R2, etc.) as part of this
  investigation - that's a hosting decision with its own cost/visibility
  implications, left for explicit sign-off rather than done unilaterally.
