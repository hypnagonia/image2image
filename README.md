# Shikarno

On-device development of iPhone ProRAW/DNG and HEIC photographs in the browser:
LibRaw (WebAssembly) decoding, WebGPU/WGSL processing, SCUNet · NAFNet ·
SegFormer-B0 · Depth Anything V2 through ONNX Runtime Web, a deterministic and
inspectable decision engine, and a look-profile system for creative grading.

Live: https://image-improver2.vercel.app

See [docs/PIPELINE.md](docs/PIPELINE.md) for the architecture, processing order
(and every deviation from the reference order), colour science, decision
engine, look-profile format and known limitations.

## Develop

```sh
npm install
npm run dev          # http://localhost:5173 (COOP/COEP headers set)
npm test             # colour math, profiles, palette/matching
npm run build        # dist/
```

Rebuilding native parts (checked-in outputs, only needed when changing them):

```sh
LIBRAW_SRC=/path/to/LibRaw-0.22.2 npm run build:libraw          # needs emscripten
python scripts/models/export.py --work <weights dir> --out public/models   # SCUNet/NAFNet → ONNX
```

## Deploy

`vercel deploy --prod` (project `image-improver2`). `vercel.json` sets the
cross-origin-isolation headers that multi-threaded WASM needs.
