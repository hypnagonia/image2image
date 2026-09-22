"""Prepare Swin2SR lightweight ×2 for the browser (the optional 2× upscale stage).

Source: Xenova/swin2SR-lightweight-x2-64 (ONNX export of caidas/swin2SR-lightweight-x2-64,
Apache-2.0). Input RGB in [0, 1], NCHW; output ×2.

The published graph has dynamic shapes: ~19 000 nodes, most of them shape
bookkeeping (Shape/Gather/ScatterND) that ONNX Runtime Web would run on the
CPU for every tile. The app always feeds 256×256 tiles, so the input shape is
fixed and the graph constant-folded (onnxslim) → ~1 950 nodes. Folding
materialises the shifted-window attention mask once per layer (12 identical
[1024, 1, 64, 64] fp32 tensors, 200 MB); they are deduplicated into a single
fp16 initializer (values are exactly 0 / −100) with one Cast → 15 MB.
The result is checked against the original graph (max |Δ| ≈ 5e-7).

Only fp32 is shipped. An fp16-compute conversion (onnxconverter-common) is
~25% faster on WebGPU and exact on CPU, but ONNX Runtime Web's WebGPU kernels
turned it into a 2-pixel checkerboard with a brightness shift. Tile size does
not change the cost per pixel (measured 256/384/512 px on WebGPU), so the
small 256 px tile that suits phone memory is kept.

Usage:
    pip install onnx onnxruntime onnxslim numpy
    curl -L -o model.onnx https://huggingface.co/Xenova/swin2SR-lightweight-x2-64/resolve/main/onnx/model.onnx
    python swin2sr.py model.onnx ../../public/models/swin2sr-lightweight-x2
"""
import hashlib
import sys

import numpy as np
import onnx
import onnxruntime as ort
import onnxslim
from onnx import TensorProto, helper, numpy_helper

TILE = 256


def main(src: str, out: str) -> None:
    dst = out + ".onnx"
    m = onnx.load(src)
    dims = m.graph.input[0].type.tensor_type.shape
    dims.ClearField("dim")
    for v in [1, 3, TILE, TILE]:
        dims.dim.add().dim_value = v
    m = onnxslim.slim(m)
    g = m.graph
    groups: dict[str, list] = {}
    for i in list(g.initializer):
        if i.dims and np.prod(i.dims) >= 1_000_000:
            a = numpy_helper.to_array(i)
            groups.setdefault(hashlib.sha1(a.tobytes()).hexdigest(), []).append((i.name, a))
    for h, lst in groups.items():
        a = lst[0][1]
        assert set(np.unique(a)).issubset({0.0, -100.0}), "unexpected large constant"
        shared = "attn_mask_" + h[:8]
        g.initializer.append(numpy_helper.from_array(a.astype(np.float16), shared + "_f16"))
        g.node.insert(0, helper.make_node("Cast", [shared + "_f16"], [shared], to=TensorProto.FLOAT, name="cast_" + h[:8]))
        names = {n for n, _ in lst}
        for n in g.node:
            for k, name in enumerate(n.input):
                if name in names:
                    n.input[k] = shared
        keep = [i for i in g.initializer if i.name not in names]
        del g.initializer[:]
        g.initializer.extend(keep)
    onnx.checker.check_model(m)
    onnx.save(m, dst)
    x = np.random.default_rng(0).random((1, 3, TILE, TILE), dtype=np.float32)
    a = ort.InferenceSession(src).run(None, {"pixel_values": x})[0]
    b = ort.InferenceSession(dst).run(None, {"pixel_values": x})[0]
    err = float(np.abs(a - b).max())
    print(f"{dst}: {len(g.node)} nodes, max |Δ| vs source {err:.2e}")
    if err > 1e-4:
        sys.exit("verification failed")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
