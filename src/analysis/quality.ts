/**
 * Module: Image quality analysis → the 2× upscale decision.
 *
 *   in:  the restored (denoised/deblurred) working texture, scene-linear
 *   out: ImageQualityReport — measurements plus a deterministic, conservative
 *        decision whether 2× neural upscaling is worth running
 *
 * Measurements are taken on luminance, display-encoded (normalisation gain +
 * sRGB curve, the encoding noise and blur are judged in everywhere else), in
 * a grid of 256 px patches read at native resolution. Whether an image is
 * resolution-limited is a pixel-scale property — a downscaled copy would
 * average exactly that away — and a dozen patches cost a fraction of a
 * millisecond per megapixel instead of reading the whole frame.
 *
 * Per patch (and per 32 px block inside it):
 *   noise      Immerkær's estimator (Laplacian-difference mask); the lower
 *              quartile over patches, so texture is not mistaken for noise
 *   Laplacian  variance of the 4-neighbour Laplacian (noise-corrected)
 *   Tenengrad  mean Sobel gradient energy (noise-corrected)
 *   edge width Gaussian σ from the ratio of Laplacian to gradient energy on
 *              edge pixels of each block, σ ≈ 0.7·√(G/L) — the same model the
 *              blur report uses; the sharpest quartile of blocks decides, so a
 *              sharp subject in front of bokeh is not called "blurred"
 *   detail     share of pixels with a gradient clearly above the noise
 */
import type { Gpu } from "../gpu/gpu.ts";
import { halvesToFloats } from "../gpu/half.ts";

/** Export resolution the decision aims for: the standard iPhone 12 MP frame. */
export const TARGET_MP = 12;

export interface QualityMetrics {
  /** Noise-corrected variance of the Laplacian of encoded luma. */
  laplacianVar: number;
  /** Noise-corrected mean Sobel gradient energy (Tenengrad) of encoded luma. */
  tenengrad: number;
  /** Encoded-luma noise σ (1/255 ≈ 0.0039) after restoration. */
  noiseSigma: number;
  /** Estimated edge blur σ (px) of the sharpest quartile of edge blocks, and the median. */
  edgeSigma: number;
  edgeSigmaMedian: number;
  /** Share of pixels with gradient clearly above noise. */
  detailDensity: number;
  edgeBlocks: number;
  patches: number;
}

export type UpscaleReasonCode =
  | "sufficient" | "sharp-12" | "adequate" | "severe-blur" | "noise" | "no-detail"
  | "reduced" | "memory" | "below-target" | "soft" | "resolution-limited" | "off" | "forced";

/** User setting: automatic decision, always 2× (memory permitting), or never. */
export type UpscaleMode = "auto" | "always" | "off";

export interface ImageQualityReport {
  width: number;
  height: number;
  megapixels: number;
  /** 0 (σ ≥ 3 px) … 1 (pixel-sharp, σ ≤ 0.8 px). */
  sharpnessScore: number;
  /** Residual noise relative to the level where 2× would visibly enlarge it (1 = at the limit). */
  noiseScore: number;
  /** 0 … 1: density of real edges/texture. */
  detailScore: number;
  severeBlur: boolean;
  needsUpscale: boolean;
  reason: string;
  /** Machine-readable reason and its values, for the (translated) UI. */
  code: UpscaleReasonCode;
  vars: Record<string, string | number>;
  metrics: QualityMetrics;
}

export interface QualityContext {
  width: number;
  height: number;
  iso?: number;
  /** The user reopened the photo at reduced size to save memory. */
  reducedByUser: boolean;
  /** Largest output (MP) this device may hold as a working texture. */
  maxOutputMP: number;
  maxTextureDimension: number;
  targetMP?: number;
  /** "always" overrides every quality reason (never the memory budget); "off" never upscales. */
  mode?: UpscaleMode;
}

const PATCH = 256;
const BLOCK = 32;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const quantile = (v: number[], q: number) => {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
};

/** Patch origins: a cols×rows grid of patch centres spread over the frame. */
function patchGrid(W: number, H: number): Array<[number, number, number, number]> {
  const pw = Math.min(PATCH, W), ph = Math.min(PATCH, H);
  const cols = W >= 3 * PATCH ? 4 : W >= 2 * PATCH ? 3 : 1;
  const rows = H >= 3 * PATCH ? 3 : H >= 2 * PATCH ? 2 : 1;
  const out: Array<[number, number, number, number]> = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const cx = ((i + 0.5) / cols) * W, cy = ((j + 0.5) / rows) * H;
    out.push([Math.round(Math.min(W - pw, Math.max(0, cx - pw / 2))), Math.round(Math.min(H - ph, Math.max(0, cy - ph / 2))), pw, ph]);
  }
  return out;
}

/** Encoded luma of one patch (Rec.2020 luminance → gain → sRGB curve). */
function lumaPatch(rgba: Float32Array, n: number, gain: number): Float32Array {
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = Math.min(1, Math.max(0, (0.2627 * rgba[i * 4] + 0.678 * rgba[i * 4 + 1] + 0.0593 * rgba[i * 4 + 2]) * gain));
    y[i] = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  }
  return y;
}

/** Pure measurement on encoded-luma patches (exported for tests). */
export function measureLuma(patches: Array<{ y: Float32Array; w: number; h: number }>): QualityMetrics {
  // Noise first (Immerkær 1996): σ = √(π/2) / (6(W−2)(H−2)) · Σ|I ∗ N|.
  const sigmas: number[] = [];
  for (const { y, w, h } of patches) {
    if (w < 3 || h < 3) continue;
    let acc = 0;
    for (let r = 1; r < h - 1; r++) for (let c = 1; c < w - 1; c++) {
      const i = r * w + c;
      const v = y[i - w - 1] - 2 * y[i - w] + y[i - w + 1] - 2 * y[i - 1] + 4 * y[i] - 2 * y[i + 1] + y[i + w - 1] - 2 * y[i + w] + y[i + w + 1];
      acc += Math.abs(v);
    }
    sigmas.push((Math.sqrt(Math.PI / 2) * acc) / (6 * (w - 2) * (h - 2)));
  }
  const noise = quantile(sigmas, 0.25) || 0;
  const s2 = noise * noise;
  const edgeThr = Math.max(0.02, 8 * noise);
  const detailThr = Math.max(0.015, 4 * noise);
  let lapSum = 0, lapSq = 0, ten = 0, count = 0, detail = 0;
  const blockSigma: number[] = [];
  for (const { y, w, h } of patches) {
    for (let by = 0; by + BLOCK <= h; by += BLOCK) for (let bx = 0; bx + BLOCK <= w; bx += BLOCK) {
      let G = 0, L = 0, n = 0;
      for (let r = Math.max(1, by); r < Math.min(h - 1, by + BLOCK); r++) for (let c = Math.max(1, bx); c < Math.min(w - 1, bx + BLOCK); c++) {
        const i = r * w + c;
        const lap = y[i - 1] + y[i + 1] + y[i - w] + y[i + w] - 4 * y[i];
        const gx = (y[i + 1] - y[i - 1]) / 2, gy = (y[i + w] - y[i - w]) / 2;
        const sx = (y[i - w + 1] + 2 * y[i + 1] + y[i + w + 1] - y[i - w - 1] - 2 * y[i - 1] - y[i + w - 1]) / 8;
        const sy = (y[i + w - 1] + 2 * y[i + w] + y[i + w + 1] - y[i - w - 1] - 2 * y[i - w] - y[i - w + 1]) / 8;
        lapSum += lap; lapSq += lap * lap; ten += sx * sx + sy * sy; count++;
        const g2 = gx * gx + gy * gy;
        if (g2 > detailThr * detailThr) detail++;
        if (g2 > edgeThr * edgeThr) { G += g2; L += lap * lap; n++; }
      }
      if (n < 24) continue;
      // Noise contributes σ² to the central-difference gradient energy and 20σ² to the Laplacian's.
      const g = G / n - s2, l = L / n - 20 * s2;
      if (g <= 1e-8) continue;
      const ratio = Math.sqrt(Math.max(l, 0) / g);
      blockSigma.push(ratio > 1e-3 ? Math.min(8, 0.7 / ratio) : 8);
    }
  }
  const mean = count ? lapSum / count : 0;
  return {
    laplacianVar: count ? Math.max(0, lapSq / count - mean * mean - 20 * s2) : 0,
    tenengrad: count ? Math.max(0, ten / count - (3 / 8) * s2) : 0,
    noiseSigma: noise,
    edgeSigma: blockSigma.length ? quantile(blockSigma, 0.25) : NaN,
    edgeSigmaMedian: blockSigma.length ? quantile(blockSigma, 0.5) : NaN,
    detailDensity: count ? detail / count : 0,
    edgeBlocks: blockSigma.length,
    patches: patches.length,
  };
}

/** Reads the patch grid of a working texture and measures it (GPU → a few MB of readback). */
export async function measureQuality(gpu: Gpu, tex: GPUTexture, W: number, H: number, gain: number): Promise<QualityMetrics> {
  const patches: Array<{ y: Float32Array; w: number; h: number }> = [];
  for (const [x, y, w, h] of patchGrid(W, H)) {
    const half = new Uint16Array(await gpu.readTexture(tex, x, y, w, h, 8));
    patches.push({ y: lumaPatch(halvesToFloats(half), w * h, gain), w, h });
  }
  return measureLuma(patches);
}

const mp1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);

/**
 * The upscale decision. Deterministic and conservative: 2× runs only when the
 * frame is short of the target resolution or measurably soft at pixel level,
 * never for noise alone, never on severe blur (there is nothing reliable to
 * enhance), and never beyond the device's memory budget. ISO only tightens
 * the noise and detail requirements; it can never enable upscaling.
 */
export function decideUpscale(m: QualityMetrics, ctx: QualityContext): ImageQualityReport {
  const auto = decideAuto(m, ctx);
  const mode = ctx.mode ?? "auto";
  if (mode === "off") return { ...auto, needsUpscale: false, code: "off", reason: "upscaling is switched off", vars: {} };
  if (mode === "always" && !auto.needsUpscale && auto.code !== "memory") {
    const outMP = auto.megapixels * 4;
    if (outMP > ctx.maxOutputMP || 2 * Math.max(ctx.width, ctx.height) > ctx.maxTextureDimension)
      return { ...auto, code: "memory", reason: `2× output (${mp1(outMP)} MP) would exceed this device's memory budget (${ctx.maxOutputMP} MP)`, vars: { mp: mp1(outMP) } };
    return { ...auto, needsUpscale: true, code: "forced", reason: `requested (automatic decision: ${auto.reason})`, vars: { mp: mp1(auto.megapixels) } };
  }
  return auto;
}

function decideAuto(m: QualityMetrics, ctx: QualityContext): ImageQualityReport {
  const target = ctx.targetMP ?? TARGET_MP;
  const mp = (ctx.width * ctx.height) / 1e6;
  const iso = ctx.iso ?? 0;
  const edge = Number.isFinite(m.edgeSigma) ? m.edgeSigma : 8;
  const sharpnessScore = Math.round((1 - smooth(0.8, 3.0, edge)) * 1000) / 1000;
  // Residual noise a 2× enlargement would make visible: ~2/255 encoded σ, less at high ISO.
  const noiseLimit = (2.0 / 255) * (iso >= 3200 ? 0.75 : iso >= 1600 ? 0.875 : 1);
  const noiseScore = Math.round((m.noiseSigma / noiseLimit) * 1000) / 1000;
  // High ISO: grain can pass for texture, so more real detail is required.
  const minDetail = 0.02 * (iso >= 1600 ? 1.5 : 1);
  const detailScore = Math.round(Math.min(1, m.detailDensity / 0.25) * 1000) / 1000;
  // Severe blur: even the sharpest quarter of the edges is wider than 3 px (or there are almost no edges at all while the frame is not empty).
  const severeBlur = (m.edgeBlocks >= 4 && edge >= 3.0) || (m.edgeBlocks > 0 && m.edgeBlocks < 4 && (m.edgeSigmaMedian || 8) >= 3.0);
  const soft = smooth(1.2, 2.2, edge); // 0 sharp … 1 clearly soft (still below "severe")
  const limited = sharpnessScore >= 0.75 && m.detailDensity >= 2 * minDetail; // detail reaches the pixel grid
  const base = { width: ctx.width, height: ctx.height, megapixels: Math.round(mp * 100) / 100, sharpnessScore, noiseScore, detailScore, severeBlur, metrics: m };
  const skip = (code: UpscaleReasonCode, reason: string, vars: Record<string, string | number> = {}): ImageQualityReport =>
    ({ ...base, needsUpscale: false, code, reason, vars });
  const run = (code: UpscaleReasonCode, reason: string, vars: Record<string, string | number> = {}): ImageQualityReport => {
    const outMP = mp * 4;
    if (outMP > ctx.maxOutputMP || 2 * Math.max(ctx.width, ctx.height) > ctx.maxTextureDimension)
      return skip("memory", `2× output (${mp1(outMP)} MP) would exceed this device's memory budget (${ctx.maxOutputMP} MP)`, { mp: mp1(outMP) });
    return { ...base, needsUpscale: true, code, reason, vars };
  };

  if (ctx.reducedByUser) return skip("reduced", "photo was opened at reduced size to save memory; upscaling would undo that");
  if (severeBlur) return skip("severe-blur", "severe blur detected; super-resolution would not recover reliable detail", { sigma: edge.toFixed(1) });
  if (mp >= 16) return skip("sufficient", `source detail is sufficient (${mp1(mp)} MP)`, { mp: mp1(mp) });
  if (m.noiseSigma > noiseLimit) return skip("noise", `residual noise σ ${(m.noiseSigma * 255).toFixed(2)}/255 would be enlarged, not improved`);
  if (m.detailDensity < minDetail) return skip("no-detail", `too little real detail (${(m.detailDensity * 100).toFixed(1)}% of pixels) for enhancement to help`);
  if (mp >= target) {
    if (soft >= 0.5) return run("soft", `${mp1(mp)} MP but soft at pixel level (edge σ ${edge.toFixed(2)} px)`, { mp: mp1(mp), sigma: edge.toFixed(1) });
    return skip("sharp-12", `source detail is sufficient (${mp1(mp)} MP, edge σ ${edge.toFixed(2)} px)`, { mp: mp1(mp) });
  }
  if (mp >= 8) {
    if (soft >= 0.3) return run("soft", `${mp1(mp)} MP and soft at pixel level (edge σ ${edge.toFixed(2)} px)`, { mp: mp1(mp), sigma: edge.toFixed(1) });
    if (limited) return run("resolution-limited", `${mp1(mp)} MP with detail down to single pixels — resolution-limited`, { mp: mp1(mp) });
    return skip("adequate", `source detail is sufficient for ${mp1(mp)} MP (edge σ ${edge.toFixed(2)} px)`, { mp: mp1(mp) });
  }
  return run("below-target", `image has only ${mp1(mp)} MP, below the ${target} MP export target`, { mp: mp1(mp), target });
}
