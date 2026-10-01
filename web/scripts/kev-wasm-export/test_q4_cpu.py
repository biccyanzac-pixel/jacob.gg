import time
import numpy as np
import onnxruntime as ort
import torch
from common import load, build_inputs, noul_probability

tokenizer, _ = load()  # just need the tokenizer

prompt = "What can you enter without going in?"
statement = f'Is the answer a plausible interpretation of the riddle "{prompt}" that resolves its apparent contradiction?'
answer = "a keyboard"
input_ids, option_positions, decide_position = build_inputs(tokenizer, answer, statement)

sess = ort.InferenceSession("model_q4.onnx", providers=["CPUExecutionProvider"])

t0 = time.time()
(logits_all,) = sess.run(
    ["logits"],
    {
        "input_ids": np.array([input_ids], dtype=np.int64),
        "attention_mask": np.ones((1, len(input_ids)), dtype=np.int64),
    },
)
ms = (time.time() - t0) * 1000
print(f"inference time: {ms:.0f}ms")
print("logits_all shape:", logits_all.shape)

# Native graph outputs per-position logits [1, seq_len] (or similar) - read
# out the option positions exactly as open-jev's JS does client-side.
flat = logits_all.reshape(-1)
option_logits = torch.tensor([flat[p] for p in option_positions])
p = noul_probability(option_logits)
print(f"q4 CPU (Python onnxruntime): P(yes) = {p:.4f} -> score = {p*100:.2f}")
print("REFERENCE comparisons: fp32(Python)=59.72, production q4f16(real WebGPU)=66.10")
