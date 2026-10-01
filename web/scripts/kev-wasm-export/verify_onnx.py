import numpy as np
import onnxruntime as ort
from common import load, build_inputs, noul_probability
import torch

tokenizer, _ = load()  # just for tokenizer; we don't need the torch model here
prompt = "What can you enter without going in?"
statement = f'Is the answer a plausible interpretation of the riddle "{prompt}" that resolves its apparent contradiction?'
answer = "a keyboard"
input_ids, option_positions, decide_position = build_inputs(tokenizer, answer, statement)

sess = ort.InferenceSession("kev06b_fp32.onnx", providers=["CPUExecutionProvider"])
inputs = {
    "input_ids": np.array([input_ids], dtype=np.int64),
    "attention_mask": np.ones((1, len(input_ids)), dtype=np.int64),
    "decide_position": np.array(decide_position, dtype=np.int64),
    "option_positions": np.array(option_positions, dtype=np.int64),
}
(logits,) = sess.run(["logits"], inputs)
print("ONNX fp32 logits:", logits.tolist())
p = noul_probability(torch.tensor(logits))
print(f"ONNX fp32: P(yes) = {p:.4f} -> score = {p*100:.2f}")
print("(PyTorch fp32 reference was: score = 59.72)")
