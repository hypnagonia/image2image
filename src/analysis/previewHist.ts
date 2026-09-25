/**
 * Intensity histograms of the rendered preview, for drawing behind the curves:
 * the whole photo, each region, skin and each distance band, per channel
 * (L = display luma, R, G, B), 64 levels of the display-encoded value.
 *
 * Every pixel counts toward a region by its soft probability and toward a
 * distance band by the same soft band weights the renderer blends curves with,
 * so each histogram shows what that curve actually acts on. Skin is people ×
 * a simple warm-colour test (r > g > b). A 3×3 stride keeps it to a few ms.
 */
import { GROUPS } from "../neural/scene.ts";

const BANDS = ["near", "middle", "far"] as const;
export const HIST_TARGETS = ["photo", ...GROUPS, "skin", ...BANDS, ...GROUPS.flatMap((g) => BANDS.map((b) => `${g}.${b}` as const))] as const;
export type HistTarget = (typeof HIST_TARGETS)[number];
const CELL0 = 2 + GROUPS.length + BANDS.length;
export const HIST_BINS = 64;
const CH = 4;

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function previewHistograms(
  px: Uint8Array, w: number, h: number,
  seg: { width: number; height: number; probs: Float32Array } | undefined,
  dist: { w: number; h: number; data: Float32Array } | undefined,
  bands: [number, number],
  stride = 3,
): Float32Array {
  const T = HIST_TARGETS.length;
  const out = new Float32Array(T * CH * HIST_BINS);
  const plane = seg ? seg.width * seg.height : 0;
  const person = GROUPS.indexOf("person");
  const f = 0.06;
  // Scalar arguments (no per-sample arrays: this runs ~200k times per preview).
  let L = 0, R = 0, G = 0, B = 0;
  const add = (t: number, w8: number) => {
    const base = t * CH * HIST_BINS;
    out[base + Math.min(HIST_BINS - 1, L >> 2)] += w8;
    out[base + HIST_BINS + Math.min(HIST_BINS - 1, R >> 2)] += w8;
    out[base + 2 * HIST_BINS + Math.min(HIST_BINS - 1, G >> 2)] += w8;
    out[base + 3 * HIST_BINS + Math.min(HIST_BINS - 1, B >> 2)] += w8;
  };
  const t0 = 2 + GROUPS.length;
  for (let y = 0; y < h; y += stride) {
    const dy = dist ? Math.min(dist.h - 1, Math.floor((y / h) * dist.h)) : 0;
    const sy = seg ? Math.min(seg.height - 1, Math.floor((y / h) * seg.height)) : 0;
    for (let x = 0; x < w; x += stride) {
      const i = (y * w + x) * 4;
      R = px[i]; G = px[i + 1]; B = px[i + 2];
      L = Math.round(0.2290 * R + 0.6917 * G + 0.0793 * B);
      add(0, 1);
      let w0 = 0, w1 = 0, w2 = 0;
      if (dist) {
        const dx = Math.min(dist.w - 1, Math.floor((x / w) * dist.w));
        const d = dist.data[dy * dist.w + dx];
        w0 = 1 - smooth(bands[0] - f, bands[0] + f, d); w2 = smooth(bands[1] - f, bands[1] + f, d);
        w1 = Math.max(0, 1 - w0 - w2);
      }
      if (seg) {
        const sx = Math.min(seg.width - 1, Math.floor((x / w) * seg.width));
        const k = sy * seg.width + sx;
        for (let gi = 0; gi < GROUPS.length; gi++) {
          const p = seg.probs[gi * plane + k];
          if (p > 0.05) {
            add(1 + gi, p);
            // The same region at each distance (a cell).
            if (dist) {
              const c = CELL0 + gi * 3;
              if (p * w0 > 0.05) add(c, p * w0);
              if (p * w1 > 0.05) add(c + 1, p * w1);
              if (p * w2 > 0.05) add(c + 2, p * w2);
            }
          }
        }
        const warm = R > G && G > B && R - B > 15 ? 1 : 0;
        const sk = seg.probs[person * plane + k] * warm;
        if (sk > 0.05) add(1 + GROUPS.length, sk);
      }
      if (dist) {
        if (w0 > 0.05) add(t0, w0);
        if (w1 > 0.05) add(t0 + 1, w1);
        if (w2 > 0.05) add(t0 + 2, w2);
      }
    }
  }
  // Each histogram sums to 1 (an empty one stays 0).
  for (let s = 0; s < T * CH; s++) {
    let sum = 0;
    for (let k = 0; k < HIST_BINS; k++) sum += out[s * HIST_BINS + k];
    if (sum > 0) for (let k = 0; k < HIST_BINS; k++) out[s * HIST_BINS + k] /= sum;
  }
  return out;
}

/** One histogram out of the packed array. */
export function histogramOf(all: Float32Array | undefined, target: HistTarget, chan: "l" | "r" | "g" | "b"): Float32Array | undefined {
  if (!all || all.length < HIST_TARGETS.length * 4 * HIST_BINS) return undefined;
  if (!all) return undefined;
  const t = HIST_TARGETS.indexOf(target), c = ["l", "r", "g", "b"].indexOf(chan);
  const h = all.subarray((t * CH + c) * HIST_BINS, (t * CH + c + 1) * HIST_BINS);
  return h.some((v) => v > 0) ? h : undefined;
}

/** Share of the frame (percent) of each region at each distance — soft, as the renderer weighs cells. */
export function cellCoverage(
  seg: { width: number; height: number; probs: Float32Array },
  dist: { w: number; h: number; data: Float32Array },
  bands: [number, number],
): Record<string, number> {
  const plane = seg.width * seg.height, f = 0.06;
  const acc = new Float64Array(GROUPS.length * 3);
  let n = 0;
  for (let y = 0; y < dist.h; y += 2) for (let x = 0; x < dist.w; x += 2) {
    const d = dist.data[y * dist.w + x];
    const wn = 1 - smooth(bands[0] - f, bands[0] + f, d), wf = smooth(bands[1] - f, bands[1] + f, d);
    const wb = [wn, Math.max(0, 1 - wn - wf), wf];
    const k = Math.min(seg.height - 1, Math.floor((y / dist.h) * seg.height)) * seg.width + Math.min(seg.width - 1, Math.floor((x / dist.w) * seg.width));
    for (let g = 0; g < GROUPS.length; g++) {
      const p = seg.probs[g * plane + k];
      if (p > 0.01) for (let b = 0; b < 3; b++) acc[g * 3 + b] += p * wb[b];
    }
    n++;
  }
  const out: Record<string, number> = {};
  GROUPS.forEach((g, gi) => BANDS.forEach((b, bi) => { out[`${g}.${b}`] = Math.round((acc[gi * 3 + bi] / Math.max(n, 1)) * 1000) / 10; }));
  return out;
}
