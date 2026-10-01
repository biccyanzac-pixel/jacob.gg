import numpy as np
import onnxruntime as ort
import torch
from common import load, build_inputs, noul_probability

tokenizer, _ = load()

prompt = "What can you enter without going in?"
statement = f'Is the answer a plausible interpretation of the riddle "{prompt}" that resolves its apparent contradiction?'

# A spread of tiers from cases.mjs for this riddle, same wording as the JS benchmark.
cases = [
    (1, "A competition"),
    (1, "A race"),
    (2, "A conversation"),
    (2, "A password"),
    (3, "A raffle"),
    (4, "A dream"),
    (5, "A trance"),
    (6, "Something abstract"),
    (7, "A room"),
    (7, "A building"),
    (8, "You enter without going in by entering it"),
    (9, "A sandwich"),
    (10, "Purple elephant toaster"),
    (10, "asdkjfh qwoeiru"),
]

sess_fp32 = ort.InferenceSession("kev06b_fp32.onnx", providers=["CPUExecutionProvider"])
sess_int8 = ort.InferenceSession("kev06b_int8.onnx", providers=["CPUExecutionProvider"])


def run(sess, answer):
    input_ids, option_positions, decide_position = build_inputs(tokenizer, answer, statement)
    inputs = {
        "input_ids": np.array([input_ids], dtype=np.int64),
        "attention_mask": np.ones((1, len(input_ids)), dtype=np.int64),
        "decide_position": np.array(decide_position, dtype=np.int64),
        "option_positions": np.array(option_positions, dtype=np.int64),
    }
    (logits,) = sess.run(["logits"], inputs)
    return noul_probability(torch.tensor(logits))


print(f"{'tier':<5}{'answer':<46}{'fp32':>8}{'int8':>8}{'diff':>8}")
diffs = []
fp32_scores, int8_scores, tiers = [], [], []
for tier, answer in cases:
    p32 = run(sess_fp32, answer) * 100
    p8 = run(sess_int8, answer) * 100
    d = p8 - p32
    diffs.append(abs(d))
    fp32_scores.append(p32)
    int8_scores.append(p8)
    tiers.append(tier)
    print(f"{tier:<5}{answer[:44]:<46}{p32:>8.2f}{p8:>8.2f}{d:>8.2f}")

print(f"\nmax |diff| = {max(diffs):.2f}  mean |diff| = {sum(diffs)/len(diffs):.2f}")


def spearman(tiers, scores):
    def rank(values):
        order = sorted(range(len(values)), key=lambda i: values[i])
        ranks = [0.0] * len(values)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                ranks[order[k]] = avg
            i = j + 1
        return ranks

    rt = rank(tiers)
    rs = rank([-s for s in scores])
    n = len(tiers)
    mr = (n + 1) / 2
    num = sum((rt[i] - mr) * (rs[i] - mr) for i in range(n))
    dt = sum((rt[i] - mr) ** 2 for i in range(n))
    ds = sum((rs[i] - mr) ** 2 for i in range(n))
    return num / (dt * ds) ** 0.5


print(f"corr(tier, fp32) = {spearman(tiers, fp32_scores):.2f}")
print(f"corr(tier, int8) = {spearman(tiers, int8_scores):.2f}")

argmax_fp32 = [p >= 50 for p in fp32_scores]
argmax_int8 = [p >= 50 for p in int8_scores]
agree = sum(1 for a, b in zip(argmax_fp32, argmax_int8) if a == b)
print(f"binary (>=50) agreement: {agree}/{len(cases)}")
