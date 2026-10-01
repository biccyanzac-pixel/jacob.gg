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

## Bottom line

No WASM-compatible same-model representation was demonstrated to meet the
required quality bar in this investigation. The architecture permits a clean
ONNX export, but the one readily-available WASM-compatible quantization
strategy (ONNX Runtime's dynamic INT8) fails behavioral equivalence by a
wide margin. No production code was changed.
