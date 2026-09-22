/**
 * Palette and colour-statistics analysis in OkLab.
 *
 * Input: display-encoded Display P3 RGBA8 pixels (a small rendering), with an
 * optional per-pixel weight (e.g. to exclude people). Output: dominant
 * palette (k-means, deterministic), hue distribution, saturation statistics,
 * shadow/midtone/highlight palettes and colour tendencies, warm/cool balance,
 * tone quantiles. Used for display, for building profiles from a reference
 * image and for look matching — never to force an image toward its palette.
 */
import { linSrgbToOklab, oklabToLinSrgb } from "../color/oklab.ts";
import { mulVec } from "../color/mat3.ts";
import { P3_TO_SRGB } from "../color/spaces.ts";
import { HUE_CENTRES, HUE_RANGES, type HueRange } from "./profile.ts";

export interface Swatch { lab: [number, number, number]; hex: string; weight: number }

export interface ZoneStats { L: number; a: number; b: number; C: number; weight: number; palette: Swatch[] }

export interface ColorStats {
  n: number;
  palette: Swatch[];
  /** 36 bins of 10°, chroma-weighted, normalised. */
  hueHist: number[];
  meanC: number;
  cQuantiles: { p50: number; p90: number; p99: number };
  zones: { shadows: ZoneStats; midtones: ZoneStats; highlights: ZoneStats };
  /** −1 (all cool) … +1 (all warm), chroma-weighted. */
  warmCool: number;
  /** Encoded-luma quantiles (display 0..1). */
  lumQ: Record<"p01" | "p05" | "p10" | "p25" | "p50" | "p75" | "p90" | "p95" | "p99", number>;
  /** Per hue range: weight share, mean hue offset from the centre (deg), mean chroma, mean L. */
  ranges: Record<HueRange, { weight: number; hueOffset: number; C: number; L: number }>;
  /** Mean OkLab of the whole image. */
  mean: [number, number, number];
}

const eotf = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const oetf = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055);
const EOTF8 = Float32Array.from({ length: 256 }, (_, i) => eotf(i / 255));

export function labToHex(lab: readonly number[]): string {
  const s = oklabToLinSrgb(lab).map((v) => Math.round(Math.min(1, Math.max(0, oetf(v))) * 255));
  return "#" + s.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** Converts P3-encoded RGBA8 to OkLab samples (subsampled to at most `max`). */
export function toLab(rgba: Uint8Array | Uint8ClampedArray, max = 40000, weights?: Float32Array): { lab: Float32Array; w: Float32Array; Y: Float32Array } {
  const n = rgba.length / 4;
  const step = Math.max(1, Math.floor(n / max));
  const m = Math.floor(n / step);
  const lab = new Float32Array(m * 3), w = new Float32Array(m), Y = new Float32Array(m);
  for (let i = 0, j = 0; j < m; i += step, j++) {
    const p3 = [EOTF8[rgba[i * 4]], EOTF8[rgba[i * 4 + 1]], EOTF8[rgba[i * 4 + 2]]];
    const l = linSrgbToOklab(mulVec(P3_TO_SRGB, p3));
    lab[j * 3] = l[0]; lab[j * 3 + 1] = l[1]; lab[j * 3 + 2] = l[2];
    w[j] = weights ? weights[i] : 1;
    Y[j] = oetf(0.2289746 * p3[0] + 0.6917385 * p3[1] + 0.0792869 * p3[2]);
  }
  return { lab, w, Y };
}

/** Deterministic weighted k-means (k-means++ seeding with a fixed LCG). */
export function kmeans(lab: Float32Array, w: Float32Array, k: number, iters = 12): Swatch[] {
  const n = w.length;
  if (!n) return [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  // Chroma is weighted up slightly so colourful minorities are not swallowed by greys.
  const dist = (i: number, c: number[]) => (lab[i * 3] - c[0]) ** 2 + 1.6 * ((lab[i * 3 + 1] - c[1]) ** 2 + (lab[i * 3 + 2] - c[2]) ** 2);
  let best = 0;
  for (let i = 1; i < n; i++) if (w[i] > w[best]) best = i;
  const cs: number[][] = [[lab[best * 3], lab[best * 3 + 1], lab[best * 3 + 2]]];
  const d2 = new Float64Array(n).fill(Infinity);
  while (cs.length < k) {
    let sum = 0;
    const c = cs[cs.length - 1];
    for (let i = 0; i < n; i++) { d2[i] = Math.min(d2[i], dist(i, c)); sum += d2[i] * w[i]; }
    if (sum <= 0) break;
    let r = rnd() * sum, i = 0;
    for (; i < n - 1; i++) { r -= d2[i] * w[i]; if (r <= 0) break; }
    cs.push([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]]);
  }
  const assign = new Int32Array(n);
  for (let it = 0; it < iters; it++) {
    const acc = cs.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      let bi = 0, bd = Infinity;
      for (let j = 0; j < cs.length; j++) { const d = dist(i, cs[j]); if (d < bd) { bd = d; bi = j; } }
      assign[i] = bi;
      const a = acc[bi];
      a[0] += w[i] * lab[i * 3]; a[1] += w[i] * lab[i * 3 + 1]; a[2] += w[i] * lab[i * 3 + 2]; a[3] += w[i];
    }
    for (let j = 0; j < cs.length; j++) if (acc[j][3] > 0) cs[j] = [acc[j][0] / acc[j][3], acc[j][1] / acc[j][3], acc[j][2] / acc[j][3]];
  }
  const wsum = w.reduce((a, b) => a + b, 0) || 1;
  const cw = cs.map(() => 0);
  for (let i = 0; i < n; i++) cw[assign[i]] += w[i];
  return cs
    .map((c, j) => ({ lab: c as [number, number, number], hex: labToHex(c), weight: cw[j] / wsum }))
    .filter((s) => s.weight > 0.005)
    .sort((a, b) => b.weight - a.weight);
}

const hueDeg = (a: number, b: number) => ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
const hdiff = (a: number, b: number) => { let d = a - b; d -= 360 * Math.floor((d + 180) / 360); return d; };

function zoneOf(L: number): 0 | 1 | 2 { return L < 0.45 ? 0 : L > 0.78 ? 2 : 1; }

export function analyseColors(rgba: Uint8Array | Uint8ClampedArray, weights?: Float32Array, k = 6): ColorStats {
  const { lab, w, Y } = toLab(rgba, 40000, weights);
  const n = w.length;
  const hueHist = new Array(36).fill(0);
  const cs: number[] = [];
  let wsum = 0, cws = 0, warm = 0, cool = 0;
  const mean = [0, 0, 0];
  const zAcc = [0, 1, 2].map(() => ({ L: 0, a: 0, b: 0, C: 0, w: 0, idx: [] as number[] }));
  const rAcc = Object.fromEntries(HUE_RANGES.map((r) => [r, { w: 0, off: 0, C: 0, L: 0 }])) as Record<HueRange, { w: number; off: number; C: number; L: number }>;
  for (let i = 0; i < n; i++) {
    const L = lab[i * 3], a = lab[i * 3 + 1], b = lab[i * 3 + 2], wi = w[i];
    if (wi <= 0) continue;
    const C = Math.hypot(a, b);
    const h = hueDeg(a, b);
    wsum += wi;
    mean[0] += wi * L; mean[1] += wi * a; mean[2] += wi * b;
    cs.push(C);
    const z = zAcc[zoneOf(L)];
    z.L += wi * L; z.a += wi * a; z.b += wi * b; z.C += wi * C; z.w += wi; z.idx.push(i);
    if (C > 0.02) {
      const cwt = wi * C;
      hueHist[Math.floor(h / 10) % 36] += cwt;
      cws += cwt;
      if (h < 110 || h > 340) warm += cwt; else if (h > 150 && h < 290) cool += cwt;
      // Nearest hue range.
      let best: HueRange = "red", bd = 999;
      for (const r of HUE_RANGES) { const d = Math.abs(hdiff(h, HUE_CENTRES[r])); if (d < bd) { bd = d; best = r; } }
      const ra = rAcc[best];
      ra.w += cwt; ra.off += cwt * hdiff(h, HUE_CENTRES[best]); ra.C += cwt * C; ra.L += cwt * L;
    }
  }
  cs.sort((x, y) => x - y);
  const q = (arr: ArrayLike<number>, p: number) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))] : 0;
  const Ys = Array.from(Y).sort((x, y) => x - y);
  const zone = (z: (typeof zAcc)[number]): ZoneStats => {
    const sub = new Float32Array(z.idx.length * 3), sw = new Float32Array(z.idx.length);
    z.idx.forEach((i, j) => { sub[j * 3] = lab[i * 3]; sub[j * 3 + 1] = lab[i * 3 + 1]; sub[j * 3 + 2] = lab[i * 3 + 2]; sw[j] = w[i]; });
    const d = z.w || 1;
    return { L: z.L / d, a: z.a / d, b: z.b / d, C: z.C / d, weight: z.w / (wsum || 1), palette: kmeans(sub, sw, 3, 8) };
  };
  const ranges = Object.fromEntries(HUE_RANGES.map((r) => {
    const a = rAcc[r];
    return [r, { weight: cws ? a.w / cws : 0, hueOffset: a.w ? a.off / a.w : 0, C: a.w ? a.C / a.w : 0, L: a.w ? a.L / a.w : 0 }];
  })) as ColorStats["ranges"];
  return {
    n,
    palette: kmeans(lab, w, k),
    hueHist: hueHist.map((v) => (cws ? v / cws : 0)),
    meanC: cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : 0,
    cQuantiles: { p50: q(cs, 0.5), p90: q(cs, 0.9), p99: q(cs, 0.99) },
    zones: { shadows: zone(zAcc[0]), midtones: zone(zAcc[1]), highlights: zone(zAcc[2]) },
    warmCool: warm + cool > 0 ? (warm - cool) / (warm + cool) : 0,
    lumQ: { p01: q(Ys, 0.01), p05: q(Ys, 0.05), p10: q(Ys, 0.1), p25: q(Ys, 0.25), p50: q(Ys, 0.5), p75: q(Ys, 0.75), p90: q(Ys, 0.9), p95: q(Ys, 0.95), p99: q(Ys, 0.99) },
    ranges,
    mean: wsum ? [mean[0] / wsum, mean[1] / wsum, mean[2] / wsum] : [0, 0, 0],
  };
}

export const PALETTE_HELPERS = { hueDeg, hdiff, eotf, oetf };
