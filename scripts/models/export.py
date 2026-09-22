"""Export SCUNet and NAFNet to ONNX for the browser, and verify the exports.

Usage (see scripts/models/README.md):
    python export.py --work <dir with downloaded weights + upstream arch files> --out public/models

Produces, per network:
    <name>.fp32w16.onnx  fp16 weights, fp32 compute. Runs on every backend
                         (WebGPU without shader-f16, WASM). Casts are folded
                         when the session is created.
    <name>.fp16.onnx     fp16 weights and compute, fp32 I/O. Used on WebGPU
                         adapters that expose shader-f16 (Apple GPUs do).

Each export is checked against the PyTorch forward pass on a natural-image
tile; the script fails if the error exceeds the stated tolerance.
"""
import argparse
import os
import sys
import types

import numpy as np
import onnx
import onnxruntime as ort
import torch
import torch.nn as nn
import torch.nn.functional as F
from onnx import helper, numpy_helper, TensorProto

TILE = 256


# --------------------------------------------------------------------------
# NAFNet (MIT, megvii-research/NAFNet) — inlined so LayerNorm2d is expressed
# in standard ops instead of the custom autograd Function upstream uses.
# --------------------------------------------------------------------------
class LayerNorm2d(nn.Module):
    def __init__(self, channels, eps=1e-6):
        super().__init__()
        self.weight = nn.Parameter(torch.ones(channels))
        self.bias = nn.Parameter(torch.zeros(channels))
        self.eps = eps

    def forward(self, x):
        mu = x.mean(1, keepdim=True)
        var = (x - mu).pow(2).mean(1, keepdim=True)
        y = (x - mu) / torch.sqrt(var + self.eps)
        return self.weight.view(1, -1, 1, 1) * y + self.bias.view(1, -1, 1, 1)


class SimpleGate(nn.Module):
    def forward(self, x):
        x1, x2 = x.chunk(2, dim=1)
        return x1 * x2


class NAFBlock(nn.Module):
    def __init__(self, c, DW_Expand=2, FFN_Expand=2):
        super().__init__()
        dw = c * DW_Expand
        self.conv1 = nn.Conv2d(c, dw, 1)
        self.conv2 = nn.Conv2d(dw, dw, 3, padding=1, groups=dw)
        self.conv3 = nn.Conv2d(dw // 2, c, 1)
        self.sca = nn.Sequential(nn.AdaptiveAvgPool2d(1), nn.Conv2d(dw // 2, dw // 2, 1))
        self.sg = SimpleGate()
        ffn = FFN_Expand * c
        self.conv4 = nn.Conv2d(c, ffn, 1)
        self.conv5 = nn.Conv2d(ffn // 2, c, 1)
        self.norm1 = LayerNorm2d(c)
        self.norm2 = LayerNorm2d(c)
        self.dropout1 = nn.Identity()
        self.dropout2 = nn.Identity()
        self.beta = nn.Parameter(torch.zeros((1, c, 1, 1)))
        self.gamma = nn.Parameter(torch.zeros((1, c, 1, 1)))

    def forward(self, inp):
        x = self.norm1(inp)
        x = self.conv2(self.conv1(x))
        x = self.sg(x)
        x = x * self.sca(x)
        x = self.conv3(x)
        y = inp + x * self.beta
        x = self.conv4(self.norm2(y))
        x = self.sg(x)
        x = self.conv5(x)
        return y + x * self.gamma


class NAFNet(nn.Module):
    def __init__(self, img_channel=3, width=32, middle_blk_num=1, enc_blk_nums=(1, 1, 1, 28), dec_blk_nums=(1, 1, 1, 1)):
        super().__init__()
        self.intro = nn.Conv2d(img_channel, width, 3, padding=1)
        self.ending = nn.Conv2d(width, img_channel, 3, padding=1)
        self.encoders, self.decoders, self.ups, self.downs = nn.ModuleList(), nn.ModuleList(), nn.ModuleList(), nn.ModuleList()
        chan = width
        for num in enc_blk_nums:
            self.encoders.append(nn.Sequential(*[NAFBlock(chan) for _ in range(num)]))
            self.downs.append(nn.Conv2d(chan, 2 * chan, 2, 2))
            chan *= 2
        self.middle_blks = nn.Sequential(*[NAFBlock(chan) for _ in range(middle_blk_num)])
        for num in dec_blk_nums:
            self.ups.append(nn.Sequential(nn.Conv2d(chan, chan * 2, 1, bias=False), nn.PixelShuffle(2)))
            chan //= 2
            self.decoders.append(nn.Sequential(*[NAFBlock(chan) for _ in range(num)]))

    def forward(self, inp):
        x = self.intro(inp)
        encs = []
        for encoder, down in zip(self.encoders, self.downs):
            x = encoder(x)
            encs.append(x)
            x = down(x)
        x = self.middle_blks(x)
        for decoder, up, enc_skip in zip(self.decoders, self.ups, encs[::-1]):
            x = up(x)
            x = x + enc_skip
            x = decoder(x)
        return self.ending(x) + inp


# --------------------------------------------------------------------------
def load_scunet(work):
    # Upstream imports thop only for its __main__ profiling block.
    sys.modules.setdefault("thop", types.SimpleNamespace(profile=None))
    sys.path.insert(0, work)
    from network_scunet import SCUNet  # noqa: E402

    net = SCUNet(in_nc=3, config=[4, 4, 4, 4, 4, 4, 4], dim=64)
    sd = torch.load(os.path.join(work, "scunet_color_real_psnr.pth"), map_location="cpu")
    net.load_state_dict(sd, strict=True)
    return net.eval()


def load_nafnet(work):
    net = NAFNet(width=32, middle_blk_num=1, enc_blk_nums=(1, 1, 1, 28), dec_blk_nums=(1, 1, 1, 1))
    sd = torch.load(os.path.join(work, "NAFNet-GoPro-width32.pth"), map_location="cpu")
    sd = sd.get("params", sd)
    net.load_state_dict(sd, strict=True)
    return net.eval()


def export(net, path):
    x = torch.rand(1, 3, TILE, TILE)
    torch.onnx.export(net, (x,), path, input_names=["input"], output_names=["output"],
                      opset_version=17, do_constant_folding=True, dynamo=False)
    m = onnx.load(path, load_external_data=True)
    onnx.save(m, path, save_as_external_data=False)
    ext = path + ".data"
    if os.path.exists(ext):
        os.remove(ext)


def to_w16(src, dst):
    """fp16 initializers, each followed by a Cast back to fp32."""
    m = onnx.load(src)
    g = m.graph
    new_inits, casts = [], []
    for init in g.initializer:
        arr = numpy_helper.to_array(init)
        if arr.dtype == np.float32 and arr.size >= 16:
            name16 = init.name + "__f16"
            new_inits.append(numpy_helper.from_array(arr.astype(np.float16), name16))
            casts.append(helper.make_node("Cast", [name16], [init.name], to=TensorProto.FLOAT, name=init.name + "__cast"))
        else:
            new_inits.append(init)
    del g.initializer[:]
    g.initializer.extend(new_inits)
    nodes = list(g.node)
    del g.node[:]
    g.node.extend(casts + nodes)
    onnx.checker.check_model(m)
    onnx.save(m, dst)


def to_fp16(src, dst):
    from onnxconverter_common import float16
    m = onnx.load(src)
    m16 = float16.convert_float_to_float16(m, keep_io_types=True, disable_shape_infer=False)
    onnx.save(m16, dst)


def natural_tile(work, blur=0):
    """A 256px crop of a real photograph. NAFNet-GoPro is checked on a
    motion-blurred copy: that is the only input it is ever given (the engine
    runs it on tiles measured as blurred), and on already-sharp, sharpened
    content its activations diverge (outputs of -19..36 were measured) — the
    engine additionally gates every NAFNet tile on output sanity."""
    from PIL import Image
    p = os.path.join(work, "probe.png")
    img = np.asarray(Image.open(p).convert("RGB"), dtype=np.float32) / 255.0
    h, w, _ = img.shape
    y, x = (h - TILE) // 2, (w - TILE) // 2
    t = img[y:y + TILE, x:x + TILE]
    if blur > 1:
        pad = np.pad(t, ((0, 0), (blur // 2, blur // 2), (0, 0)), mode="edge")
        t = sum(pad[:, i:i + TILE] for i in range(blur)) / blur
    return np.ascontiguousarray(t.transpose(2, 0, 1)[None].astype(np.float32))


def probe_activations(net, x):
    """Largest intermediate magnitude: fp16 tops out at 65504."""
    peak = [0.0]
    hooks = [m.register_forward_hook(lambda m, i, o: peak.__setitem__(0, max(peak[0], o.abs().max().item())))
             for m in net.modules() if isinstance(m, NAFBlock)]
    with torch.no_grad():
        net(torch.from_numpy(x))
    for h in hooks:
        h.remove()
    print(f"  peak block activation {peak[0]:.0f} (fp16 max 65504)")


def check(net, onnx_path, x, tol):
    with torch.no_grad():
        ref = net(torch.from_numpy(x)).numpy()
    s = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    out = s.run(None, {"input": x})[0]
    err = np.abs(out - ref)
    print(f"  {os.path.basename(onnx_path)}: max {err.max():.5f} mean {err.mean():.6f} "
          f"(size {os.path.getsize(onnx_path) / 1e6:.1f}MB)")
    if err.mean() > tol:
        raise SystemExit(f"{onnx_path}: mean error {err.mean()} exceeds {tol}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    # NAFNet stacks 34 LayerNorms with eps=1e-6; accumulation order alone moves
    # its fp32 output by ~5e-4 (0.1 of an 8-bit level), so its bar is wider.
    only = os.environ.get("ONLY")
    for name, loader, tol in (("scunet", load_scunet, 1e-5), ("nafnet", load_nafnet, 1e-3)):
        if only and name != only:
            continue
        net = loader(a.work)
        x = natural_tile(a.work, blur=7 if name == "nafnet" else 0)
        print(name, sum(p.numel() for p in net.parameters()) / 1e6, "M params")
        if name == "nafnet":
            probe_activations(net, x)
        f32 = os.path.join(a.work, f"{name}.fp32.onnx")
        export(net, f32)
        check(net, f32, x, tol)
        w16 = os.path.join(a.out, f"{name}.fp32w16.onnx")
        to_w16(f32, w16)
        check(net, w16, x, tol + 2e-3)
        f16 = os.path.join(a.out, f"{name}.fp16.onnx")
        to_fp16(f32, f16)
        check(net, f16, x, tol + 4e-3)


if __name__ == "__main__":
    main()
