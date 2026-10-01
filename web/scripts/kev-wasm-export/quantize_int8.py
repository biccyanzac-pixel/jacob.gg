from onnxruntime.quantization import quantize_dynamic, QuantType

print("quantizing (dynamic, int8, standard ops only - no block quantization)...")
quantize_dynamic(
    model_input="kev06b_fp32.onnx",
    model_output="kev06b_int8_perchannel.onnx",
    weight_type=QuantType.QInt8,
    per_channel=True,
)
print("DONE: kev06b_int8.onnx")
