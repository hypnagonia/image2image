/**
 * Tap-to-select masks (src/neural/sam.ts) → masks the renderer samples.
 *
 * SAM answers with 256×256 logits over the padded 1024×1024 square the photo
 * was fitted into (photo in the top-left corner). The photo's part is sampled
 * up to the guide resolution (bilinear on the logits, then a logistic), and the
 * result is snapped to the photo's own edges with a grey guided filter
 * (He et al. 2013) — SAM's 4-pixel logit grid would otherwise show as soft,
 * blobby outlines on hair, fingers and clothes.
 */

/** SAM's low-resolution mask grid. */
export const SAM_LOW = 256;
/** SAM's input: the photo's long side, and the padded square. */
export const SAM_SIZE = 1024;

/** Size of the photo inside SAM's 1024 square. */
export function samDims(w: number, h: number): [number, number] {
  const s = SAM_SIZE / Math.max(w, h);
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

/**
 * The three multimask outputs (SAM's masks 1–3) ordered largest first: whole,
 * part, detail. SAM does not promise an order; the area does.
 */
export function levelsByArea(low: Float32Array, n = 4): number[] {
  const plane = SAM_LOW * SAM_LOW;
  const area = (k: number) => { let a = 0; for (let i = k * plane; i < (k + 1) * plane; i++) if (low[i] > 0) a++; return a; };
  const ks = Array.from({ length: n - 1 }, (_, i) => i + 1);
  const areas = new Map(ks.map((k) => [k, area(k)]));
  return ks.sort((a, b) => areas.get(b)! - areas.get(a)!);
}

/** Box mean of `src` (w×h) with radius r, via a summed-area table. */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const W1 = w + 1;
  const sat = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += src[y * w + x]; sat[(y + 1) * W1 + x + 1] = sat[y * W1 + x + 1] + row; }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const s = sat[y1 * W1 + x1] - sat[y0 * W1 + x1] - sat[y1 * W1 + x0] + sat[y0 * W1 + x0];
      out[y * w + x] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/** Grey guided filter: `p` smoothed so its edges follow those of guide `I` (both w×h). */
export function guidedFilter(I: Float32Array, p: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const n = w * h;
  const Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = boxMean(I, w, h, r), mp = boxMean(p, w, h, r), mIp = boxMean(Ip, w, h, r), mII = boxMean(II, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cov = mIp[i] - mI[i] * mp[i], v = mII[i] - mI[i] * mI[i];
    a[i] = cov / (v + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = ma[i] * I[i] + mb[i];
  return q;
}

/**
 * One SAM mask (plane `k` of the 256² logits) as an 8-bit mask at gw×gh.
 * `photo`: the photo's size in SAM's square (samDims). `guide`: the photo's
 * luminance at gw×gh (0…1) for edge snapping; without it, the plain upsample.
 */
export function selectionMask(low: Float32Array, k: number, photo: [number, number], gw: number, gh: number, guide?: Float32Array): Uint8Array {
  const plane = SAM_LOW * SAM_LOW, off = k * plane;
  // The photo covers [0, pw) × [0, ph) of the logit grid.
  const pw = (photo[0] / SAM_SIZE) * SAM_LOW, ph = (photo[1] / SAM_SIZE) * SAM_LOW;
  const at = (x: number, y: number) => low[off + Math.min(SAM_LOW - 1, Math.max(0, y)) * SAM_LOW + Math.min(SAM_LOW - 1, Math.max(0, x))];
  const p = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    const fy = ((y + 0.5) / gh) * ph - 0.5, y0 = Math.floor(fy), ty = fy - y0;
    for (let x = 0; x < gw; x++) {
      const fx = ((x + 0.5) / gw) * pw - 0.5, x0 = Math.floor(fx), tx = fx - x0;
      const l = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
      p[y * gw + x] = 1 / (1 + Math.exp(-l));
    }
  }
  // Radius ≈ the logit grid's cell at this resolution: enough to move an edge onto
  // the photo's, not enough to leak across a real one.
  const q = guide ? guidedFilter(guide, p, gw, gh, Math.max(2, Math.round((gw / pw) * 1.5)), 1e-3) : p;
  const out = new Uint8Array(gw * gh);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(255 * Math.min(1, Math.max(0, q[i])));
  return out;
}
