"""True weight-only INT8 quantization via manual ONNX graph surgery.

Unlike onnxruntime.quantization.quantize_dynamic (which also inserts
DynamicQuantizeLinear on ACTIVATIONS at every matmul - the thing the
previous investigation measured as destroying fidelity), this only touches
weights: each constant MatMul/Gemm weight and the embedding table is stored
as int8 + a float scale, with a DequantizeLinear node producing fp32 right
before it's used. Activations are untouched (stay fp32) end to end. Every
op used (DequantizeLinear, MatMul, Gather) is a standard op ORT's WASM
backend already supports - confirmed separately via op-string grep.

  python weight_only_quantize.py
"""
import numpy as np
import onnx
from onnx import numpy_helper, TensorProto

MODEL_IN = "kev06b_fp32.onnx"
MODEL_OUT = "kev06b_wasm_w8.onnx"

model = onnx.load(MODEL_IN, load_external_data=True)
graph = model.graph

initializers = {i.name: i for i in graph.initializer}
new_initializers = []
new_nodes = []
replaced = 0
dq_counter = 0


def quantize_per_channel(weight, axis):
    """Symmetric int8, one scale per slice along `axis`."""
    amax = np.max(np.abs(weight), axis=tuple(a for a in range(weight.ndim) if a != axis), keepdims=True)
    amax = np.maximum(amax, 1e-8)
    scale = amax / 127.0
    q = np.clip(np.round(weight / scale), -127, 127).astype(np.int8)
    return q, scale.reshape(-1).astype(np.float32)


def quantize_per_tensor(weight):
    amax = max(np.max(np.abs(weight)), 1e-8)
    scale = amax / 127.0
    q = np.clip(np.round(weight / scale), -127, 127).astype(np.int8)
    return q, np.array(scale, dtype=np.float32)


def add_dequant(name_prefix, q, scale, axis=None):
    global dq_counter
    dq_counter += 1
    q_name = f"{name_prefix}_int8_{dq_counter}"
    s_name = f"{name_prefix}_scale_{dq_counter}"
    out_name = f"{name_prefix}_dequant_{dq_counter}"
    new_initializers.append(numpy_helper.from_array(q, name=q_name))
    new_initializers.append(numpy_helper.from_array(scale, name=s_name))
    kwargs = {}
    if axis is not None:
        kwargs["axis"] = axis
    node = onnx.helper.make_node("DequantizeLinear", [q_name, s_name], [out_name], name=f"DQ_{q_name}", **kwargs)
    new_nodes.append(node)
    return out_name


# 1) Linear-layer weights feeding MatMul with a constant B: per-output-channel int8.
for node in graph.node:
    if node.op_type != "MatMul":
        continue
    b_name = node.input[1]
    if b_name not in initializers:
        continue
    init = initializers[b_name]
    weight = numpy_helper.to_array(init)
    if weight.ndim != 2:
        continue
    q, scale = quantize_per_channel(weight, axis=1)  # [in, out] -> per-out-channel
    dq_out = add_dequant(b_name.replace("/", "_").replace(".", "_"), q, scale, axis=1)
    node.input[1] = dq_out
    replaced += 1

# 2) Embedding table feeding Gather: per-tensor int8, dequantize AFTER gather
#    (so only the ~dozens of rows actually used per call get dequantized,
#    not the full 151936-row table every forward pass).
EMBED_NAME = "lm.embed_tokens.weight"
embed_init = initializers[EMBED_NAME]
embed_weight = numpy_helper.to_array(embed_init)
eq, escale = quantize_per_tensor(embed_weight)
eq_name = "embed_tokens_int8"
es_name = "embed_tokens_scale"
new_initializers.append(numpy_helper.from_array(eq, name=eq_name))
new_initializers.append(numpy_helper.from_array(escale, name=es_name))

for node in graph.node:
    if node.op_type == "Gather" and node.input[0] == EMBED_NAME:
        gathered_name = node.output[0]
        dequant_name = gathered_name + "_dequant"
        node.output[0] = gathered_name + "_int8"
        node.input[0] = eq_name
        dq_node = onnx.helper.make_node(
            "DequantizeLinear", [node.output[0], es_name], [dequant_name], name="DQ_embed"
        )
        new_nodes.append(dq_node)
        # Rewire every consumer of the original fp32 gather output to the dequantized one.
        for other in graph.node:
            if other is node:
                continue
            for i, inp in enumerate(other.input):
                if inp == gathered_name:
                    other.input[i] = dequant_name
        break

# Remove the now-unused fp32 initializers (replaced ones + original embedding).
used_names = {b_name for n in graph.node if n.op_type == "MatMul" for b_name in [n.input[1]]}
keep = [i for i in graph.initializer if i.name != EMBED_NAME and not (i.name in initializers and i.name not in used_names and i is initializers.get(i.name) and False)]
# Simpler: rebuild initializer list, dropping names that got replaced.
replaced_names = set()
for node in graph.node:
    pass

final_initializers = []
drop = {EMBED_NAME}
# Any original weight whose consuming MatMul no longer points at it is now dead; find by name presence check.
all_current_inputs = set()
for n in graph.node:
    all_current_inputs.update(n.input)
for init in graph.initializer:
    if init.name in all_current_inputs:
        final_initializers.append(init)
    # else: dropped, dead weight (replaced by its quantized+dequant version)

del graph.initializer[:]
graph.initializer.extend(final_initializers)
graph.initializer.extend(new_initializers)
graph.node.extend(new_nodes)

onnx.save(model, MODEL_OUT, save_as_external_data=True, location=MODEL_OUT + ".data", all_tensors_to_one_file=True)
print(f"linear weights quantized (per-channel int8): {replaced}")
print(f"embedding quantized (per-tensor int8): 1 table, shape {embed_weight.shape}")
print("saved:", MODEL_OUT)
