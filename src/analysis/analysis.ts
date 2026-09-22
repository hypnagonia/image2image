/**
 * Module: Scene Analysis (image statistics).
 *
 *   in:  working texture (full res), refined maps (guide res)
 *   out: AnalysisReport — global and per-region measurements that feed the
 *        decision engine. Heavy lifting is on the GPU (blocks.wgsl at full
 *        resolution, stats.wgsl at guide resolution); this file only turns
 *        sums into numbers.
 */
import { Gpu, Uniforms } from "../gpu/gpu.ts";
import blocksWgsl from "../gpu/shaders/blocks.wgsl?raw";
import statsWgsl from "../gpu/shaders/stats.wgsl?raw";
import { GROUPS, type Group } from "../neural/scene.ts";
import type { RefinedMaps } from "../refine/refine.ts";
import type { AnalysisReport, BlockGrid, BlurReport, NoiseProfile, RegionStats } from "./types.ts";

export const BLOCK = 32;

export async function measureBlocks(gpu: Gpu, tex: GPUTexture, w: number, h: number, gain: number, edgeThr: number): Promise<BlockGrid> {
  const bw = Math.ceil(w / BLOCK), bh = Math.ceil(h / BLOCK);
  const out = gpu.buf("blocks", bw * bh * 16 * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  await gpu.run("blocks", (enc, temp) => {
    const u = gpu.uniform(new Uniforms(8).u32(w, h, bw, bh).f32(gain, edgeThr, 0, 0).bytes());
    temp.push(u);
    gpu.dispatch(enc, gpu.pipeline("blocks", blocksWgsl), [u, tex.createView(), out], bw, bh);
  });
  const data = new Float32Array(await gpu.readBuffer(out, bw * bh * 16 * 4));
  gpu.release(out);
  return { bw, bh, size: BLOCK, data };
}

function quantile(sorted: ArrayLike<number>, q: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

/**
 * Noise σ per encoded-luma bin: the 15th percentile of block estimates, so that
 * texture (which inflates the Immerkaer estimate) is not mistaken for noise.
 * Blocks that are clipped or nearly black are excluded.
 */
export function noiseProfile(g: BlockGrid): NoiseProfile {
  const nb = 8;
  const buckets: Array<{ s: number[]; c: number[] }> = Array.from({ length: nb }, () => ({ s: [], c: [] }));
  const all: number[] = [];
  const allC: number[] = [];
  for (let i = 0; i < g.bw * g.bh; i++) {
    const r = g.data.subarray(i * 16, i * 16 + 16);
    if (r[15] < 64 || r[6] > 0.02) continue;
    const y = r[0];
    if (y < 0.01 || y > 0.97) continue;
    const b = Math.min(nb - 1, Math.floor(y * nb));
    buckets[b].s.push(r[1]);
    buckets[b].c.push(r[2]);
    all.push(r[1]);
    allC.push(r[2]);
  }
  const bins = buckets.map((b, i) => {
    b.s.sort((x, y) => x - y);
    b.c.sort((x, y) => x - y);
    return { y: (i + 0.5) / nb, sigma: quantile(b.s, 0.15), sigmaC: quantile(b.c, 0.15), blocks: b.s.length };
  });
  all.sort((a, b) => a - b);
  allC.sort((a, b) => a - b);
  const valid = bins.filter((b) => b.blocks >= 4);
  const pick = (lo: number, hi: number) => {
    const v = valid.filter((b) => b.y >= lo && b.y < hi).map((b) => b.sigma);
    return v.length ? v.reduce((a, b) => a + b) / v.length : quantile(all, 0.15);
  };
  return {
    bins,
    mid: pick(0.3, 0.8) || 0,
    shadow: pick(0.0, 0.3) || 0,
    chroma: quantile(allC, 0.15) || 0,
  };
}

/** Estimated noise σ at encoded luma y (linear interpolation between valid bins). */
export function noiseAt(n: NoiseProfile, y: number): number {
  const v = n.bins.filter((b) => b.blocks >= 4 && Number.isFinite(b.sigma));
  if (!v.length) return n.mid;
  if (y <= v[0].y) return v[0].sigma;
  for (let i = 1; i < v.length; i++) {
    if (y <= v[i].y) {
      const t = (y - v[i - 1].y) / (v[i].y - v[i - 1].y);
      return v[i - 1].sigma * (1 - t) + v[i].sigma * t;
    }
  }
  return v[v.length - 1].sigma;
}

export const BLUR_THRESHOLD = 1.6; // px; above this a block counts as blurred

export function blurReport(g: BlockGrid, noise: NoiseProfile): BlurReport {
  const per = new Float32Array(g.bw * g.bh).fill(NaN);
  const vals: number[] = [];
  let blurred = 0;
  for (let i = 0; i < g.bw * g.bh; i++) {
    const r = g.data.subarray(i * 16, i * 16 + 16);
    const n = r[11];
    if (n < 24) continue;
    const s = noiseAt(noise, r[0]);
    const G = r[9] / n - s * s;
    const L = r[10] / n - 20 * s * s;
    if (G <= 1e-8) continue;
    const ratio = Math.sqrt(Math.max(L, 0) / G);
    const sigma = ratio > 1e-3 ? Math.min(8, 0.7 / ratio) : 8;
    per[i] = sigma;
    vals.push(sigma);
    if (sigma > BLUR_THRESHOLD) blurred++;
  }
  vals.sort((a, b) => a - b);
  return { perBlock: per, median: quantile(vals, 0.5), blurredFraction: vals.length ? blurred / vals.length : 0, edgeBlocks: vals.length };
}

export interface RegionRaw {
  regions: Record<Group | "global", RegionStats>;
  histLum: number[];
  histRGB: [number[], number[], number[]];
  atmosphere: AnalysisReport["atmosphere"];
}

export async function measureRegions(gpu: Gpu, r: RefinedMaps, gain: number): Promise<RegionRaw> {
  const gx = Math.ceil(r.w / 32), gy = Math.ceil(r.h / 32);
  const nG = 12;
  const partBytes = gx * gy * 16 * 4;
  const parts = gpu.buf("stats.part", partBytes * nG, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
  const HIST = 1152 + 11 * 32;
  const hist = gpu.buf("stats.hist", HIST * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
  const pipe = gpu.pipeline("stats", statsWgsl);
  // Each region writes to its own slice; bind the whole buffer with an offset per dispatch.
  await gpu.run("stats", (enc, temp) => {
    enc.clearBuffer(hist);
    for (let g = 0; g < nG; g++) {
      const u = gpu.uniform(new Uniforms(8).u32(r.w, r.h, g, gx).f32(gain, 0, 0, 0).bytes());
      temp.push(u);
      const slice = gpu.buf("stats.slice", partBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      temp.push(slice);
      gpu.dispatch(enc, pipe, [u, r.lin.createView(), r.guide.createView(), r.masks[0].createView(), r.masks[1].createView(), r.masks[2].createView(), r.toneM.createView(), slice, hist], gx, gy);
      enc.copyBufferToBuffer(slice, 0, parts, g * partBytes, partBytes);
    }
  });
  const P = new Float32Array(await gpu.readBuffer(parts, partBytes * nG));
  const H = new Uint32Array(await gpu.readBuffer(hist, HIST * 4));
  gpu.release(parts, hist);
  const total = r.w * r.h;
  const region = (g: number): RegionStats => {
    const s = new Float64Array(16);
    for (let i = 0; i < gx * gy; i++) for (let k = 0; k < 16; k++) s[k] += P[g * gx * gy * 16 + i * 16 + k];
    const w = Math.max(s[0], 1e-9);
    const mean = s[1] / w;
    const dm = s[12] / w;
    const hist = new Array(32).fill(0);
    if (g < 11) {
      let hs = 0;
      for (let b = 0; b < 32; b++) { hist[b] = H[1152 + g * 32 + b]; hs += hist[b]; }
      for (let b = 0; b < 32; b++) hist[b] /= hs || 1;
    }
    return {
      area: s[0] / total,
      meanEV: mean,
      sdEV: Math.sqrt(Math.max(0, s[2] / w - mean * mean)),
      meanY: s[3] / w,
      rgb: [s[4] / w, s[5] / w, s[6] / w],
      chroma: s[7] / w,
      clipHi: s[8] / w,
      clipLo: s[9] / w,
      localContrast: s[10] / w,
      texture: s[11] / w,
      dist: dm,
      distSd: Math.sqrt(Math.max(0, s[13] / w - dm * dm)),
      darkChannel: s[14] / w,
      meanYe: s[15] / w,
      hist,
    };
  };
  const regions = {} as Record<Group | "global", RegionStats>;
  GROUPS.forEach((g, i) => (regions[g] = region(i)));
  regions.global = region(11);
  const norm = (a: ArrayLike<number>) => { const s = Array.from(a).reduce((x, y) => x + y, 0) || 1; return Array.from(a, (x) => x / s); };
  const histLum = norm(H.subarray(0, 128));
  regions.global.hist = Array.from({ length: 32 }, (_, i) => histLum.slice(i * 4, i * 4 + 4).reduce((a, b) => a + b));
  const histRGB: [number[], number[], number[]] = [norm(H.subarray(128, 384)), norm(H.subarray(384, 640)), norm(H.subarray(640, 896))];
  // Atmospheric light: mean colour of the brightest 0.1% of the dark channel.
  const dc = H.subarray(896, 960);
  const dcTotal = dc.reduce((a, b) => a + b, 0) || 1;
  let acc = 0, dcP99 = 1, dcMedian = 0.5;
  const light = [0, 0, 0];
  let lightN = 0;
  for (let b = 63; b >= 0; b--) {
    if (acc < dcTotal * 0.001 || lightN === 0) {
      light[0] += H[960 + b * 3] / 256; light[1] += H[961 + b * 3] / 256; light[2] += H[962 + b * 3] / 256;
      lightN += dc[b];
    }
    acc += dc[b];
    if (acc >= dcTotal * 0.01 && dcP99 === 1) dcP99 = (b + 0.5) / 64;
  }
  let acc2 = 0;
  for (let b = 0; b < 64; b++) { acc2 += dc[b]; if (acc2 >= dcTotal * 0.5) { dcMedian = (b + 0.5) / 64; break; } }
  const n = Math.max(1, lightN);
  return { regions, histLum, histRGB, atmosphere: { light: [light[0] / n, light[1] / n, light[2] / n], dcP99, dcMedian } };
}

/** Scene-luminance percentiles from the 128-bin log histogram. */
export function lumPercentiles(hist: number[]): AnalysisReport["lum"] {
  const at = (q: number) => {
    let a = 0;
    for (let i = 0; i < hist.length; i++) {
      a += hist[i];
      if (a >= q) return Math.pow(2, -14 + ((i + 0.5) / 128) * 18);
    }
    return Math.pow(2, 4);
  };
  return { p01: at(0.01), p05: at(0.05), p50: at(0.5), p95: at(0.95), p99: at(0.99), p999: at(0.999) };
}
