# kev-0.6b representation benchmark (investigation only, no production change)

All numbers below come from actually-executed tests in this repo's scripts
(`sweep_all_python.py`, `sweep-q4-q4f16.mjs` + `sweep-runner.mjs`,
`q4-cross-env-test.mjs`, `formatting-test.mjs`, `test_q4_cpu.py`), not
estimates. Raw per-case data is in `sweep_results.json` (fp32/w8/q4-CPU) and
`merged_full.json` (all five representations merged). All 58 cases in
`web/scripts/riddle-bench/cases.mjs` (5 riddles, every tier 1-10) were used
for every representation - no test-set switching between comparisons.

## A. Model comparison

| Representation | Backend | Size | Mean \|diff\| vs FP32 | Max \|diff\| vs FP32 | Pearson | Spearman | Binary agreement |
|---|---|---:|---:|---:|---:|---:|---:|
| FP32 | CPU (Python onnxruntime) | 2.3 GB | 0 | 0 | 1.000 | 1.000 | 100% |
| q4 | **real WebGPU**, browser | ~323 MB | 9.48 | 40.76 | 0.859 | 0.898 | 86.2% |
| q4f16 | **real WebGPU**, browser | ~348 MB | 9.61 | 39.92 | 0.856 | 0.895 | 86.2% |
| W8 (weight-only int8) | **real WASM**, browser | 599 MB | 1.80 | 7.56 | 0.994 | 0.992 | 100% |

FP32 here is a reference point for numerical fidelity to the un-quantized
weights, not an assumed "correct" judge - the game has never run fp32, and
production's own quality was tuned against q4/q4f16.

### q4-specific comparisons

| Pair | Backend(s) | Mean \|diff\| | Max \|diff\| | Pearson | Spearman | Binary agreement | Rank-order agreement |
|---|---|---:|---:|---:|---:|---:|---:|
| q4 vs q4f16 | both real WebGPU | **0.61** | 3.04 | 0.999 | 0.999 | 100% | - |
| q4 vs W8 | WebGPU vs WASM | 9.76 | 42.26 | 0.849 | 0.887 | 86.2% | - |
| q4f16 vs W8 | WebGPU vs WASM | 9.89 | 41.42 | 0.844 | 0.883 | 86.2% | - |
| W8 vs fp32 | WASM vs CPU | 1.80 | 7.56 | 0.994 | 0.992 | 100% | 97.4% (304/312 pairs) |
| q4(WebGPU) vs fp32 | WebGPU vs CPU | 9.48 | 40.76 | 0.859 | 0.898 | 86.2% | 87.5% (273/312 pairs, via q4-CPU proxy) |

**q4 and q4f16 are nearly identical to each other** (mean 0.61, 100% binary
agreement) across the full benchmark. This directly contradicts drawing any
conclusion from the single earlier "a competition" observation (91.83 vs
48.24, a 43-point gap) - re-running that exact case here gives q4=54.50,
q4f16=51.46 (diff 3.04, consistent with the rest of the benchmark). The
original 91.83 reading was an outlier specific to that one session, not
representative of a systematic q4-vs-q4f16 difference; it most likely came
from a different, older code path (that submission's stored `model` string
used the short unresolved alias `"kev-0.6b/q4"`, a format no longer produced
by the current code, pointing to a stale pre-refactor bundle rather than a
clean same-code comparison).

**W8 is meaningfully closer to the unquantized model than q4/q4f16 are.**
Both q4 and q4f16 diverge from fp32 by roughly 5x more (mean ~9.5 vs 1.80)
than W8 does. This is the expected direction for 4-bit vs 8-bit weight
quantization, but the size of the gap (max diffs over 40 points, 86.2%
binary agreement - i.e. ~14% of cases flip which side of 50 they land on)
is larger than might be assumed from quantization alone being "a few points
of noise." **W8 and q4/q4f16 do not currently produce equivalent scores for
the same input** - a player on q4/q4f16 (WebGPU) and a player on W8 (WASM)
would not be getting comparable numbers today.

No overall "winner" is declared: q4/q4f16 are what the game has actually
been scored and tuned against; W8 is numerically more faithful to the
unquantized weights but has never been the judge players experienced.
"Closer to fp32" and "the right representation for this game" are not
proven to be the same thing.

## B. Cross-hardware q4

**Environments tested**: only one real GPU is available in this
environment - an integrated Intel Gen-9 GPU on this Windows dev machine (no
discrete GPU, no second machine, no physical mobile device). On that one
GPU, two genuinely different browser *binaries* were tested: Microsoft Edge
and Google Chrome (both Chromium-family - not an independent engine like
Firefox/Gecko or Safari/WebKit, neither of which is installed here).
Firefox and Safari/WebKit, and any non-Chromium-family engine, are
**unverified** - this is a real coverage gap, stated plainly rather than
glossed over.

The "shader-f16 unavailable" condition was **simulated**, not run on
different real hardware: a Proxy wraps the real `GPUAdapter` so
`.features.has("shader-f16")` reports `false` while `requestDevice()` and
all actual compute still goes to the real adapter/GPU. This tests how the
code *reacts* to that capability signal, not a different physical GPU.

| Condition | Browser | Explicit q4 noul (full precision) | 5x repeat max-min |
|---|---|---|---:|
| real adapter | Edge | 0.496742533042 | 0.00000 |
| real adapter | Chrome | 0.496742533042 | 0.00000 |
| shader-f16 hidden (simulated) | Edge | 0.496742533042 | 0.00000 |

Edge and Chrome, and the real-vs-simulated-f16 conditions, all produced
**bit-identical** results to full available precision. `dtype:"auto"` under
the simulated condition correctly fell back to `q4` (confirmed via
`jev.runtime.dtype`), while explicit `dtype:"q4"` was unaffected by the
simulated capability change either way - consistent with reading the exact
`open-jev` source (section C below): dtype resolution only consults
`shader-f16` when `dtype` is `"auto"`.

> **Is explicit q4 sufficiently consistent to be a universal canonical
> WebGPU representation?** Within the one real hardware environment
> available here: **yes** - perfectly deterministic, and provably
> independent of shader-f16 support, across two different real browser
> binaries. This has **not** been verified across genuinely different GPU
> vendors/architectures (AMD, Nvidia, Apple Silicon, mobile Adreno/Mali) or
> non-Chromium browser engines - those remain open questions this
> environment cannot answer.

## C. dtype:auto

Exact logic, read directly from the installed `open-jev` source
(`node_modules/open-jev/dist/index.js`):

```js
function A(t, e) {
  let n = t.device ?? "auto", o = t.dtype ?? "auto", s;
  n !== "auto" ? s = n : z() ? s = "webgpu" : ne() ? s = "cpu" : s = "wasm";
  let r;
  return o !== "auto" ? r = o : s === "webgpu" && await oe() ? r = e : r = "q4", { device: s, dtype: r };
}
```

- `device`: explicit if given; else `"webgpu"` if `navigator.gpu` exists;
  else `"cpu"` (Node) or `"wasm"` (browser without `navigator.gpu`).
- `dtype`: explicit if given; else, **only if** `device` resolved to
  `"webgpu"` **and** the adapter reports the `"shader-f16"` feature, use the
  model family's preferred dtype (`q4f16` for `kev`); **otherwise `q4`**.

Confirmed live: this machine's real GPU reports `shader-f16`, so
`dtype:"auto"` resolves to `q4f16` here. With that feature hidden
(simulated), `auto` correctly resolves to `q4` instead.

**Why this matters, re-sized by the Part A data**: different players'
devices silently landing on `q4` vs `q4f16` is real, but per the full
benchmark it is a *small* source of score variance between players (mean
0.61, max 3.04) - not the large one. The larger, more consequential gap is
between *either* native quantization and the unquantized reference (mean
~9.5), which `dtype:"auto"` does not affect at all (every path still ends
up at a 4-bit-weight representation, q4 or q4f16).

## D. CPU/WASM feasibility

- **Can kev-0.6b run on CPU/WASM at all?** Yes, in two different ways,
  both confirmed by direct execution: (1) the W8 weight-only INT8 export
  from the previous investigation, genuinely running under
  `onnxruntime-web`'s real WASM execution provider in a browser; (2) the
  **native, unmodified q4 ONNX graph** (the actual production file,
  `GatherBlockQuantized` + `MatMulNBits` and all) loads and runs
  **successfully on Python's `onnxruntime` CPU execution provider** -
  confirmed by `test_q4_cpu.py`: session load 3.9s, inference 313-434ms,
  producing a sensible score (65.82 for the "a keyboard" sanity case,
  between the fp32 reference of 59.72 and production's real WebGPU q4f16
  reading of 66.10 for the same input).

- **How faithful is W8 to q4?** Not very - see section A: mean diff 9.76,
  max 42.26, 86.2% binary agreement. W8 is a good proxy for the *unquantized*
  model, not for q4's specific output.

- **Could exact q4 be made WASM-compatible?** The CPU-EP test above is the
  key finding: `GatherBlockQuantized`/`MatMulNBits` **already have working
  CPU kernel implementations in upstream ONNX Runtime** (proven by running
  them, not inferred). The actual blocker is narrower than "these ops can't
  run on CPU" - it's that **`onnxruntime-web`'s published WASM-only build
  artifacts don't include those kernels**. Checked directly across every
  bundle variant shipped in the installed `onnxruntime-web` package: the
  plain WASM bundles (`ort.wasm.mjs`, `ort.wasm.bundle.min.mjs`,
  `ort-wasm-simd-threaded.mjs`) contain **zero** references to either op;
  the WebGPU/all bundles contain several. This is a WASM-build-configuration
  gap in the published package, not an algorithmic impossibility.
  `@huggingface/transformers` itself imposes no additional constraint here -
  it treats `"q4"` purely as a filename convention for which `.onnx` file to
  fetch and defers entirely to `onnxruntime-web` for what that file's
  operators require.

- **What would it require?** Either (a) upstream changes to
  `microsoft/onnxruntime`'s WASM build configuration to include these CPU
  kernels in the published artifact (a public open-source project; not
  something this project controls or can time), or (b) compiling a custom
  `onnxruntime-web` WASM binary from source with those kernels enabled,
  which means standing up the ONNX Runtime C++/Emscripten build toolchain -
  a real one-time infrastructure investment, not a JS-level patch.
  **Engineering assessment: 3 - substantial engineering.** Not impractical
  (the kernel code demonstrably exists and works; this is a build/packaging
  problem, not a research problem), but it requires a native build pipeline
  this project does not currently have, and validating a custom WASM binary
  (correctness, binary size, performance) is real work beyond "flip a flag."

- **Approximate cost, if pursued**: the resulting WASM artifact would be
  close to q4's existing WebGPU download size (~323MB), since the weights
  don't change - only the execution path does. Native q4 inference on CPU
  here took 313-434ms per answer (Python), suggesting WASM CPU inference
  (always slower than native CPU, typically by a small constant factor)
  would likely still land in a game-practical range, but this was not
  measured in actual WASM (that binary doesn't exist yet - this is the
  specific engineering output a custom build would produce).

## E. Formatting normalization

All rows scored in one loaded session (`device: webgpu, dtype: q4f16` on
this machine's auto-selection), same riddle (*"What can you enter without
going in?"*), same statement, via `formatting-test.mjs`.

| Group | Variant | Score |
|---|---|---:|
| capitalization | `a competition` | 48.24 |
| | `A competition` | 51.46 |
| | `A COMPETITION` | 45.33 |
| | **max-min** | **6.14** |
| whitespace | `a competition` | 48.24 |
| | `  a competition` (leading/trailing) | 39.89 |
| | `a   competition` (internal run) | 59.64 |
| | `a\tcompetition` (tab) | 45.13 |
| | **max-min** | **19.76** |
| punctuation | `a competition` | 48.24 |
| | `a competition.` | 28.62 |
| | `a competition!` | 19.07 |
| | `a competition?` | 21.73 |
| | `"a competition"` | 6.73 |
| | `(a competition)` | 14.56 |
| | **max-min** | **41.51** |

### Articles (explicitly NOT normalized - for comparison only)

| Variant | Score |
|---|---:|
| `exit` | 40.36 |
| `an exit` | **70.98** |
| `Exit` | 44.84 |
| `exit.` | 46.20 |
| `an exit.` | 62.43 |
| `competition` | 37.48 |
| `a competition` | 48.24 |
| `Competition` | 35.58 |
| `competition.` | 50.10 |
| `a competition.` | 28.62 |

`exit` vs `an exit`: **30.6-point swing**. `competition` vs `a competition`:
**10.8-point swing**. Both are large - comparable to or larger than the
punctuation swings above - but per the task's explicit instruction these
are genuine wording differences (the presence of an article), not
formatting, and are **not** being proposed for normalization here. Worth
being honest about: magnitude alone does not cleanly separate "cosmetic"
sensitivity from "wording" sensitivity - this model is simply quite
sensitive to short-answer phrasing in general. That is a separate,
unresolved question from what this section recommends.

**Conclusion**: the evidence supports normalizing capitalization, leading/
trailing/internal whitespace, and wrapping/trailing punctuation before
judging - these are differences with no semantic content that nonetheless
move the score by 6-41 points, which looks like model sensitivity to
irrelevant surface form rather than a meaningful signal. No normalization
beyond that (no articles, no synonyms, no spelling) is supported by this
data, consistent with the instruction not to collapse semantic wording yet.

## F. Existing duplicate-answer normalization vs. judge canonicalization

`shared/normalize.js`'s `normalizeAnswer()` (used for duplicate detection):
NFKC, zero-width-character/BOM stripping, CRLF→LF, horizontal-whitespace
collapsing, trim, lowercase, re-NFKC. Explicitly documented as leaving
"punctuation, wording, emoji and word order" alone.

This is **narrower** than what section E's data would support for judge-
input canonicalization: duplicate detection already handles case and
whitespace, but **not punctuation** - `"a competition"` and
`"a competition."` are different `normalized_answer` values today (not
treated as duplicates), even though section E shows they produce
meaningfully different scores (48.24 vs 28.62) purely from a trailing
period. These solve different problems, as the task specifies: duplicate
detection decides whether a second attempt is allowed at all; judge
canonicalization would decide what text the model actually sees. They
should not be assumed to use the same function just because both currently
overlap on case/whitespace - if judge canonicalization is implemented
later, it should extend to punctuation deliberately, not by reusing
`normalizeAnswer()` unchanged.

## G. Recommended next step

No production change is justified by this investigation alone - it was
explicitly scoped as benchmark-only, and nothing here should be read as
authorizing one. For when that decision is made, what the evidence actually
supports:

- **Standardizing on explicit `dtype:"q4"`** (replacing `"auto"`) would
  remove the real-but-small q4-vs-q4f16 cross-device axis of variance (mean
  0.61) and is provably deterministic and shader-f16-independent on the one
  real environment tested. It would **not** fix - and is not intended to fix
  - the larger quantization-vs-unquantized gap, which is not a fairness
  problem on its own (every player would still be on the same
  representation).
- **Introducing W8 as a same-model WASM fallback** is not yet justified as
  a drop-in: W8 and q4/q4f16 do not currently agree closely enough with each
  other (mean 9.76-9.89) for a WebGPU player and a WASM player to be getting
  comparable scores - that would need to be an explicit, acknowledged
  trade-off (a genuinely different but internally-consistent WASM scoring
  path), not an assumption that W8 "is" the same judge as q4.
- **Making exact q4 WASM-compatible** is the only path to literally "one
  representation, usable by everyone" and is assessed as substantial-but-
  not-impractical engineering (a native ONNX Runtime WASM build with the
  existing CPU kernels enabled), not a quick fix.

The smallest technically justified next step, if and when a production
change is wanted, is standardizing the existing WebGPU path on explicit
`dtype:"q4"` - it is a one-line, zero-risk change relative to what's already
shipping (same model, same backend, removes a real but minor axis of
inconsistency) - while treating "WASM support for everyone" as a separate,
larger decision between (2) an acknowledged-different W8 fallback or (3) the
substantial-engineering path to a WASM-compatible exact q4, not something
this benchmark alone resolves.
