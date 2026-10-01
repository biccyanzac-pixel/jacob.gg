import sys
import numpy as np
import onnxruntime as ort
import torch
from common import load, build_inputs, noul_probability

sys.path.insert(0, "../web/scripts/riddle-bench")

tokenizer, _ = load()

RIDDLES = [
    {
        "prompt": "What can you enter without going in?",
        "cases": [
            (1, "A competition"), (1, "A race"), (2, "A conversation"), (2, "A password"),
            (3, "A raffle"), (4, "A dream"), (5, "A trance"), (6, "Something abstract"),
            (7, "A room"), (7, "A building"), (8, "You enter without going in by entering it"),
            (9, "A sandwich"), (10, "Purple elephant toaster"), (10, "asdkjfh qwoeiru"),
        ],
    },
    {
        "prompt": "What can be behind you before you've passed it?",
        "cases": [
            (1, "Your reputation"), (2, "A rumor about you"), (2, "Your past mistakes"),
            (3, "A deadline you already missed"), (4, "The sunset"),
            (5, "Your shadow at the right time of day"), (6, "Time"),
            (7, "A person standing behind you in a queue"),
            (8, "Something behind me before I pass it"), (9, "A sandwich"),
            (10, "Banana telephone quantum"),
        ],
    },
    {
        "prompt": "What can become more true when you stop believing it?",
        "cases": [
            (1, "That you don't need it"), (2, "Your independence"),
            (3, "A superstition losing its power over you"), (4, "That you've moved on"),
            (5, "Doubt itself"), (6, "A feeling"), (7, "A fact"),
            (8, "Believing it more true when you stop believing"), (9, "A sandwich"),
            (10, "Glorble wafflecopter nine"),
        ],
    },
    {
        "prompt": "What can you leave without going anywhere?",
        "cases": [
            (1, "A voicemail"), (1, "A message"), (2, "An impression"), (2, "A note"),
            (3, "A legacy"), (4, "A job, by quitting in your head"),
            (5, "A relationship, emotionally"), (6, "Something behind"), (7, "Your house"),
            (8, "Leaving without going anywhere at all"), (9, "A sandwich"),
            (10, "Xylophone quantum soup"),
        ],
    },
    {
        "prompt": "What can be found only after it is lost?",
        "cases": [
            (1, "Your voice, in a crowd"), (2, "Peace of mind"), (2, "Gratitude"),
            (3, "A sense of home"), (4, "Your appetite, after being sick"), (5, "Confidence"),
            (6, "Something important"), (7, "Your keys"), (8, "Found only after it is lost, which is lost"),
            (9, "A sandwich"), (10, "Marmalade dinosaur printer"),
        ],
    },
]

sess_fp32 = ort.InferenceSession("kev06b_fp32.onnx", providers=["CPUExecutionProvider"])
sess_w8 = ort.InferenceSession("kev06b_wasm_w8.onnx", providers=["CPUExecutionProvider"])


def run(sess, answer, statement):
    input_ids, option_positions, decide_position = build_inputs(tokenizer, answer, statement)
    inputs = {
        "input_ids": np.array([input_ids], dtype=np.int64),
        "attention_mask": np.ones((1, len(input_ids)), dtype=np.int64),
        "decide_position": np.array(decide_position, dtype=np.int64),
        "option_positions": np.array(option_positions, dtype=np.int64),
    }
    (logits,) = sess.run(["logits"], inputs)
    return noul_probability(torch.tensor(logits))


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
    return num / (dt * ds) ** 0.5 if dt and ds else None


all_diffs = []
all_fp32, all_w8, all_tiers = [], [], []
for riddle in RIDDLES:
    statement = f'Is the answer a plausible interpretation of the riddle "{riddle["prompt"]}" that resolves its apparent contradiction?'
    tiers, fp32s, w8s = [], [], []
    for tier, answer in riddle["cases"]:
        p32 = run(sess_fp32, answer, statement) * 100
        p8 = run(sess_w8, answer, statement) * 100
        all_diffs.append(abs(p8 - p32))
        tiers.append(tier); fp32s.append(p32); w8s.append(p8)
        all_tiers.append(tier); all_fp32.append(p32); all_w8.append(p8)
    c32 = spearman(tiers, fp32s)
    c8 = spearman(tiers, w8s)
    print(f"{riddle['prompt'][:50]:<52} corr(fp32)={c32:.2f}  corr(w8)={c8:.2f}  max|diff|={max(abs(a-b) for a,b in zip(fp32s,w8s)):.2f}")

print(f"\nOVERALL: max|diff|={max(all_diffs):.2f}  mean|diff|={sum(all_diffs)/len(all_diffs):.2f}")
print(f"overall corr(tier,fp32)={spearman(all_tiers, all_fp32):.2f}")
print(f"overall corr(tier,w8)  ={spearman(all_tiers, all_w8):.2f}")
agree = sum(1 for a, b in zip(all_fp32, all_w8) if (a >= 50) == (b >= 50))
print(f"binary (>=50) agreement: {agree}/{len(all_fp32)}")
