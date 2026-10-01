"""Full 58-case sweep for fp32, w8 (weight-only int8 WASM candidate), and
native q4 (via Python onnxruntime CPU EP - NOT WebGPU; see report for the
CPU-vs-WebGPU distinction) across every riddle+answer in cases.mjs, using the
exact production Noul statement. Writes results to sweep_results.json for
cross-referencing against the browser-based q4/q4f16 WebGPU sweep.
"""
import json
import re
import time
import numpy as np
import onnxruntime as ort
import torch
from common import load, build_inputs, noul_probability

CASES_PATH = "../web/scripts/riddle-bench/cases.mjs"


def parse_cases_mjs(path):
    text = open(path, encoding="utf-8").read()
    riddles = []
    for block in re.finditer(r'id:\s*"([^"]+)"\s*,\s*prompt:\s*"([^"]+)"\s*,\s*cases:\s*\[(.*?)\]\s*,?\s*\},', text, re.S):
        rid, prompt, cases_block = block.groups()
        cases = []
        for m in re.finditer(r'\{\s*tier:\s*(\d+)\s*,\s*answer:\s*"([^"]*)"', cases_block):
            cases.append({"tier": int(m.group(1)), "answer": m.group(2)})
        riddles.append({"id": rid, "prompt": prompt, "cases": cases})
    return riddles


RIDDLES = parse_cases_mjs(CASES_PATH)
total_cases = sum(len(r["cases"]) for r in RIDDLES)
print(f"parsed {len(RIDDLES)} riddles, {total_cases} cases")

tokenizer, _ = load()

sess_fp32 = ort.InferenceSession("kev06b_fp32.onnx", providers=["CPUExecutionProvider"])
sess_w8 = ort.InferenceSession("kev06b_wasm_w8.onnx", providers=["CPUExecutionProvider"])
sess_q4 = ort.InferenceSession("model_q4.onnx", providers=["CPUExecutionProvider"])

results = []
for riddle in RIDDLES:
    statement = f'Is the answer a plausible interpretation of the riddle "{riddle["prompt"]}" that resolves its apparent contradiction?'
    for c in riddle["cases"]:
        answer = c["answer"]
        input_ids, option_positions, decide_position = build_inputs(tokenizer, answer, statement)
        ids_np = np.array([input_ids], dtype=np.int64)
        mask_np = np.ones((1, len(input_ids)), dtype=np.int64)

        row = {"riddle": riddle["id"], "tier": c["tier"], "answer": answer}

        # fp32 / w8: my custom 4-input wrapper
        for name, sess in [("fp32", sess_fp32), ("w8", sess_w8)]:
            t0 = time.time()
            (logits,) = sess.run(
                ["logits"],
                {
                    "input_ids": ids_np,
                    "attention_mask": mask_np,
                    "decide_position": np.array(decide_position, dtype=np.int64),
                    "option_positions": np.array(option_positions, dtype=np.int64),
                },
            )
            ms = (time.time() - t0) * 1000
            p = noul_probability(torch.tensor(logits))
            row[f"{name}_noul"] = p
            row[f"{name}_score"] = p * 100
            row[f"{name}_ms"] = ms

        # q4 (CPU): native graph, whole-sequence logits, read out client-side
        t0 = time.time()
        (logits_all,) = sess_q4.run(["logits"], {"input_ids": ids_np, "attention_mask": mask_np})
        ms = (time.time() - t0) * 1000
        flat = logits_all.reshape(-1)
        option_logits = torch.tensor([flat[p] for p in option_positions])
        p = noul_probability(option_logits)
        row["q4cpu_noul"] = p
        row["q4cpu_score"] = p * 100
        row["q4cpu_ms"] = ms

        results.append(row)
        print(f"{riddle['id']:<32} t{c['tier']:<2} {answer[:30]:<32} fp32={row['fp32_score']:6.2f} w8={row['w8_score']:6.2f} q4cpu={row['q4cpu_score']:6.2f}")

with open("sweep_results.json", "w") as f:
    json.dump(results, f, indent=2)
print(f"\nwrote {len(results)} rows to sweep_results.json")
