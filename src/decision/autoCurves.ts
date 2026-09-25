/**
 * Automatic curves — for the whole photo, for regions (sky, vegetation, water,
 * buildings), for skin and for distance (near / middle / far).
 *
 * Like the black point (blackPoint.ts), this looks at the *rendering*, not at
 * the input: every luminance histogram (32 bins of log2 scene luminance,
 * −14 … +4 EV) is pushed through what the renderer will do to it — exposure,
 * the local-tone pull toward the anchor with its shadow/highlight shaping, and
 * the display tone curve — and read as display-encoded values. Rules then
 * compare those against comfortable ranges:
 *
 *   photo       black point and shadow depth (blackPoint.ts: black anchor, shadow
 *               separation, then contrast only if still flat — scene-type aware,
 *               with skin / people / foreground / distance protection);
 *               whites that never reach near-white (and nothing clipped) → opened
 *   sky         washed out (median high) → lights/highlights down: a deeper sky
 *   skin        faces (people's upper tones) too dark → lifted; too bright → eased
 *   ground      always a contrast curve (house style, with its lower saturation)
 *   vegetation, water, buildings
 *               low local contrast → a small contrast around the region's median
 *   near        flat foreground → a little contrast (depth: the front pops)
 *   far         a landscape's distance with deep shadows → darks lifted a touch
 *               (aerial perspective)
 *
 * Every change is a tone-range slider value (CurveBands, curves.ts) capped at
 * ±0.35 (≈ ±0.04 of output level), and a rule fires only when its measurement
 * is outside its range — a photograph that already renders well gets flat curves.
 */
import { curveFromBands, toneCurve, type CurveBands, TONE_BANDS } from "../render/curves.ts";
import { blackPoint } from "./blackPoint.ts";
import type { CurvePoint, Curves, DepthBand, Params, Region } from "./params.ts";

const HIST_MIN = -14, HIST_RANGE = 18;
const CAP = 0.35;

/** A quantile of a histogram as scene EV (bin interpolation). */
function evQuantile(hist: number[], q: number): number {
  const n = hist.length, w = HIST_RANGE / n, total = hist.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const next = acc + hist[k] / total;
    if (next >= q) return HIST_MIN + (k + (hist[k] > 0 ? (q - acc) / (hist[k] / total) : 0)) * w;
    acc = next;
  }
  return HIST_MIN + HIST_RANGE;
}

export interface HistStats { hist: number[]; area: number; localContrast?: number }
export interface AutoCurvesInput {
  tone: Params["tone"];
  exposure: number;
  local: Params["local"];
  clipHi: number;
  /** Mean displayed chroma of the photo, and the automatic dehaze strength (scene type for the black point). */
  chroma?: number;
  haze?: number;
  photo: HistStats;
  regions: Partial<Record<"sky" | "vegetation" | "water" | "building" | "person" | "ground", HistStats>>;
  bands?: Partial<Record<DepthBand, HistStats>>;
}
export interface AutoCurvesResult {
  photo?: CurveBands;
  regions: Partial<Record<Region, CurveBands>>;
  depth: Partial<Record<DepthBand, CurveBands>>;
  notes: Array<{ id: string; value: number[]; reason: string; inputs: Record<string, number> }>;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const r2 = (v: number) => Math.round(v * 100) / 100;
const enc = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const flat = (): CurveBands => ({ black: 0, bands: [0, 0, 0, 0, 0], white: 0 });

/** Display-encoded level of a scene EV through exposure, local tone and the tone curve (as render_tone.wgsl). */
export function displayLevel(ev: number, i: Pick<AutoCurvesInput, "tone" | "exposure" | "local">): number {
  const anchor = i.local.anchorEV + i.exposure;
  let b = anchor + (ev + i.exposure - anchor) * (1 - i.local.compression);
  const wsh = 1 - smooth(anchor - 3, anchor + 0.5, b);
  const whl = smooth(anchor + 0.3, anchor + 3, b);
  b += i.tone.shadows * 2 * wsh + i.tone.highlights * 1.6 * whl;
  return enc(toneCurve(i.tone)(Math.pow(2, b)));
}

/** Quantiles of a histogram, read as display-encoded levels. */
export function displayQuantiles(hist: number[], i: Pick<AutoCurvesInput, "tone" | "exposure" | "local">, qs: number[]): number[] {
  const n = hist.length, w = HIST_RANGE / n;
  const levels = hist.map((_, k) => displayLevel(HIST_MIN + (k + 0.5) * w, i));
  const total = hist.reduce((a, b) => a + b, 0) || 1;
  return qs.map((q) => {
    let acc = 0;
    for (let k = 0; k < n; k++) {
      const next = acc + hist[k] / total;
      if (next >= q) {
        // Interpolate within the bin (levels rise monotonically with EV).
        const f = hist[k] > 0 ? (q - acc) / (hist[k] / total) : 0;
        const lo = k > 0 ? (levels[k - 1] + levels[k]) / 2 : levels[k];
        const hi = k < n - 1 ? (levels[k] + levels[k + 1]) / 2 : levels[k];
        return lo + (hi - lo) * f;
      }
      acc = next;
    }
    return levels[n - 1];
  });
}

/** Contrast around a level m: bands below m go down, above go up (a soft S centred on the region itself). */
function contrastAround(m: number, s: number): CurveBands {
  const b = flat();
  b.bands = TONE_BANDS.map((x) => clamp(s * clamp((x - m) / 0.25, -1, 1) * (1 - 0.4 * Math.abs(x - 0.5) / 0.4), -CAP, CAP));
  return b;
}
const capped = (b: CurveBands): CurveBands => ({ black: clamp(b.black, 0, CAP), bands: b.bands.map((v) => clamp(v, -CAP, CAP)), white: clamp(b.white, -CAP, 0), ...(b.toe ? { toe: b.toe } : {}) });
const isFlatBands = (b: CurveBands) => Math.abs(b.black) < 0.01 && Math.abs(b.white) < 0.01 && b.bands.every((v) => Math.abs(v) < 0.01) && !(b.toe && b.toe[1] < b.toe[0] - 0.004);

export function autoCurves(i: AutoCurvesInput): AutoCurvesResult {
  const out: AutoCurvesResult = { regions: {}, depth: {}, notes: [] };
  const q = (h: HistStats, qs: number[]) => displayQuantiles(h.hist, i, qs);
  // Several rules may shape one target (skin: faces lifted and protected from the
  // black toe): their offsets add up, then are capped once.
  const acc = new Map<string, { b: CurveBands; reasons: string[]; inputs: Record<string, number>; set: (b: CurveBands) => void }>();
  const put = (b: CurveBands, set: (b: CurveBands) => void, id: string, reason: string, inputs: Record<string, number>) => {
    const e = acc.get(id);
    if (e) {
      e.b = { black: e.b.black + b.black, bands: e.b.bands.map((v, k) => v + b.bands[k]), white: e.b.white + b.white, ...((b.toe ?? e.b.toe) ? { toe: b.toe ?? e.b.toe } : {}) };
      e.reasons.push(reason);
      Object.assign(e.inputs, inputs);
    } else acc.set(id, { b: structuredClone(b), reasons: [reason], inputs: { ...inputs }, set });
  };

  // --- the photo: black point and shadow depth (blackPoint.ts), then the whites ------
  const bp = blackPoint({
    q: (qs) => q(i.photo, qs),
    rangeEV: evQuantile(i.photo.hist, 0.999) - evQuantile(i.photo.hist, 0.001),
    chroma: i.chroma ?? 0.04, clipHi: i.clipHi, haze: i.haze ?? 0,
    people: (i.regions.person?.area ?? 0) >= 0.01,
    near: (i.bands?.near?.area ?? 0) >= 0.1, far: (i.bands?.far?.area ?? 0) >= 0.1,
  });
  if (bp.reasons.length) put(bp.photo, (c) => (out.photo = c), "curves.photo", bp.reasons.join("; "), bp.metrics);
  for (const [t, b] of Object.entries(bp.targets) as Array<[keyof typeof bp.targets, CurveBands]>) {
    const why = t === "skin" ? "skin protected from the black toe" : t === "person" ? "people (dark clothing texture) protected from the black toe"
      : t === "near" ? "foreground detail protected from the black toe" : b.bands[0] > 0 ? "hazy distance kept soft" : "clear distance a little deeper, for depth";
    if (t === "skin" || t === "person") put(b, (c) => (out.regions[t] = c), `curves.${t}`, why, {});
    else put(b, (c) => (out.depth[t] = c), `curves.${t}`, why, {});
  }
  {
    // The brightest tones that are not clipped (clipped sun or sky does not count:
    // it is rolled off and would otherwise say "the whites are there").
    const at = Math.max(0.9, Math.min(0.99, 1 - i.clipHi - 0.005));
    const [p99] = q(i.photo, [at]);
    if (p99 < 0.88) {
      const o = 0.35 * smooth(0.88, 0.7, p99);
      const b = flat();
      b.bands[4] = o; b.bands[3] = o * 0.5;
      put(b, (c) => (out.photo = c), "curves.photo", `whites never reach white: the brightest unclipped tones (p${Math.round(at * 1000) / 10}) render at ${p99.toFixed(2)} → highlights opened`, { p99: r2(p99) });
    }
  }

  // --- sky ---------------------------------------------------------------------------
  const sky = i.regions.sky;
  if (sky && sky.area >= 0.03) {
    const [m] = q(sky, [0.5]);
    if (m > 0.8) {
      const a = CAP * smooth(0.8, 0.93, m);
      const b = flat();
      b.bands = [0, 0, -a * 0.35, -a * 0.7, -a];
      put(b, (c) => (out.regions.sky = c), "curves.sky", `sky renders at median ${m.toFixed(2)} (washed out, > 0.80) → lights and highlights down in the sky`, { median: r2(m), area: r2(sky.area) });
    }
  }

  // --- skin (people's upper tones stand in for faces) --------------------------------
  const person = i.regions.person;
  if (person && person.area >= 0.01) {
    const [m] = q(person, [0.7]);
    const b = flat();
    if (m < 0.5) {
      const a = CAP * smooth(0.5, 0.3, m);
      b.bands = [a * 0.3, a * 0.7, a, a * 0.6, a * 0.2];
      put(b, (c) => (out.regions.skin = c), "curves.skin", `faces render dark: people's upper tones at ${m.toFixed(2)} (< 0.50) → skin lifted`, { level: r2(m), area: r2(person.area) });
    } else if (m > 0.82) {
      const a = CAP * smooth(0.82, 0.95, m);
      b.bands = [0, 0, -a * 0.4, -a * 0.8, -a];
      put(b, (c) => (out.regions.skin = c), "curves.skin", `faces render bright: people's upper tones at ${m.toFixed(2)} (> 0.82) → skin highlights eased`, { level: r2(m), area: r2(person.area) });
    }
  }

  // --- ground: always more contrast (house style, with its lower saturation) ------------
  const ground = i.regions.ground;
  if (ground && ground.area >= 0.02) {
    const [m] = q(ground, [0.5]);
    put(contrastAround(m, 0.28), (c) => (out.regions.ground = c), "curves.ground",
      `ground: more contrast around its median ${m.toFixed(2)} (house style)`, { median: r2(m), area: r2(ground.area) });
  }

  // --- textured regions: a little contrast where it is missing --------------------
  for (const g of ["vegetation", "water", "building"] as const) {
    const r = i.regions[g];
    if (!r || r.area < 0.02 || r.localContrast === undefined) continue;
    if (r.localContrast >= 0.22) continue;
    const [m] = q(r, [0.5]);
    const s = 0.25 * smooth(0.22, 0.1, r.localContrast);
    put(contrastAround(m, s), (c) => (out.regions[g] = c), `curves.${g}`,
      `${g} is flat: local contrast ${r.localContrast.toFixed(2)} EV (< 0.22) → contrast around its median ${m.toFixed(2)}`, { localContrast: r2(r.localContrast), median: r2(m), area: r2(r.area) });
  }

  // --- distance ------------------------------------------------------------------------
  const near = i.bands?.near;
  if (near && near.area >= 0.1) {
    const [p10, p50, p90] = q(near, [0.1, 0.5, 0.9]);
    const spread = p90 - p10;
    if (spread < 0.4) {
      put(contrastAround(p50, 0.2 * smooth(0.4, 0.2, spread)), (c) => (out.depth.near = c), "curves.near",
        `the foreground is flat: p10–p90 ${p10.toFixed(2)}–${p90.toFixed(2)} (spread ${spread.toFixed(2)} < 0.40) → a little contrast up front`, { spread: r2(spread), median: r2(p50) });
    }
  }
  const far = i.bands?.far;
  if (far && far.area >= 0.3 && sky && sky.area >= 0.05) {
    const [p05] = q(far, [0.05]);
    if (p05 < 0.12) {
      const a = 0.25 * smooth(0.12, 0.04, p05);
      const b = flat();
      b.bands = [a, a * 0.5, 0, 0, 0];
      put(b, (c) => (out.depth.far = c), "curves.far", `a landscape's distance with deep shadows (p5 at ${p05.toFixed(2)}) → darks lifted a touch (aerial perspective)`, { p05: r2(p05), area: r2(far.area) });
    }
  }
  for (const [id, e] of acc) {
    const c = capped(e.b);
    if (isFlatBands(c)) continue;
    e.set(c);
    out.notes.push({ id, value: [r2(c.black), ...c.bands.map(r2), r2(c.white)], reason: e.reasons.join("; "), inputs: e.inputs });
  }
  return out;
}

/** The automatic curve settings, without their notes (kept so a strength slider can rescale them). */
export type AutoCurveBands = Omit<AutoCurvesResult, "notes">;

export function scaleBands(b: CurveBands, k: number): CurveBands {
  // The toe scales toward "no toe" (y = x) like the bands scale toward 0.
  const toe: [number, number] | undefined = b.toe ? [b.toe[0], Math.min(1, Math.max(0, b.toe[0] + (b.toe[1] - b.toe[0]) * k))] : undefined;
  return { black: clamp(b.black * k, 0, 1), bands: b.bands.map((v) => clamp(v * k, -1, 1)), white: clamp(b.white * k, -1, 0), ...(toe ? { toe } : {}) };
}
const FLAT_PTS = [{ x: 0, y: 0 }, { x: 1, y: 1 }];

/**
 * Sets the luminance curves of every automatic target to its automatic bands ×
 * `to`. With `from`, a target is only changed while its curve is still the
 * automatic one at strength `from` — the user's own edits are kept.
 */
export function applyAutoCurves(p: Params, a: AutoCurveBands, to: number, from?: number) {
  const same = (x: CurvePoint[] | undefined, y: CurvePoint[]) => JSON.stringify(x ?? FLAT_PTS) === JSON.stringify(y);
  const one = (b: CurveBands, get: () => Curves | undefined, set: (c: Curves) => void) => {
    const cur = get();
    if (from !== undefined && !same(cur?.l, curveFromBands(scaleBands(b, from)))) return;
    const base = cur ?? { l: FLAT_PTS, r: FLAT_PTS, g: FLAT_PTS, b: FLAT_PTS };
    set({ ...base, l: curveFromBands(scaleBands(b, to)) });
  };
  if (a.photo) one(a.photo, () => p.curves, (c) => (p.curves = c));
  for (const [r, b] of Object.entries(a.regions) as Array<[Region, CurveBands]>) one(b, () => p.regionCurves[r], (c) => (p.regionCurves[r] = c));
  for (const [r, b] of Object.entries(a.depth) as Array<[DepthBand, CurveBands]>) one(b, () => p.depthCurves[r], (c) => (p.depthCurves[r] = c));
  p.autoCurves = to;
}
