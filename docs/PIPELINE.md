# Shikarno — engine and pipeline

Client-side photo development for iPhone ProRAW/DNG and HEIC. Everything runs
in the browser: decoding in WebAssembly, image processing in WebGPU (WGSL),
neural networks in ONNX Runtime Web on the same GPU device. Photographs never
leave the device; models are served from this site and cached locally.

## Modules

| Module | Code | In → out |
|---|---|---|
| Input/Decoder | `src/decode/` (LibRaw 0.22.2 → wasm in `native/libraw`, libheif-js, native `createImageBitmap`) | file bytes → sensor integers + DNG metadata, or display RGB |
| RAW Development | `src/raw/develop.ts`, `develop.wgsl`, `src/color/dng.ts` | sensor data → linear Rec.2020 working texture (strip-wise upload) |
| Neural Restoration | `src/neural/tiles.ts`, `tile_*.wgsl` (SCUNet, NAFNet) | working texture → denoised/restored texture (tiled, only where needed) |
| Scene Analysis | `src/analysis/`, `blocks.wgsl`, `stats.wgsl` | textures → `AnalysisReport` (noise profile, blur map, per-region stats, histograms) |
| Semantic Segmentation | `src/neural/scene.ts` (SegFormer-B0 ADE20K → 11 groups) | ~1036 px analysis image, 512 px sliding window (25% overlap, feathered logits) → soft group probabilities at ¼ resolution |
| Depth Estimation | `src/neural/scene.ts` (Depth Anything V2 Small) | global 518 px pass for layout + 4 overlapping full-resolution tiles (least-squares aligned, fine detail only) → relative distance at ~1036 px; depth ramps at person/animal/vehicle outlines snapped to the segmentation outline |
| Mask/Depth Refinement | `src/refine/`, `refine*.wgsl` | network maps → colour-guided-filtered maps at guide resolution + tone base coefficients |
| Automatic Decision Engine | `src/decision/engine.ts` | `AnalysisReport` → `Params` + decision trace |
| Exposure/Tone, Camera Color, Semantic/Depth, DoF, Output | `src/render/renderer.ts`, `render_*.wgsl`, `output.wgsl` | textures + `Params` → display/export texture |
| Look profiles (creative layer) | `src/looks/`, `apply_profile` in `render_tone.wgsl` | technical rendering → graded rendering |
| Output Encoder | `src/output/` | rendered pixels → JPEG / HEIC / 16-bit TIFF / processed linear DNG |
| Orchestration | `src/engine/engine.ts` (Web Worker), `src/main.ts` (UI) | — |

The UI thread only draws the preview and forwards messages; decoding, GPU work
and inference all run in the engine worker.

## Processing order

```
DNG/ProRAW/HEIC → decode (LibRaw / native / libheif)
→ RAW development: black & white level, demosaic (Bayer: Malvar–He–Cutler),
  camera white balance (AsShotNeutral), camera matrix (DNG ColorMatrix/
  ForwardMatrix interpolated by illuminant, AnalogBalance, Bradford → D50 →
  Rec.2020 D65), BaselineExposure, orientation      → linear Rec.2020 (fp16)
→ reduced analysis image (≤768 px, area average)
→ SegFormer-B0, Depth Anything V2 Small (reduced image only)
→ guided-filter refinement against the photograph
→ image statistics (GPU) → decision engine
→ [first preview]
→ SCUNet (tiles with measured visible noise) → NAFNet (tiles measured as blurred)
→ render: denoise blend → white balance → depth-aware dehaze → exposure
  → local tone mapping → tone curve (display rendering) → user curves
  → technical colour (vibrance/saturation, semantic hue fixes)
  → look profile (tone curve → RGB curves → HSL → saturation response
    → colour balance → 3D LUT → semantic rules → depth curves → intensity blend)
  → sharpening → optional depth of field → output transform
```

### Deviations from the reference order (and why)

1. **Camera colour matrix before exposure/tone, not after local tone mapping.**
   The matrix is applied during RAW development (§14's own order: calibration →
   white balance → matrix → working space → exposure). Local tone mapping and
   the networks need correct colour to work on.
2. **White-balance refinement after the matrix.** It is applied in working
   space as `A_t · A_0⁻¹`, where `A = M(n)·diag(1/n)` is the full raw→working
   transform for camera neutral `n` (re-solved through the DNG model, including
   the illuminant-dependent matrix). This is algebraically the same as changing
   the camera-space gains and re-developing — without re-developing.
3. **SCUNet/NAFNet run after segmentation, depth and the first preview.** The
   analysis networks see a ≤768 px area-averaged image where sensor noise is
   already averaged away, so denoising first would not change their output but
   would delay the first preview by the full cost of SCUNet on a phone.
   Decisions about denoising use the noise measured on the undenoised image.
4. **Dehaze in linear light before exposure and tone.** The haze model
   `I = J·t + A·(1−t)` holds for scene-linear radiance only.
5. **3D LUT inside the look profile** (creative layer), never as part of the
   technical rendering.

## Colour

* Working space: linear Rec.2020 D65, scene-referred, fp16 textures.
* Look space: Display P3 with the sRGB transfer curve (what iPhones display).
* Display rendering (`src/render/curves.ts`): a log-logistic tone curve
  applied to luminance as a ratio (no hue shifts), middle grey 0.18 →
  display 0.23, soft toe, highlight shoulder with a path to white; soft gamut
  compression toward luminance instead of per-channel clipping.
* **Exposure is the camera's.** ProRAW carries Apple's metered exposure as
  BaselineExposure; the engine keeps it. The decision engine only *suggests*
  a correction when the subject key leaves a comfortable band (±1 EV max);
  "Auto exposure" in Adjust applies it.

## Decision engine

`src/decision/engine.ts`. Semantic class decides which operations are
appropriate for a region, measurements decide how strong they are, depth
provides spatial context. Every decision is recorded with the numbers it used
(Auto tab, and the "Download analysis JSON" button in Debug).

Examples: denoise strength follows the measured noise σ per luminance bin
(15th percentile of Immerkaer estimates per 32 px block) after the chosen
exposure and shadow lift; restoration runs only on tiles whose estimated blur
σ (noise-corrected Laplacian/gradient ratio, calibrated on Gaussian-blurred
real frames: σ ≈ 0.7 / ratio) exceeds 1.6 px; NAFNet tiles whose output
diverges are rejected by a sanity gate (NAFNet-GoPro is unstable on already
sharp, sharpened content — measured, see `scripts/models/export.py`); dehaze
needs distant regions whose dark channel is raised relative to near ones and
whose local contrast is lower, and is capped so atmosphere never disappears.

## Look profiles

A profile is JSON (`src/looks/profile.ts`, schema below) plus an optional
`.cube`. It is applied after the technical rendering and never compensates
for camera colour. Intensity 0 is exactly the technical result; blending is
done in OkLab, not in encoded RGB. One profile is active at a time (no
stacking); user adjustments stay in the technical layer.

```jsonc
{
  "id": "teal-warm", "name": "Teal & Warm", "version": 1, "category": "warm cinematic",
  "workingSpace": "linear-wide-gamut",
  "tone": { "contrast": 0.14, "blackPoint": 0.02, "highlightCompression": 0.18,
            "shadowLift": 0.03, "rolloff": 0.7, "curve": [[0,0],[1,1]] },
  "rgbCurves": { "r": [[0,0],[1,1]], "g": [[0,0],[1,1]], "b": [[0,0],[1,1]] },
  "hsl": { "green": { "hue": 18, "sat": -0.3, "lum": -0.05 } /* red orange yellow green cyan blue violet magenta */ },
  "colorBalance": { "shadows": [-0.015,0.012,0.03], "midtones": [0.015,0,-0.01], "highlights": [0.03,0.012,-0.015] },
  "saturation": { "global": 0.95, "shadows": 0.9, "highlights": 0.9, "knee": 0.2, "compression": 1.0, "lowBoost": 0 },
  "lut": { "id": "film-crosstalk", "file": null, "size": 33, "strength": 0.4 },
  "semantic": { "person": { "hue": 0, "sat": 0, "lum": 0, "protect": 0.65 } },
  "depth": { "saturation": [0.06, 0, -0.18], "haze": [0, 0.02, 0.08] },   // near, middle, far
  "hueCurves": { "hue": [[0,0.5],[1,0.5]], "sat": [[0,0.5],[1,0.5]], "lum": [[0,0.5],[1,0.5]] },  // x = OkLab hue/360, periodic; 0.5 = no change
  "palette": { "anchors": [{ "hue": 68, "sat": 1.1, "weight": 1 }, { "hue": 200, "sat": 1, "weight": 1 }],
               "pull": 0.55, "focus": 0.5, "width": 38 },
  "intensity": 1
}
```

* **Rainbow curves** (hue → hue ±60°, hue → saturation ×0–2, hue → luminance
  ±0.25 L) are periodic cubic curves sampled into a 360-texel table.
* **Palette restriction** (a film's colour script, category "cinema palette"):
  each hue is pulled toward the anchors by a closeness-weighted average of its
  offsets (a hue between two anchors drifts toward both instead of snapping),
  anchor chroma multipliers are blended in the same way, and colours far from
  every anchor are desaturated by `focus`. It runs after the saturation
  response, before colour balance and the 3D LUT.

* Hue ranges use overlapping raised-cosine windows in OkLab hue (no hard
  boundaries); luminance zones use smoothsteps; saturation compression is a
  soft knee; semantic rules are weighted by the refined (guided-filtered,
  joint-bilateral-upsampled) masks; depth parameters are monotone-cubic curves
  over distance, sampled from a 64-texel texture.
* LUTs: `.cube` 17³/33³/65³ parsed in TypeScript, uploaded as rgba16f 3D
  textures, trilinear hardware interpolation, independent strength.
* Previews: every profile is rendered through the same GPU path on a ~300 px
  proxy (15 profiles ≈ 130 ms on an M-series Mac).
* Palette analysis (`src/looks/palette.ts`): OkLab k-means (deterministic),
  hue distribution, zone palettes, warm/cool balance. Informational — never
  applied automatically.
* Reference looks (`src/looks/reference.ts`): *create* derives an editable
  profile from a reference's tone character (brightness-independent), zone
  colour tendencies, saturation distribution, hue ranges and regions. *Match*
  moves the current photo's statistics part of the way toward the reference:
  tone shape around the photo's own median, zone colour differences, chroma
  ratio, per-hue-range and per-region (sky↔sky, vegetation↔vegetation)
  differences. People are excluded from statistics and protected; sky is
  matched only through its own region rule.

## Per-region control

The Regions tab exposes the technical per-region parameters the decision
engine sets (exposure, highlights, warmth, tint, saturation, vibrance, hue,
clarity, texture, sharpening, noise reduction, dehaze) for each of the 11
groups. They are blended per pixel by the refined soft masks (guided filter +
joint bilateral upsampling), so there are no region boundaries. The selected
region can be highlighted on the photo.

## iPhone constraints

* SegFormer and Depth Anything never see more than ~1036 px, and only in 512 px / ~0.6-frame
  pieces run one at a time (peak GPU memory of a single small pass). Depth Anything draws
  silhouettes as ramps several pixels wide; the guided filter can move an edge a few pixels
  but not rebuild it, so ramp pixels next to people/animals/vehicles are assigned to their
  side of the segmentation outline (values off the ramp — a hand in front — are kept).
* RAW sources above 16 MP develop at half size on phones ("Working size" in
  Export overrides).
* Sensor data is uploaded strip-wise; the LibRaw heap is dropped right after.
* Full-resolution masks are never stored: guide-resolution maps are
  joint-bilaterally upsampled per pixel at render time.
* SCUNet/NAFNet tiles run only where needed; tile tensors stay on the GPU
  (ONNX Runtime shares the engine's `GPUDevice` through an adapter shim).
* Every GPU allocation is tracked; the Debug tab shows time, live and peak GPU
  memory per stage — use it on a real iPhone before adding stages.
* If Safari evicts the tab or the GPU is reset, the photo (kept in the Origin
  Private File System) and all edits are restored automatically.

## Known limitations

* **No CPU/WASM image-processing fallback yet.** Without WebGPU the app says
  so and stops. (Safari on iOS 26 has WebGPU.) ONNX inference itself does fall
  back to WASM SIMD.
* JPEG-XL–compressed DNGs (an iOS option) are not decoded: LibRaw is built
  without libjxl. Lossless-JPEG ProRAW (the compatible default) works.
* HEIC gain maps (iOS HDR) are ignored; HEIC input is display-referred.
* Apple's ProfileGainTableMap (ProRAW local tone map) and semantic mattes are
  not used; the engine does its own local tone mapping and segmentation.
* SegFormer's weights are licensed for non-commercial use only (see
  `public/THIRD_PARTY_NOTICES.txt`).
* The processed DNG export is linear, scene-referred and explicitly labelled
  as processed — each raw converter will render it with its own tone curve.
