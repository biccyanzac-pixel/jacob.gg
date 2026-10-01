import torch
from common import load, build_inputs, noul_probability, KevForwardHead

tokenizer, model = load()
wrapper = KevForwardHead(model.lm, model.head).eval()

prompt = "What can you enter without going in?"
statement = f'Is the answer a plausible interpretation of the riddle "{prompt}" that resolves its apparent contradiction?'
answer = "a keyboard"

input_ids, option_positions, decide_position = build_inputs(tokenizer, answer, statement)
print("seq len:", len(input_ids))

ids_t = torch.tensor([input_ids], dtype=torch.long)
mask_t = torch.ones_like(ids_t)

with torch.no_grad():
    logits = wrapper(ids_t, mask_t, decide_position, option_positions)
p = noul_probability(logits)
print("logits:", logits.tolist())
print(f"P(yes) = {p:.4f}  ->  score = {p*100:.2f}")
print("PRODUCTION (real WebGPU judge, same statement/answer) reported: score = 66.10")
