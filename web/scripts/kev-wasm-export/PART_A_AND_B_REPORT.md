# Investigation: historical 91.83/48.24, and exact-q4 WASM (no production change)

No production source, production model assets, or deployed behavior were
touched. Confirmed: `git diff web/src/ worker/src/` is empty throughout this
investigation.

---

## A. Historical 91.83 vs 48.24 - resolved with direct evidence, not inference

**The evidence, found by searching git history for the literal strings "91.83"
and "0.9183":**

`worker/test/production-check.mjs` (committed in `083a022`, "Add production
verification scripts") line 100:

```js
const a2 = await play(today, a.playerId, a.token, "ProdCheckA", "a competition", 0.9183);
```

`play()` (same file, lines 47-70) takes `noul` as a plain parameter and
sends it **directly** in the POST body to `/api/play` - `model: "kev-0.6b/q4"`
is also a **literal hardcoded string** in that function, not read from any
runtime. Nothing in this script loads a tokenizer, a model, or calls
`scoreAnswer()` - it is a raw HTTP test fixture exercising the Worker's own
logic (session issuance, attempt counting, averaging, redaction), not the
judge.

The Worker's own code (`worker/src/index.js`) documents, in its own
comments, that it cannot and does not re-run the model: *"The noul itself
cannot be re-verified without running the model here, which would defeat
the point of free client-side inference."* It only checks internal
consistency (`score == noul * 100`). `0.9183 * 100 = 91.83` passes that
check trivially - the Worker had no way to know, and no mechanism to check,
whether `0.9183` came from a real inference or was typed by hand into a
test script.

**Reproduced** (isolated, local `wrangler dev`, not production - a fresh
local D1 was seeded and `production-check.mjs` was pointed at `127.0.0.1`
instead of the real Worker): running the identical script reproduces a
`ProdCheckA` row with `"a competition"` -> `score: 91.83`, `model: "kev-0.6b/q4"`,
by the identical mechanism - a hardcoded fixture value sent over raw HTTP.

**By contrast**, `48.24` (`noul = 0.48242911338581362...`, 16 significant
digits) is not a round, hand-typeable number. It was independently
reproduced via a real loaded judge in a real browser
(`scripts/repeat-scoring-test.mjs`, 8 repeated real inferences, bit-identical
every time) and matches, to full precision, two separate real players'
("Ada57635", "test") actual production submissions recorded in D1 five
hours apart.

**Conclusion**: `91.83` was never a judge output. It was synthetic test
data for the Worker's averaging/redaction logic, written directly to
production D1 via a verification script, and happened to use "a competition"
as sample text. `48.24` is a genuine, independently-reproduced model score
for that same text. There was never a q4-vs-q4f16 discrepancy to explain -
the two numbers were never produced by the same kind of event. This
supersedes the previous report's "stale code path" explanation, which was
an unproven inference; the actual cause is now demonstrated, not inferred.

**Remaining uncertainty**: none identified for the mechanism itself - the
source code match is exact (same player name, same answer text, same noul
to 4 decimal places, same hardcoded model string) and independently
reproduced in isolation.

---

## B. Exact q4 model through a WASM execution path

**Outcome: a custom ONNX Runtime C++ build was not needed and was not
built.** Investigating further revealed that the capability already exists
in the installed `onnxruntime-web` package - the blocker in the previous
investigation was a bundle-selection issue, not a missing kernel.

### B1/B2: exact setup and operators

- Production model: `onnx-community/kev-0.6b-ONNX`, file `onnx/model_q4.onnx`
  + `model_q4.onnx_data` (the literal file the game fetches - downloaded
  fresh for this investigation, not altered).
- `onnxruntime-web`: `1.31.0-dev.20260914-8d85527a0` (unchanged, as pinned
  in `web/package-lock.json`).
- Graph operators: 1x `GatherBlockQuantized`, 196x `MatMulNBits` (confirmed
  by grep on the graph file), everything else standard ONNX ops.
- CPU kernel dependencies (checked against a sparse clone of
  `microsoft/onnxruntime` at the matching version): both ops' CPU
  implementations (`onnxruntime/contrib_ops/cpu/quantization/
  matmul_nbits.cc`, `gather_block_quantized.cc`) depend only on ONNX
  Runtime's own MLAS math library (`core/mlas/inc/mlas_qnbit.h`,
  `mlas_q4.h`) - a universal, already-WASM-compiled dependency, not
  anything exotic. Kernel registration uses ORT's standard
  `ONNX_OPERATOR_TYPED_KERNEL_CLASS_NAME` macros in
  `contrib_ops/cpu/cpu_contrib_kernels.cc` - no special-case registration
  code. The official WASM CI build scripts
  (`tools/ci_build/github/azure-pipelines/templates/win-wasm-ci.yml`) do
  **not** pass `--disable_contrib_ops` for the plain WASM targets.

### B3: no custom build was built, because none was needed

The environment available for this investigation has **no C/C++ compiler,
no CMake, no Emscripten SDK, and no Visual Studio Build Tools** installed
(checked directly: `which gcc/g++/make/cmake/emcc` all failed; no MSVC
install directory exists). A from-source ONNX Runtime WASM build was not
attempted given this, and given the finding below made it unnecessary.

**What was found instead**: the installed `onnxruntime-web` package ships
*two different compiled WASM artifacts*:

| Subpath/bundle | File | MatMulNBits/GatherBlockQuantized present? |
|---|---|---|
| `onnxruntime-web/wasm` (plain CPU) | `ort-wasm-simd-threaded.wasm` | **yes - genuinely functional**, confirmed by running it |
| `onnxruntime-web/webgpu` (combined GPU+CPU) | `ort-wasm-simd-threaded.asyncify.wasm` | string present, but **not functional** - fails at runtime |

Both binaries contain the literal strings `"MatMulNBits"` and
`"GatherBlockQuantized"` - but that proved to be a red herring: ONNX
Runtime's own "operator not found" error message embeds the op's type name
as text (`"Could not find an implementation for GatherBlockQuantized..."`),
so grepping a binary for the op name cannot distinguish "kernel present" from
"kernel absent but the error message mentions it." Only an actual
load-and-run test resolves this, and the two bundles gave **opposite real
results**:

- `onnxruntime-web/wasm` (plain bundle), loading the real `model_q4.onnx`
  directly, `executionProviders: ["wasm"]`, `navigator.gpu` undefined:
  **succeeded** - session created, inference ran, valid per-position logits
  returned.
- `onnxruntime-web/webgpu` (the combined bundle - confirmed via stack trace
  to be exactly what `open-jev`/`@huggingface/transformers` actually loads,
  even when `device: "wasm"` is explicitly requested), same model, same
  `executionProviders: ["wasm"]`, same no-GPU condition: **failed** with
  the same `GatherBlockQuantized` error documented in the previous
  mobile-compatibility investigation.

This was directly confirmed by calling `OpenJev.load({device: "wasm"})`
and inspecting the resulting stack trace, which showed the failure
originating inside `ort.webgpu.bundle.min.mjs`, loading
`ort-wasm-simd-threaded.asyncify.wasm` from a CDN - not the plain WASM
bundle. The previous investigation's conclusion ("the WASM-only bundle
lacks the kernel") was based on grepping `.mjs` glue files, not the
compiled `.wasm` binaries, and happened to land on a correct-seeming but
incompletely-evidenced answer; this investigation corrects that with an
actual functional test of both binaries.

**No graph change, no requantization, no model substitution was made or
needed** - the exact, byte-identical `model_q4.onnx`/`model_q4.onnx_data`
files were used in both the successful and failing tests.

### B4: proof the exact model runs (plain WASM bundle)

```
onnxruntime-web/wasm (plain bundle) initialises     -> SESSION_LOAD_OK, 3323ms
existing production model_q4.onnx + .onnx_data load -> 1,245,327 + 374,822,912 bytes fetched, no graph edits
inference executes, navigator.gpu undefined         -> INFER_OK, 4281ms
valid output produced                                -> logits shape [1,36], consistent with the real per-position pointer-logit convention
```

(`scripts/kev-wasm-export/q4-wasm-direct-test.mjs` /
`run-q4-wasm-test.mjs`.)

### B5/B6: full 58-case benchmark, exact q4 WebGPU vs exact q4 WASM

Existing FP32/q4-WebGPU/q4f16-WebGPU/W8 results (from the prior
investigation) are **unchanged** and not rerun - see `BENCHMARK.md`. Using
the plain WASM bundle, the exact same `model_q4.onnx`, the same tokenizer,
and the same input-construction logic as `open-jev`'s real `F()` function,
scored against the same 58 cases (`q4-wasm-sweep-runner.mjs` ->
`q4_wasm_results.json`), compared against the already-recorded real-WebGPU
q4 scores for the same cases (`compare_q4_webgpu_vs_wasm.py`):

| | value |
|---|---:|
| mean \|diff\| | **0.00** |
| median \|diff\| | 0.00 |
| max \|diff\| | 0.01 |
| Pearson | 1.000 |
| Spearman | 1.000 |
| binary agreement | **100.0%** |
| binary judgement flips | **0 / 58** |

The largest discrepancies are all 0.01 points (e.g. "Your reputation":
WebGPU 59.33 vs WASM 59.32) - ordinary floating-point rounding noise between
GPU and CPU hardware, not a quantization or execution difference. This is
the exact same model producing, for practical purposes, **identical**
output on two different backends. Raw noul probabilities (not just final
scores) were compared, confirming this is a model-execution-level result,
not a scoring-layer artifact.

### B7: performance/compatibility

| | value |
|---|---:|
| session load (plain WASM bundle) | 3.3s |
| inference per answer (WASM, single-threaded) | mean 5.9s, max 8.6s across 58 real cases |
| memory | not independently profiled |
| SIMD | required - the only plain WASM binary shipped is `ort-wasm-simd-threaded.wasm`; no non-SIMD variant exists in this package. WASM SIMD128 is a modern-browser baseline feature |
| threading | **not required** for correctness - all tests ran with `numThreads: 1` and succeeded; the binary supports threading if enabled (would need COOP/COEP headers, a separate concern) |
| browser/device coverage | tested only on this machine's real GPU/Edge-Chromium, same single-environment limitation as the prior benchmark - no independent confirmation on non-Chromium engines or other hardware; **no claim of universal mobile compatibility is made** |

Inference is markedly slower than WebGPU (mean ~5.9s vs sub-1-3s), as
expected for single-threaded CPU execution of a 0.6B-parameter model - this
is a real, user-facing cost of the WASM path, not a rounding error.

---

## C. Production implications (evidence-based discussion only - not implemented)

If this holds up under further testing (more hardware/browsers, memory
profiling, real mobile devices), the evidence here supports, as an
architecture to *evaluate* rather than ship immediately:

```
kev-0.6b q4 (same ONNX file, unmodified)
          |
   +------+------+
   |             |
 WebGPU         WASM
   |             |
exact q4       exact q4   <- proven: scores agree to within 0.01 points,
                               100% binary agreement, 0 flips, same file
```

This would be a materially different proposal from the earlier W8 fallback
(which did **not** closely match q4/q4f16's actual output - mean diff ~9.8,
per `BENCHMARK.md`). Exact-q4-via-WASM uses the identical model and, per
this investigation, produces statistically indistinguishable scores to the
WebGPU path. The real, unresolved costs before any such change: (1) getting
`open-jev`/`@huggingface/transformers` to load the plain `onnxruntime-web/wasm`
bundle instead of the combined `webgpu` bundle when no GPU is available -
not evaluated here, since this investigation worked around it by calling
the plain bundle directly rather than patching the libraries; (2) the ~4-9s
per-answer inference cost on CPU, acceptable for a once-per-attempt daily
game but real; (3) the single-environment hardware/browser coverage
limitation stated above.

**Not implemented. Not deployed. No production file was changed.**

---

## Files created (all under `web/scripts/kev-wasm-export/`, none elsewhere)

- `PART_A_AND_B_REPORT.md` (this file)
- `q4-wasm-direct-test.mjs` / `.html`, `run-q4-wasm-test.mjs` - B4's direct proof
- `q4-wasm-sweep-runner.mjs`, `q4-wasm-sweep.html`, `run-q4-wasm-sweep.mjs` - B5's 58-case sweep
- `q4_wasm_results.json` - raw sweep output
- `compare_q4_webgpu_vs_wasm.py`, `q4_webgpu_vs_wasm.json` - B6's comparison
- `q4-cross-env-test.mjs`, `sweep-runner.mjs/.html`, `sweep-q4-q4f16.mjs` - carried over from the prior investigation, reused (not modified) to source the q4-WebGPU comparison data
- `wasm-runtime/` - local copies of `ort-wasm-simd-threaded.wasm`/`.mjs` from the already-installed `onnxruntime-web` package (needed for the direct-bundle tests to resolve their WASM binary locally rather than via Vite's dev-dependency optimizer)

Large/temporary artifacts (the ~2.3GB sparse `microsoft/onnxruntime` source
clone used to inspect kernel source and build scripts; the downloaded
~375MB `model_q4.onnx_data`) were deleted after use and are not committed.

**Confirmed**: `git diff --stat web/src/ worker/src/` is empty. No
production source, no production model asset, no deployed behavior was
touched by this investigation.
