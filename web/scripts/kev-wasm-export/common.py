"""Shared loading + encode/decode logic mirroring open-jev's "kev" family
exactly (node_modules/open-jev/dist/index.js: function F, function te, class
PointerHead usage), re-implemented in Python against the real checkpoint
loaded via the official kev library (same weights production uses)."""
from dataclasses import replace
import math
import torch
from huggingface_hub import snapshot_download
from kev.checkpoint import Checkpoint, LoadOptions

DELIMS = {
    "state": "<|fim_prefix|>",
    "question": "<|fim_middle|>",
    "option_start": "<|box_start|>",
    "option_end": "<|box_end|>",
    "decide": "<|fim_suffix|>",
}
OPTIONS = ["no", "yes"]  # open-jev's noul() options, in this fixed order


def load():
    checkpoint_path = snapshot_download("jaredpalmer/kev-0.6b")
    base_path = snapshot_download("Qwen/Qwen3-0.6B-Base")
    loader = Checkpoint(checkpoint_path)
    loader.meta = replace(loader.meta, base=base_path, base_revision=None)
    tokenizer, model = loader.load("cpu", LoadOptions())
    model.eval()
    return tokenizer, model


def marker_id(tokenizer, text):
    ids = tokenizer(text, add_special_tokens=False)["input_ids"]
    assert len(ids) == 1, f"{text!r} is not a single token: {ids}"
    return ids[0]


def tok(tokenizer, text):
    return tokenizer(text, add_special_tokens=False)["input_ids"]


def build_inputs(tokenizer, state_text, instructions_text, max_state_tokens=8192, max_length=8192):
    """Mirrors open-jev's F() exactly: one branch (one question), options = ["no","yes"]."""
    markers = {k: marker_id(tokenizer, v) for k, v in DELIMS.items()}
    instr_ids = tok(tokenizer, instructions_text)
    branch = [markers["question"], *instr_ids]
    ends = []
    for opt in OPTIONS:
        opt_ids = tok(tokenizer, opt)
        branch.append(markers["option_start"])
        branch.extend(opt_ids)
        branch.append(markers["option_end"])
        ends.append(len(branch) - 1)  # index of this option's closing marker
    branch.append(markers["decide"])

    state_ids = tok(tokenizer, state_text)
    c = max_length - 1 - len(branch)
    u = min(max_state_tokens, c)
    state_ids = state_ids[:u]

    input_ids = [markers["state"], *state_ids]
    base = len(input_ids)
    input_ids.extend(branch)
    option_positions = [base + e for e in ends]
    decide_position = len(input_ids) - 1  # decide marker is the last token
    return input_ids, option_positions, decide_position


def noul_probability(logits_2):
    """Mirrors open-jev's softmax + Z(): P(yes)."""
    probs = torch.softmax(logits_2, dim=-1)
    return probs[OPTIONS.index("yes")].item()


class KevForwardHead(torch.nn.Module):
    """Standard Qwen3Model forward (unmodified HF code - no custom attention
    reimplementation needed) + the real PointerHead, reading out the decide
    and option positions by plain indexing. Mathematically identical to what
    production does; this is just the minimal module needed to compute one
    Noul decision end to end."""

    def __init__(self, lm, head):
        super().__init__()
        self.lm = lm
        self.head = head

    def forward(self, input_ids, attention_mask, decide_position, option_positions):
        out = self.lm(input_ids=input_ids, attention_mask=attention_mask)
        hidden = out.last_hidden_state[0]  # [seq, d]
        h_decide = hidden[decide_position]
        h_opts = hidden[option_positions]
        logits = self.head(h_decide, h_opts)
        return logits
