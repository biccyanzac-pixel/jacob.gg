import torch
from common import load, build_inputs, KevForwardHead

tokenizer, model = load()
wrapper = KevForwardHead(model.lm, model.head).eval()

# Fixed example just to get representative shapes for tracing/export.
prompt = "What can you enter without going in?"
statement = f'Is the answer a plausible interpretation of the riddle "{prompt}" that resolves its apparent contradiction?'
answer = "a keyboard"
input_ids, option_positions, decide_position = build_inputs(tokenizer, answer, statement)

ids_t = torch.tensor([input_ids], dtype=torch.long)
mask_t = torch.ones_like(ids_t)
decide_t = torch.tensor(decide_position, dtype=torch.long)
opts_t = torch.tensor(option_positions, dtype=torch.long)

print("exporting to ONNX (fp32, standard ops only)...")
torch.onnx.export(
    wrapper,
    (ids_t, mask_t, decide_t, opts_t),
    "kev06b_fp32.onnx",
    input_names=["input_ids", "attention_mask", "decide_position", "option_positions"],
    output_names=["logits"],
    dynamic_axes={
        "input_ids": {1: "seq_len"},
        "attention_mask": {1: "seq_len"},
        "option_positions": {0: "num_options"},
        "logits": {0: "num_options"},
    },
    opset_version=18,
    dynamo=False,
)
print("DONE: kev06b_fp32.onnx")
