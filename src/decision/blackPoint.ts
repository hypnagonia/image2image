/**
 * Automatic black point and shadow depth — a grounded, natural black anchor
 * without crushed shadows, clipping or fake punch.
 *
 * Analysis (on the *rendered* tones: display-encoded levels after exposure,
 * local tone and the tone curve, i.e. perceptual; never on a minimum pixel):
 *   floor       robust shadow floor: the mean level of the darkest 0.5 %, 1 % and
 *               2 % — isolated noise, specks and single dark pixels do not count
 *   deep share  how much of the frame actually sits in deep-shadow tones (< ≈ 18/255)
 *   separation  how far apart the darkest 1 % and 15 % render (lower-range room)
 *   spread      p5 – p95: overall contrast
 *
 * Three different deficits, three different fixes — never one global contrast boost:
 *   no black anchor      floor lifted and little deep shadow → a smooth toe: the
 *                        bottom of the curve is lowered (shadows point only); the
 *                        amount is searched on the actual curve so the darkest
 *                        tones approach, but never reach, black and the levels
 *                        between them stay distinguishable (slope kept)
 *   compressed shadows   the lower range has no room → it is opened a little
 *                        (darks point up while the toe holds the floor)
 *   flat overall         only if still flat *after* the toe: a gentle S around the
 *                        photo's own median, on the mid and upper points only
 *
 * Scene types keep softer blacks: high-key (snow, airy, bright), haze / fog (no
 * real black in the scene), pastel (quiet colour, light), backlit (bright,
 * clipped surround, dark subject). Soft scenes get a higher target or none.
 *
 * Semantic and depth protection (as offsets to those targets' own curves): skin
 * gets most of the toe back (faces are never compressed), people (dark clothing
 * texture) half, the near foreground some; the distance may go slightly deeper
 * (depth, subject separation) — or softer when the scene is hazy.
 */
import { curveFromBands, monotoneCurve, type CurveBands } from "../render/curves.ts";

/** Where a grounded photo's shadow floor renders (display-encoded ≈ 14/255). */
const FLOOR_TARGET = 0.055;
/** The darkest meaningful tones may approach black, not reach it (≈ 3/255). */
const MIN_DEEP = 0.012;

export interface BlackPointInput {
  /** Display-encoded quantiles of the photo's rendered luminance. */
  q: (qs: number[]) => number[];
  /** Scene range p0.1 – p99.9 in EV (real black needs ≳ 8.5 EV). */
  rangeEV: number;
  /** Mean displayed chroma of the photo. */
  chroma: number;
  /** Fraction of the frame clipped in the highlights. */
  clipHi: number;
  /** Atmosphere: automatic dehaze strength (0 … 1). */
  haze: number;
  /** What the photo contains, for protection. */
  people: boolean;
  near: boolean;
  far: boolean;
}

export interface BlackPointResult {
  /** Offsets to the photo's master curve (tone-range slider units). */
  photo: CurveBands;
  /** Offsets for protected / depth-shaped targets (skin, people, near, far). */
  targets: Partial<Record<"skin" | "person" | "near" | "far", CurveBands>>;
  reasons: string[];
  metrics: Record<string, number>;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const flat = (): CurveBands => ({ black: 0, bands: [0, 0, 0, 0, 0], white: 0 });
const curveOf = (b: CurveBands) => monotoneCurve(curveFromBands(b));

export function blackPoint(i: BlackPointInput): BlackPointResult {
  const [q005, q01, q02, q05, q15, p50, q95] = i.q([0.005, 0.01, 0.02, 0.05, 0.15, 0.5, 0.95]);
  const floor = (q005 + q01 + q02) / 3;
  // Share of the frame below ≈ 18/255 (bisection on the quantile function).
  let lo = 0, hi = 1;
  for (let k = 0; k < 20; k++) { const m = (lo + hi) / 2; if (i.q([m])[0] < 0.07) lo = m; else hi = m; }
  const deepShare = lo;
  const separation = q15 - q01;
  const spread = q95 - q05;
  const metrics = { floor255: Math.round(floor * 255), deepShare: r3(deepShare), separation: r3(separation), spread: r3(spread), rangeEV: Math.round(i.rangeEV * 10) / 10 };

  // --- scene type: some scenes legitimately have soft blacks ----------------------
  const highKey = smooth(0.55, 0.7, p50) * smooth(0.22, 0.38, q05);
  // Haze / fog from the measured atmosphere (and a genuinely tiny range). Not from
  // the range alone: phone raws are already range-compressed, so a clear
  // daylight frame often spans only 5–7 EV and still wants a black anchor.
  const hazy = Math.max(smooth(0.15, 0.45, i.haze), smooth(5.0, 3.5, i.rangeEV));
  const pastel = smooth(0.035, 0.02, i.chroma) * smooth(0.5, 0.65, p50);
  const backlit = smooth(0.005, 0.03, i.clipHi) * smooth(0.4, 0.22, p50);
  const soft = Math.max(highKey, hazy, pastel, 0.6 * backlit);
  const kind = soft < 0.15 ? "" : highKey === soft ? "high-key" : hazy === soft ? "haze / no real black" : pastel === soft ? "pastel" : "backlit";

  const photo = flat();
  const reasons: string[] = [];
  const targets: BlackPointResult["targets"] = {};

  // --- 1. black anchor: a smooth toe at the photo's own floor ---------------------------
  // The floor level x renders at y < x; the curve rejoins itself by ≈ 2.2·x, so
  // midtones stay. y is searched on the actual curve: as low as the target, but
  // the darkest 0.5 % stays above near-black and the dark levels keep ≥ 60 % of
  // their spacing (nothing collapses into one black).
  const target = FLOOR_TARGET + 0.04 * soft;
  const needsAnchor = floor > target + 0.015 && deepShare < 0.03 && soft < 0.9;
  let toeDrop = 0;
  if (needsAnchor) {
    const x1 = floor;
    const ok = (y1: number) => {
      const f = curveOf({ black: 0, bands: [0, 0, 0, 0, 0], white: 0, toe: [x1, y1] });
      return f(q005) >= MIN_DEEP && f(q02) - f(q005) >= 0.6 * (q02 - q005) && f(q15) - f(q01) >= 0.85 * (q15 - q01);
    };
    let y = x1;
    // At most ≈ 15/255 lower: a deeper anchor, not a darker photo (a lifted floor of
    // 54/255 pulled to 24/255 took the whole lower half down with it).
    for (let y1 = x1 - 0.004; y1 >= Math.max(target, x1 * 0.6, x1 - 0.06); y1 -= 0.004) { if (!ok(y1)) break; y = y1; }
    if (x1 - y > 0.008) {
      photo.toe = [Math.round(x1 * 1000) / 1000, Math.round(y * 1000) / 1000];
      toeDrop = x1 - y;
      const f = curveOf(photo);
      reasons.push(`black anchor: shadow floor ${Math.round(floor * 255)}/255 with ${(deepShare * 100).toFixed(1)}% deep shadow → smooth toe to ${Math.round(y * 255)}/255 (darkest 0.5% at ${Math.round(f(q005) * 255)}/255, dark levels kept apart)` + (kind ? `; ${kind} scene: softer target` : ""));
    }
  } else if (floor > target + 0.015 && soft >= 0.15) {
    reasons.push(`soft blacks kept: ${kind} scene (floor ${Math.round(floor * 255)}/255)`);
  }

  // --- 2. shadow separation: open a compressed lower range -------------------------
  if (separation < 0.07 && q15 < 0.3 && floor < 0.2) {
    const open = Math.min(0.12, ((0.07 - separation) / 0.07) * 0.12);
    photo.bands[1] += open;
    reasons.push(`shadow separation: darkest 1% and 15% only ${Math.round(separation * 255)}/255 apart → lower range opened (+${open.toFixed(2)} at the darks point)`);
  }

  // --- 3. overall contrast: only if still flat after the black point -----------------
  {
    const f = curveOf(photo);
    const spreadAfter = f(q95) - f(q05);
    if (spreadAfter < 0.45 && soft < 0.6) {
      const m = f(p50);
      const s = 0.2 * smooth(0.45, 0.25, spreadAfter) * (1 - soft);
      // Mid and upper points only: the toe already shaped the bottom.
      for (const [k, x] of [[1, 0.3], [2, 0.5], [3, 0.7], [4, 0.9]] as const) photo.bands[k] += clamp(s * clamp((x - m) / 0.25, -1, 1) * (1 - 0.4 * Math.abs(x - 0.5) / 0.4), -0.2, 0.2);
      if (s > 0.01) reasons.push(`still flat after the black point (p5–p95 ${spreadAfter.toFixed(2)}) → gentle contrast around the median`);
    }
  }

  // --- semantic and depth protection of the toe -----------------------------------------
  if (toeDrop > 0) {
    // Band units at the shadows / darks points that give back part of the toe.
    const a = Math.min(0.35, toeDrop / 0.12);
    if (i.people) {
      targets.skin = { black: 0, bands: [0.7 * a, 0.2 * a, 0, 0, 0], white: 0 };   // faces: never compressed
      targets.person = { black: 0, bands: [0.5 * a, 0.1 * a, 0, 0, 0], white: 0 }; // dark clothing keeps its texture
    }
    if (i.near) targets.near = { black: 0, bands: [0.4 * a, 0, 0, 0, 0], white: 0 }; // key foreground detail
    if (i.far) targets.far = hazy > 0.3 || i.haze > 0.15
      ? { black: 0, bands: [0.5 * a, 0, 0, 0, 0], white: 0 }                       // atmosphere: distance stays soft
      : { black: 0, bands: [-0.25 * a, 0, 0, 0, 0], white: 0 };                    // clear air: a little deeper, for depth
  }
  return { photo, targets, reasons, metrics };
}
