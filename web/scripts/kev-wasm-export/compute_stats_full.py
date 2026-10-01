import json
import numpy as np
from scipy import stats as sp

python_rows = json.load(open("sweep_results.json"))
browser_rows = json.load(open("kev-q4-q4f16-results.json"))

# Index browser rows by (riddle, tier, answer) -> {dtype: score}
browser_idx = {}
for r in browser_rows:
    key = (r["riddle"], r["tier"], r["answer"])
    browser_idx.setdefault(key, {})[r["dtype"]] = {"score": r["score"], "noul": r["noul"], "ms": r["ms"]}

merged = []
for r in python_rows:
    key = (r["riddle"], r["tier"], r["answer"])
    b = browser_idx.get(key, {})
    row = dict(r)
    if "q4" in b:
        row["q4webgpu_score"] = b["q4"]["score"]
        row["q4webgpu_ms"] = b["q4"]["ms"]
    if "q4f16" in b:
        row["q4f16webgpu_score"] = b["q4f16"]["score"]
        row["q4f16webgpu_ms"] = b["q4f16"]["ms"]
    merged.append(row)

missing = [r for r in merged if "q4webgpu_score" not in r or "q4f16webgpu_score" not in r]
print(f"merged {len(merged)} rows, {len(missing)} missing a browser match")
for m in missing[:5]:
    print("  missing:", m["riddle"], m["tier"], m["answer"])

json.dump(merged, open("merged_full.json", "w"), indent=2)


def pair_stats(a_key, b_key, label, rows):
    a = np.array([r[a_key] for r in rows])
    b = np.array([r[b_key] for r in rows])
    diffs = np.abs(a - b)
    pearson = sp.pearsonr(a, b)[0]
    spearman = sp.spearmanr(a, b)[0]
    binary_agree = np.mean((a >= 50) == (b >= 50)) * 100
    print(f"\n=== {label} (n={len(rows)}) ===")
    print(f"mean|diff|={diffs.mean():.2f}  median|diff|={np.median(diffs):.2f}  max|diff|={diffs.max():.2f}")
    print(f"pearson={pearson:.3f}  spearman={spearman:.3f}  binary_agreement={binary_agree:.1f}%")


valid = [r for r in merged if "q4webgpu_score" in r and "q4f16webgpu_score" in r]

pair_stats("fp32_score", "w8_score", "W8 vs FP32", valid)
pair_stats("fp32_score", "q4webgpu_score", "q4(real WebGPU) vs FP32", valid)
pair_stats("fp32_score", "q4f16webgpu_score", "q4f16(real WebGPU) vs FP32", valid)
pair_stats("q4webgpu_score", "q4f16webgpu_score", "q4 vs q4f16 (both real WebGPU)", valid)
pair_stats("q4webgpu_score", "w8_score", "q4(real WebGPU) vs W8", valid)
pair_stats("q4f16webgpu_score", "w8_score", "q4f16(real WebGPU) vs W8", valid)
pair_stats("q4webgpu_score", "q4cpu_score", "q4(real WebGPU) vs q4(CPU) - cross-backend check, same quantization", valid)

print("\ninference time (ms):")
for key in ["fp32_ms", "w8_ms", "q4cpu_ms", "q4webgpu_ms", "q4f16webgpu_ms"]:
    vals = [r[key] for r in valid if key in r]
    if vals:
        print(f"  {key}: mean={np.mean(vals):.1f}  max={np.max(vals):.1f}  n={len(vals)}")
