/**
 * Depth zones by natural breaks.
 *
 * The refined distance map is histogrammed and split into K layers with
 * optimal 1D clustering (Jenks natural breaks: minimal within-layer variance,
 * exact dynamic programming over the histogram). Boundaries therefore fall in
 * the valleys between the photo's depth layers — between a subject and what is
 * behind it — instead of at fixed percentages that cut objects in two.
 */
import { GROUPS } from "../neural/scene.ts";

export interface DepthZone { lo: number; hi: number; center: number; share: number; label: string }

const BINS = 64;

export function depthZones(
  dist: { w: number; h: number; data: Float32Array },
  seg?: { width: number; height: number; probs: Float32Array },
  K = 5,
): DepthZone[] {
  const hist = new Float64Array(BINS), sum = new Float64Array(BINS), sum2 = new Float64Array(BINS);
  for (const v0 of dist.data) {
    const v = Math.min(1, Math.max(0, v0));
    const b = Math.min(BINS - 1, Math.floor(v * BINS));
    hist[b]++; sum[b] += v; sum2[b] += v * v;
  }
  // Prefix sums → O(1) within-class squared error for any bin range.
  const P = new Float64Array(BINS + 1), S = new Float64Array(BINS + 1), S2 = new Float64Array(BINS + 1);
  for (let i = 0; i < BINS; i++) { P[i + 1] = P[i] + hist[i]; S[i + 1] = S[i] + sum[i]; S2[i + 1] = S2[i] + sum2[i]; }
  const cost = (a: number, b: number) => { // bins [a, b)
    const n = P[b] - P[a];
    if (n <= 0) return 0;
    const s = S[b] - S[a];
    return S2[b] - S2[a] - (s * s) / n;
  };
  // D[k][j]: best cost of splitting bins [0, j) into k classes.
  const D = Array.from({ length: K + 1 }, () => new Float64Array(BINS + 1).fill(Infinity));
  const arg = Array.from({ length: K + 1 }, () => new Int32Array(BINS + 1));
  D[0][0] = 0;
  for (let k = 1; k <= K; k++)
    for (let j = k; j <= BINS; j++)
      for (let i = k - 1; i < j; i++) {
        const c = D[k - 1][i] + cost(i, j);
        if (c < D[k][j]) { D[k][j] = c; arg[k][j] = i; }
      }
  const cuts: number[] = [BINS];
  for (let k = K, j = BINS; k > 0; k--) { j = arg[k][j]; cuts.unshift(j); }
  const total = P[BINS] || 1;
  // Dominant semantic group per zone (for labels).
  const counts = Array.from({ length: K }, () => new Float64Array(GROUPS.length));
  if (seg) {
    const plane = seg.width * seg.height;
    for (let y = 0; y < dist.h; y += 2) for (let x = 0; x < dist.w; x += 2) {
      const v = Math.min(1, Math.max(0, dist.data[y * dist.w + x]));
      const b = Math.min(BINS - 1, Math.floor(v * BINS));
      let z = 0;
      while (z < K - 1 && b >= cuts[z + 1]) z++;
      const sx = Math.min(seg.width - 1, Math.floor((x / dist.w) * seg.width)), sy = Math.min(seg.height - 1, Math.floor((y / dist.h) * seg.height));
      for (let g = 0; g < GROUPS.length; g++) counts[z][g] += seg.probs[g * plane + sy * seg.width + sx];
    }
  }
  return Array.from({ length: K }, (_, z) => {
    const a = cuts[z], b = cuts[z + 1];
    const n = P[b] - P[a];
    const lo = z === 0 ? 0 : a / BINS, hi = z === K - 1 ? 1 : b / BINS;
    const c = counts[z];
    let best = -1;
    for (let g = 0; g < GROUPS.length; g++) if (best < 0 || c[g] > c[best]) best = g;
    return {
      lo: Math.round(lo * 1000) / 1000,
      hi: Math.round(hi * 1000) / 1000,
      center: n > 0 ? Math.round(((S[b] - S[a]) / n) * 1000) / 1000 : (lo + hi) / 2,
      share: Math.round((n / total) * 1000) / 1000,
      label: seg && best >= 0 && c[best] > 0 ? GROUPS[best] : "",
    };
  });
}
