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

export const HIST_TARGETS = ["photo", ...GROUPS, "skin", "near", "middle", "far"] as const;
export type HistTarget = (typeof HIST_TARGETS)[number];
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
  const add = (t: number, w8: number, v: number[]) => {
    const base = t * CH * HIST_BINS;
    for (let c = 0; c < CH; c++) out[base + c * HIST_BINS + Math.min(HIST_BINS - 1, v[c] >> 2)] += w8;
  };
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      const i = (y * w + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const l = Math.round(0.2290 * r + 0.6917 * g + 0.0793 * b);
      const v = [l, r, g, b];
      add(0, 1, v);
      if (seg) {
        const sx = Math.min(seg.width - 1, Math.floor((x / w) * seg.width)), sy = Math.min(seg.height - 1, Math.floor((y / h) * seg.height));
        const k = sy * seg.width + sx;
        for (let gi = 0; gi < GROUPS.length; gi++) {
          const p = seg.probs[gi * plane + k];
          if (p > 0.05) add(1 + gi, p, v);
        }
        const warm = r > g && g > b && r - b > 15 ? 1 : 0;
        const sk = seg.probs[person * plane + k] * warm;
        if (sk > 0.05) add(1 + GROUPS.length, sk, v);
      }
      if (dist) {
        const dx = Math.min(dist.w - 1, Math.floor((x / w) * dist.w)), dy = Math.min(dist.h - 1, Math.floor((y / h) * dist.h));
        const d = dist.data[dy * dist.w + dx];
        const wn = 1 - smooth(bands[0] - f, bands[0] + f, d), wf = smooth(bands[1] - f, bands[1] + f, d), wm = Math.max(0, 1 - wn - wf);
        const t0 = 2 + GROUPS.length;
        if (wn > 0.05) add(t0, wn, v);
        if (wm > 0.05) add(t0 + 1, wm, v);
        if (wf > 0.05) add(t0 + 2, wf, v);
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
  if (!all) return undefined;
  const t = HIST_TARGETS.indexOf(target), c = ["l", "r", "g", "b"].indexOf(chan);
  const h = all.subarray((t * CH + c) * HIST_BINS, (t * CH + c + 1) * HIST_BINS);
  return h.some((v) => v > 0) ? h : undefined;
}
