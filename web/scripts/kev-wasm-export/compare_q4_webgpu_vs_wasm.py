import json
import numpy as np
from scipy import stats as sp

webgpu_rows = {}
merged = json.load(open("merged_full.json"))
for r in merged:
    webgpu_rows[(r["riddle"], r["tier"], r["answer"])] = r["q4webgpu_score"]

wasm_rows = json.load(open("q4_wasm_results.json"))

pairs = []
for r in wasm_rows:
    key = (r["riddle"], r["tier"], r["answer"])
    if key in webgpu_rows:
        pairs.append({"riddle": r["riddle"], "tier": r["tier"], "answer": r["answer"],
                      "wasm_score": r["score"], "webgpu_score": webgpu_rows[key], "wasm_ms": r["ms"]})

print(f"matched {len(pairs)}/{len(wasm_rows)} cases")

a = np.array([p["webgpu_score"] for p in pairs])
b = np.array([p["wasm_score"] for p in pairs])
diffs = np.abs(a - b)
pearson = sp.pearsonr(a, b)[0]
spearman = sp.spearmanr(a, b)[0]
binary_agree = np.mean((a >= 50) == (b >= 50)) * 100
flips = [(p, da, db) for p, da, db in zip(pairs, a, b) if (da >= 50) != (db >= 50)]

print(f"\nmean|diff|={diffs.mean():.2f}  median|diff|={np.median(diffs):.2f}  max|diff|={diffs.max():.2f}")
print(f"pearson={pearson:.3f}  spearman={spearman:.3f}  binary_agreement={binary_agree:.1f}%")
print(f"binary judgement flips: {len(flips)}/{len(pairs)}")

worst = sorted(zip(diffs, pairs), key=lambda x: -x[0])[:5]
print("\nworst 5 discrepancies:")
for d, p in worst:
    print(f"  {p['riddle']} t{p['tier']} '{p['answer'][:35]}'  webgpu={p['webgpu_score']:.2f}  wasm={p['wasm_score']:.2f}  diff={d:.2f}")

if flips:
    print("\nbinary flips:")
    for p, da, db in flips:
        print(f"  {p['riddle']} t{p['tier']} '{p['answer'][:35]}'  webgpu={da:.2f}  wasm={db:.2f}")

print(f"\nwasm inference time: mean={np.mean([p['wasm_ms'] for p in pairs]):.0f}ms  max={np.max([p['wasm_ms'] for p in pairs]):.0f}ms")

json.dump(pairs, open("q4_webgpu_vs_wasm.json", "w"), indent=2)
