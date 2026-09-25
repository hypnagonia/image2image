/**
 * Modules: Semantic Segmentation (SegFormer-B0, ADE20K) and Depth Estimation
 * (Depth Anything V2 Small).
 *
 *   in:  analysis image — the working image area-averaged to ≤ 768 px on the
 *        long edge and display-encoded (never the 12/24/48 MP original)
 *   out: SceneMaps — 11 soft group probabilities + relative distance, at the
 *        networks' native output resolution, as Float32 planes (CPU) — they
 *        are small (≈ 128×96 and 518×392) and are uploaded and refined on the
 *        GPU by src/refine/.
 */
import type { Backend, Neural } from "./ort.ts";
import { MODELS, ort } from "./ort.ts";

export const GROUPS = ["sky", "vegetation", "building", "ground", "terrain", "water", "person", "vehicle", "animal", "interior", "other"] as const;
export type Group = (typeof GROUPS)[number];
export const NG = GROUPS.length;

/** ADE20K class index → group index. Classes not listed fall into "other". */
const ADE_GROUPS: Record<Group, number[]> = {
  sky: [2],
  vegetation: [4, 9, 17, 29, 66, 72],
  building: [0, 1, 25, 32, 38, 42, 48, 61, 79, 84, 86, 88, 106, 114],
  ground: [3, 6, 11, 52, 53, 54, 59, 91, 121],
  terrain: [13, 16, 34, 46, 68, 94],
  water: [21, 26, 60, 104, 109, 113, 128],
  person: [12],
  vehicle: [20, 76, 80, 83, 90, 102, 103, 116, 127],
  animal: [126],
  interior: [5, 7, 8, 10, 14, 15, 18, 19, 22, 23, 24, 27, 28, 30, 31, 33, 35, 36, 37, 39, 44, 45, 47, 49, 50, 56, 57, 58, 62, 63, 64, 65, 70, 71, 73, 75, 81, 85, 95, 96, 97, 99, 107, 110, 117, 118, 124, 129, 131, 133, 134, 139, 145, 146],
  other: [],
};
const ADE_TO_GROUP = (() => {
  const t = new Uint8Array(150).fill(GROUPS.indexOf("other"));
  GROUPS.forEach((g, gi) => { for (const c of ADE_GROUPS[g]) t[c] = gi; });
  return t;
})();

export interface AnalysisImage {
  /** Display-encoded RGB, 0..1, interleaved RGBA float32. */
  rgba: Float32Array;
  width: number;
  height: number;
}

export interface SceneMaps {
  seg: { width: number; height: number; probs: Float32Array /* NG planes */ };
  depth: { width: number; height: number; dist: Float32Array /* 0 near … 1 far */; raw: Float32Array; /** No depth could be computed: everything reads as one distance. */ flat?: boolean };
  /** Area share of each group (argmax), for the log. */
  coverage: Record<Group, number>;
  timings: Record<string, number>;
  log: string[];
}

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/**
 * NCHW tensor(s) for crops of the analysis image: each crop [x0, y0, cw, ch]
 * is resampled (bilinear) to outW×outH and ImageNet-normalised. Several crops
 * of the same output size are packed into one batch.
 */
function cropsTensor(img: AnalysisImage, crops: Array<[number, number, number, number]>, outW: number, outH: number): Float32Array {
  const plane = outW * outH;
  const out = new Float32Array(crops.length * 3 * plane);
  crops.forEach(([cx, cy, cw, ch], n) => {
    const sx = cw / outW, sy = ch / outH;
    for (let y = 0; y < outH; y++) {
      const fy = Math.min(img.height - 1, Math.max(0, cy + (y + 0.5) * sy - 0.5));
      const y0 = Math.floor(fy), y1 = Math.min(img.height - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < outW; x++) {
        const fx = Math.min(img.width - 1, Math.max(0, cx + (x + 0.5) * sx - 0.5));
        const x0 = Math.floor(fx), x1 = Math.min(img.width - 1, x0 + 1), tx = fx - x0;
        for (let c = 0; c < 3; c++) {
          const a = img.rgba[(y0 * img.width + x0) * 4 + c], b = img.rgba[(y0 * img.width + x1) * 4 + c];
          const d = img.rgba[(y1 * img.width + x0) * 4 + c], e = img.rgba[(y1 * img.width + x1) * 4 + c];
          const v = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
          out[n * 3 * plane + c * plane + y * outW + x] = (v - MEAN[c]) / STD[c];
        }
      }
    }
  });
  return out;
}

/** Tile origins along one axis: first at 0, last flush with the end. */
function tilePositions(n: number, tile: number, stride: number): number[] {
  if (n <= tile) return [0];
  const out: number[] = [];
  for (let p = 0; p + tile < n; p += stride) out.push(p);
  out.push(n - tile);
  return out;
}

/**
 * Gaussian-like blur of a single-channel image: three running box passes per
 * axis (cost independent of σ — matters on phones at analysis resolution).
 */
function gaussBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  // Box width for three passes approximating σ: w = sqrt(12σ²/3 + 1).
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  let a = Float32Array.from(src), b = new Float32Array(w * h);
  const pass = (from: Float32Array, to: Float32Array, n: number, lines: number, stride: number, step: number) => {
    const inv = 1 / (2 * r + 1);
    for (let l = 0; l < lines; l++) {
      const o = l * stride;
      const at = (i: number) => from[o + Math.min(n - 1, Math.max(0, i)) * step];
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += at(i);
      for (let i = 0; i < n; i++) {
        to[o + i * step] = acc * inv;
        acc += at(i + r + 1) - at(i - r);
      }
    }
  };
  for (let k = 0; k < 3; k++) { pass(a, b, w, h, w, 1); [a, b] = [b, a]; }
  for (let k = 0; k < 3; k++) { pass(a, b, h, w, 1, w); [a, b] = [b, a]; }
  return a;
}

/**
 * Snap depth edges to object outlines (people, animals, vehicles).
 *
 * Monocular depth draws an object's silhouette as a ramp several pixels wide,
 * so a rim of background next to a face inherits the face's distance (a sharp
 * halo in simulated depth of field) — and the guided filter can move an edge a
 * few pixels, not rebuild it. Segmentation outlines objects much more crisply.
 * Around each object the local object depth (inside) and background depth
 * (outside) are estimated by normalised convolution, and pixels whose depth
 * lies on the ramp between them are assigned to their side of the outline.
 * Values outside the ramp (a hand nearer than the body, a sofa arm in front)
 * are left alone, so this only ever removes the blend.
 * dist: 0 = near … 1 = far. prob: object probability at w×h.
 */
function snapToObject(dist: Float32Array, prob: Float32Array, w: number, h: number): number {
  const N = w * h;
  const sigma = Math.max(4, Math.max(w, h) * 0.012);
  const mIn = new Float32Array(N), mOut = new Float32Array(N), dIn = new Float32Array(N), dOut = new Float32Array(N);
  let inside = 0;
  for (let k = 0; k < N; k++) {
    if (prob[k] > 0.8) { mIn[k] = 1; dIn[k] = dist[k]; inside++; }
    else if (prob[k] < 0.2) { mOut[k] = 1; dOut[k] = dist[k]; }
  }
  if (inside < N * 0.002) return 0;
  const [wi, di, wo, dO] = [gaussBlur(mIn, w, h, sigma), gaussBlur(dIn, w, h, sigma), gaussBlur(mOut, w, h, sigma), gaussBlur(dOut, w, h, sigma)];
  let changed = 0;
  for (let k = 0; k < N; k++) {
    if (wi[k] < 0.02 || wo[k] < 0.02) continue; // not near an outline
    const zi = di[k] / wi[k], zo = dO[k] / wo[k];
    if (zo - zi < 0.03) continue; // background not clearly behind the object here
    const d = dist[k];
    if (d <= zi || d >= zo) continue; // not on the ramp
    const t = Math.min(1, Math.max(0, (prob[k] - 0.35) / 0.3));
    const s = t * t * (3 - 2 * t);
    dist[k] = s * zi + (1 - s) * zo;
    changed++;
  }
  return changed / N;
}

/** Bilinear resample of a single-channel map to w×h. */
function resample(src: Float32Array, sw: number, sh: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / h - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / w - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      out[y * w + x] = (src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx) * (1 - ty) + (src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx) * ty;
    }
  }
  return out;
}

/** Feather weight: 1 in the middle of a tile, ramping to a small value at its edges. */
const feather = (i: number, n: number, ramp: number) => Math.max(0.02, Math.min(1, (i + 0.5) / ramp, (n - i - 0.5) / ramp));

function fitDims(w: number, h: number, long: number, multiple: number): [number, number] {
  const s = long / Math.max(w, h);
  const rw = Math.max(multiple, Math.round((w * s) / multiple) * multiple);
  const rh = Math.max(multiple, Math.round((h * s) / multiple) * multiple);
  return [rw, rh];
}

function percentile(a: Float32Array, q: number): number {
  const s = Float32Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

/**
 * Runs `fn` on the first backend that works: `prefer` first, then WASM (a phone's
 * WebGPU can fail on a network: memory, unsupported operators). Undefined when
 * every backend failed; each failure is logged.
 */
async function firstWorking<T>(neural: Neural, prefer: Backend, what: string, log: string[], fn: (b: Backend) => Promise<T>): Promise<T | undefined> {
  const order: Backend[] = prefer === "webgpu" && neural.backend === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
  for (const b of order) {
    try {
      const r = await fn(b);
      if (b !== neural.backend) log.push(`${what} ran on WASM`);
      return r;
    } catch (e) {
      log.push(`${what} on ${b} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return undefined;
}

/** A session that is released however the work ends. */
async function withSession<T>(neural: Neural, spec: Parameters<Neural["session"]>[0], backend: Backend, fn: (s: Awaited<ReturnType<Neural["session"]>>) => Promise<T>): Promise<T> {
  const ses = await neural.session(spec, false, backend);
  try { return await fn(ses); } finally { await ses.release().catch(() => undefined); }
}

/**
 * `prefer`: the backend to try first for both networks ("wasm" after the page
 * crashed during analysis on this device).
 */
export async function analyseScene(neural: Neural, img: AnalysisImage, onStage?: (s: string) => void, withDepth = true, detailTiles = true, prefer: Backend = neural.backend): Promise<SceneMaps> {
  const timings: Record<string, number> = {};
  const log: string[] = [];

  // --- SegFormer-B0 ------------------------------------------------------
  onStage?.("segmentation");
  let t = performance.now();
  // Sliding window (the standard way to run SegFormer on a large image): 512 px
  // crops with 25% overlap over the ~1036 px analysis image, logits blended
  // with feathered weights. Twice the resolution of a single squeezed pass,
  // at the object scale the model was trained on.
  const W = img.width, H = img.height;
  const CROP = 512, STRIDE = 384;
  const cw = W >= CROP ? CROP : Math.max(32, Math.floor(W / 32) * 32);
  const chh = H >= CROP ? CROP : Math.max(32, Math.floor(H / 32) * 32);
  const crops: Array<[number, number, number, number]> = [];
  for (const y of tilePositions(H, chh, STRIDE)) for (const x of tilePositions(W, cw, STRIDE)) crops.push([x, y, Math.min(cw, W), Math.min(chh, H)]);
  // Crops run one at a time (not as a batch): peak GPU memory stays that of a
  // single 512 px pass, which matters on phones.
  const lw = Math.floor(W / 4), lh = Math.floor(H / 4);
  const seg = await firstWorking(neural, prefer, "Segmentation", log, (backend) => withSession(neural, MODELS.segformer, backend, async (segSession) => {
    t = performance.now();
    let C = 0;
    let L = new Float32Array(0);
    const wsumL = new Float32Array(lw * lh);
    for (const [x0, y0, cwid, chei] of crops) {
      const segIn = new ort.Tensor("float32", cropsTensor(img, [[x0, y0, cwid, chei]], cw, chh), [1, 3, chh, cw]);
      const segOut = await segSession.run({ [segSession.inputNames[0]]: segIn });
      const logitsT = segOut[segSession.outputNames[0]];
      const dims = logitsT.dims as number[];
      const clh = dims[2], clw = dims[3];
      if (!C) { C = dims[1]; L = new Float32Array(C * lw * lh); }
      const CL = (await logitsT.getData()) as Float32Array;
      logitsT.dispose();
      const cplane = clw * clh;
      const ox = Math.round(x0 / 4), oy = Math.round(y0 / 4);
      const sx = cwid / 4 / clw, sy = chei / 4 / clh;
      for (let j = 0; j < clh; j++) for (let i = 0; i < clw; i++) {
        const X = ox + Math.round(i * sx), Y = oy + Math.round(j * sy);
        if (X >= lw || Y >= lh) continue;
        const w = feather(i, clw, clw * 0.2) * feather(j, clh, clh * 0.2);
        const k = Y * lw + X;
        wsumL[k] += w;
        for (let c = 0; c < C; c++) L[c * lw * lh + k] += w * CL[c * cplane + j * clw + i];
      }
    }
    timings["segformer.run"] = performance.now() - t;
    return { C, L, wsumL };
  }));
  if (!seg) throw new Error("Scene analysis failed (segmentation could not run on this device)");
  const { C, wsumL } = seg;
  let L: Float32Array = seg.L;
  for (let k = 0; k < lw * lh; k++) {
    const iw = wsumL[k] > 0 ? 1 / wsumL[k] : 0;
    for (let c = 0; c < C; c++) L[c * lw * lh + k] *= iw;
  }
  const sw = cw, sh = chh;
  const probs = new Float32Array(NG * lw * lh);
  const counts = new Float64Array(NG);
  const plane = lw * lh;
  for (let i = 0; i < plane; i++) {
    let mx = -Infinity;
    for (let c = 0; c < C; c++) mx = Math.max(mx, L[c * plane + i]);
    let sum = 0;
    const g = new Float32Array(NG);
    let best = 0, bestV = -1;
    for (let c = 0; c < C; c++) {
      const e = Math.exp(L[c * plane + i] - mx);
      sum += e;
      g[ADE_TO_GROUP[c]] += e;
    }
    for (let k = 0; k < NG; k++) {
      const v = g[k] / sum;
      probs[k * plane + i] = v;
      if (v > bestV) { bestV = v; best = k; }
    }
    counts[best]++;
  }
  L = new Float32Array(0); // 30 MB of logits: not needed during depth
  const coverage = Object.fromEntries(GROUPS.map((g, i) => [g, counts[i] / plane])) as Record<Group, number>;
  log.push(`SegFormer-B0 ${crops.length} × ${sw}×${sh} sliding window over ${W}×${H} → ${lw}×${lh}: ` + GROUPS.filter((g) => coverage[g] > 0.01).map((g) => `${g} ${(coverage[g] * 100).toFixed(0)}%`).join(", "));

  if (!withDepth) {
    return { seg: { width: lw, height: lh, probs }, depth: { width: 1, height: 1, dist: new Float32Array(1), raw: new Float32Array(1) }, coverage, timings, log };
  }
  // --- Depth Anything V2 Small --------------------------------------------
  onStage?.("depth");
  // The depth network is the heaviest step of opening a photo; phones' WebGPU can
  // fail on it (4-bit weights, memory). Then it runs on the CPU, and if that fails
  // too the photo opens without depth (flat distance) instead of breaking.
  const runDepth = (backend: Backend) => withSession(neural, MODELS.depth, backend, async (dSession) => {
    // Global pass: the whole scene at 518 px — correct layout and ordering.
    const [dw, dh] = fitDims(img.width, img.height, 518, 14);
    t = performance.now();
    const dIn = new ort.Tensor("float32", cropsTensor(img, [[0, 0, img.width, img.height]], dw, dh), [1, 3, dh, dw]);
    const dOut = await dSession.run({ [dSession.inputNames[0]]: dIn });
    const pd = dOut[dSession.outputNames[0]];
    const gDisp = Float32Array.from((await pd.getData()) as Float32Array);
    // A GPU that ran out of memory can return garbage instead of throwing.
    if (!gDisp.every(Number.isFinite) || percentile(gDisp, 0.98) - percentile(gDisp, 0.02) < 1e-6) throw new Error("depth output is not a depth map");
    const pdDims = pd.dims as number[];
    const gw = pdDims[pdDims.length - 1], gh = pdDims[pdDims.length - 2];
    timings["depth.global"] = performance.now() - t;
    // Detail tiles: 2×2 overlapping tiles at the analysis image's full resolution
    // (twice the global pass). Relative depth has an arbitrary scale per run, so
    // each tile is least-squares aligned to the global map and only its fine
    // detail (leaf gaps, branches, crisp outlines) is merged — the global pass
    // keeps deciding what is near and far.
    const W2 = img.width, H2 = img.height;
    const Gf = resample(gDisp, gw, gh, W2, H2);
    let disp = Gf;
    let ow = W2, oh = H2;
    if (detailTiles && Math.max(W2, H2) > 600) {
      t = performance.now();
      const tw = Math.min(W2, Math.ceil((W2 * 0.6) / 14) * 14), th = Math.min(H2, Math.ceil((H2 * 0.6) / 14) * 14);
      const tiles: Array<[number, number, number, number]> = [];
      for (const y of [0, H2 - th]) for (const x of [0, W2 - tw]) tiles.push([x, y, tw, th]);
      const detail = new Float32Array(W2 * H2), wsum = new Float32Array(W2 * H2);
      for (const [x0, y0] of tiles) {
        const tIn = new ort.Tensor("float32", cropsTensor(img, [[x0, y0, tw, th]], tw, th), [1, 3, th, tw]);
        const tOut = await dSession.run({ [dSession.inputNames[0]]: tIn });
        const tp = tOut[dSession.outputNames[0]];
        const tdims = tp.dims as number[];
        const otw = tdims[tdims.length - 1], oth = tdims[tdims.length - 2];
        const tile = resample((await tp.getData()) as Float32Array, otw, oth, tw, th);
        tp.dispose();
        // Least-squares scale/offset to the global disparity over the tile.
        let st = 0, sg = 0, stt = 0, stg = 0;
        const N = tw * th;
        for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
          const tv = tile[y * tw + x], gv = Gf[(y0 + y) * W2 + x0 + x];
          st += tv; sg += gv; stt += tv * tv; stg += tv * gv;
        }
        const vt = stt / N - (st / N) ** 2;
        const a = vt > 1e-9 ? (stg / N - (st / N) * (sg / N)) / vt : 0;
        const b = sg / N - a * (st / N);
        const aligned = tile.map((v) => a * v + b);
        // Fine detail only: σ ≈ 1% of the long edge.
        const low = gaussBlur(aligned, tw, th, Math.max(3, Math.max(W2, H2) * 0.01));
        for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
          const w = feather(x, tw, tw * 0.25) * feather(y, th, th * 0.25);
          const k = (y0 + y) * W2 + x0 + x;
          detail[k] += w * (aligned[y * tw + x] - low[y * tw + x]);
          wsum[k] += w;
        }
      }
      // Remove the same band from the global map so detail is replaced, not doubled.
      const gLow = gaussBlur(Gf, W2, H2, Math.max(3, Math.max(W2, H2) * 0.01));
      disp = new Float32Array(W2 * H2);
      for (let k = 0; k < W2 * H2; k++) disp[k] = wsum[k] > 0 ? gLow[k] + detail[k] / wsum[k] : Gf[k];
      timings["depth.tiles"] = performance.now() - t;
      log.push(`Depth detail: ${tiles.length} tiles ${tw}×${th} aligned to the global map, merged at ${W2}×${H2}`);
    } else {
      ow = gw; oh = gh;
      disp = gDisp;
    }
    return { disp, ow, oh, dw, dh };
  });
  const depthRun = await firstWorking(neural, prefer, "Depth", log, runDepth);
  if (!depthRun) {
    log.push("Depth unavailable: the photo opens with a flat distance map (no automatic depth effects)");
    return { seg: { width: lw, height: lh, probs }, depth: { width: 1, height: 1, dist: new Float32Array(1).fill(0.5), raw: new Float32Array(1), flat: true }, coverage, timings, log };
  }
  const { disp, ow, oh, dw, dh } = depthRun;
  // Relative inverse depth → robust 0..1 distance (0 = nearest, 1 = farthest).
  const lo = percentile(disp, 0.02), hi = percentile(disp, 0.98);
  const dist = new Float32Array(disp.length);
  const span = Math.max(1e-6, hi - lo);
  for (let i = 0; i < disp.length; i++) dist[i] = 1 - Math.min(1, Math.max(0, (disp[i] - lo) / span));
  {
    // Object outlines from segmentation (upsampled to the depth map).
    const objIdx = (["person", "animal", "vehicle"] as const).map((g) => GROUPS.indexOf(g));
    const obj = new Float32Array(lw * lh);
    for (const g of objIdx) for (let i = 0; i < lw * lh; i++) obj[i] += probs[g * lw * lh + i];
    const snapped = snapToObject(dist, resample(obj, lw, lh, ow, oh), ow, oh);
    if (snapped > 0) log.push(`Depth edges snapped to people/animal/vehicle outlines: ${(snapped * 100).toFixed(1)}% of pixels`);
  }
  log.push(`Depth Anything V2 Small global ${dw}×${dh} → map ${ow}×${oh}; disparity p2 ${lo.toFixed(2)} p98 ${hi.toFixed(2)}`);

  return { seg: { width: lw, height: lh, probs }, depth: { width: ow, height: oh, dist, raw: disp }, coverage, timings, log };
}

/**
 * Folds Apple's own mattes (ProRAW) into the network's probabilities.
 *
 * The phone computed them on the full-resolution frame while shooting, so
 * their edges are exact where a 512 px sliding window can only guess — hair
 * against sky, branches, roof lines. Where a matte claims a pixel, the other
 * classes give way proportionally, so the probabilities still sum to 1; where
 * it says nothing, the network's own answer stands.
 */
export function applyAppleMattes(seg: SceneMaps["seg"], mattes: Array<{ kind: "sky" | "skin" | "subject"; data: Uint8Array; width: number; height: number }>): string[] {
  const log: string[] = [];
  const plane = seg.width * seg.height;
  for (const m of mattes) {
    const g = m.kind === "sky" ? GROUPS.indexOf("sky") : GROUPS.indexOf("person");
    if (g < 0 || m.kind === "subject") continue; // the subject matte is depth-of-field material, not a class
    // Resample the matte onto the probability grid (box average: the matte is
    // much larger, so every grid cell sees many of its pixels).
    const sx = m.width / seg.width, sy = m.height / seg.height;
    let claimed = 0;
    for (let y = 0; y < seg.height; y++) {
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let x = 0; x < seg.width; x++) {
        const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
        let acc = 0, n = 0;
        for (let yy = y0; yy < y1 && yy < m.height; yy++) for (let xx = x0; xx < x1 && xx < m.width; xx++) { acc += m.data[yy * m.width + xx]; n++; }
        const p = n ? acc / (n * 255) : 0;
        const i = y * seg.width + x;
        const was = seg.probs[g * plane + i];
        if (p <= was) continue; // never take a class away from the network
        const rest = 1 - was;
        const scale = rest > 1e-6 ? (1 - p) / rest : 0;
        for (let k = 0; k < NG; k++) if (k !== g) seg.probs[k * plane + i] *= scale;
        seg.probs[g * plane + i] = p;
        claimed += p - was;
      }
    }
    log.push(`Apple ${m.kind} matte ${m.width}×${m.height} → ${GROUPS[g]} (+${((claimed / plane) * 100).toFixed(1)}% of the frame)`);
  }
  return log;
}
