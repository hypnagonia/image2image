/**
 * Colour spaces used by the engine.
 *
 * Working space: **linear Rec.2020, D65**. Scene-referred, unbounded above.
 * Chosen because camera gamuts routinely exceed Display P3 (saturated flowers,
 * LEDs, sodium lamps) and clipping them this early would be irreversible.
 *
 * Look space: **Display P3, sRGB transfer** (display-referred). Tone curves,
 * the 3D LUT and semantic colour operate here; it is also what iPhone screens
 * show natively. Output converts from here to sRGB or keeps P3.
 */
import { inverse, mul, mulVec, type Mat3, type Vec3 } from "./mat3.ts";

export type Primaries = { r: [number, number]; g: [number, number]; b: [number, number]; w: [number, number] };

export const D50_XY: [number, number] = [0.34567, 0.3585];
export const D65_XY: [number, number] = [0.3127, 0.329];

export const REC2020: Primaries = { r: [0.708, 0.292], g: [0.17, 0.797], b: [0.131, 0.046], w: D65_XY };
export const P3_D65: Primaries = { r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06], w: D65_XY };
export const SRGB: Primaries = { r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06], w: D65_XY };

export function xyToXYZ(xy: readonly number[], Y = 1): number[] {
  return [(xy[0] * Y) / xy[1], Y, ((1 - xy[0] - xy[1]) * Y) / xy[1]];
}

export function XYZToxy(v: Vec3): [number, number] {
  const s = v[0] + v[1] + v[2];
  return s > 0 ? [v[0] / s, v[1] / s] : D65_XY;
}

/** RGB→XYZ for a set of primaries (white maps to Y = 1). */
export function rgbToXYZ(p: Primaries): number[] {
  const R = xyToXYZ(p.r), G = xyToXYZ(p.g), B = xyToXYZ(p.b), W = xyToXYZ(p.w);
  const m = [R[0], G[0], B[0], R[1], G[1], B[1], R[2], G[2], B[2]];
  const s = mulVec(inverse(m), W);
  return [m[0] * s[0], m[1] * s[1], m[2] * s[2], m[3] * s[0], m[4] * s[1], m[5] * s[2], m[6] * s[0], m[7] * s[1], m[8] * s[2]];
}

const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];

/** Bradford chromatic adaptation from white `src` to white `dst` (XYZ→XYZ). */
export function bradford(srcXY: readonly number[], dstXY: readonly number[]): number[] {
  const s = mulVec(BRADFORD, xyToXYZ(srcXY));
  const d = mulVec(BRADFORD, xyToXYZ(dstXY));
  const scaleM = [d[0] / s[0], 0, 0, 0, d[1] / s[1], 0, 0, 0, d[2] / s[2]];
  return mul(inverse(BRADFORD), mul(scaleM, BRADFORD));
}

export const REC2020_TO_XYZ = rgbToXYZ(REC2020);
export const XYZ_TO_REC2020 = inverse(REC2020_TO_XYZ);
export const XYZ_D50_TO_REC2020 = mul(XYZ_TO_REC2020, bradford(D50_XY, D65_XY));
export const REC2020_TO_P3 = mul(inverse(rgbToXYZ(P3_D65)), REC2020_TO_XYZ);
export const P3_TO_SRGB = mul(inverse(rgbToXYZ(SRGB)), rgbToXYZ(P3_D65));
export const SRGB_TO_REC2020 = mul(XYZ_TO_REC2020, rgbToXYZ(SRGB));
export const P3_TO_REC2020 = mul(XYZ_TO_REC2020, rgbToXYZ(P3_D65));
export const REC2020_TO_SRGB = mul(inverse(rgbToXYZ(SRGB)), REC2020_TO_XYZ);
/** Rec.2020 luminance weights (row Y of RGB→XYZ). */
export const REC2020_LUMA: [number, number, number] = [REC2020_TO_XYZ[3], REC2020_TO_XYZ[4], REC2020_TO_XYZ[5]];

// ---------------------------------------------------------------------------
// Correlated colour temperature.

/** Planckian locus chromaticity (Kim et al. 2002 cubic fit, 1667–25000 K). */
export function planckianXY(T: number): [number, number] {
  T = Math.min(25000, Math.max(1667, T));
  const t = 1e3 / T, t2 = t * t, t3 = t2 * t;
  const x = T <= 4000 ? -0.2661239 * t3 - 0.234358 * t2 + 0.8776956 * t + 0.17991 : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t + 0.24039;
  const x2 = x * x, x3 = x2 * x;
  const y =
    T <= 2222 ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
    : T <= 4000 ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
    : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

function xyToUv(xy: readonly number[]): [number, number] {
  const d = -2 * xy[0] + 12 * xy[1] + 3;
  return [(4 * xy[0]) / d, (6 * xy[1]) / d];
}
function uvToXy(uv: readonly number[]): [number, number] {
  const d = 2 * uv[0] - 8 * uv[1] + 4;
  return [(3 * uv[0]) / d, (2 * uv[1]) / d];
}

/**
 * xy → (CCT, tint). CCT by search along the Planckian locus in CIE 1960 uv
 * (closest point); tint is the signed distance from the locus (Duv) scaled so
 * that one unit ≈ Lightroom's tint step (Duv × 3000, positive = magenta).
 */
export function xyToTempTint(xy: readonly number[]): { temp: number; tint: number } {
  const uv = xyToUv(xy);
  let lo = Math.log(1667), hi = Math.log(25000);
  const dist = (lt: number) => {
    const p = xyToUv(planckianXY(Math.exp(lt)));
    return (p[0] - uv[0]) ** 2 + (p[1] - uv[1]) ** 2;
  };
  for (let i = 0; i < 80; i++) {
    const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
    if (dist(a) < dist(b)) hi = b; else lo = a;
  }
  const T = Math.exp((lo + hi) / 2);
  const p = xyToUv(planckianXY(T));
  const q = xyToUv(planckianXY(T * 1.001));
  // Normal to the locus; sign so that below the locus (towards magenta) is positive tint.
  const tx = q[0] - p[0], ty = q[1] - p[1];
  const n = Math.hypot(tx, ty) || 1;
  const nx = -ty / n, ny = tx / n;
  const duv = (uv[0] - p[0]) * nx + (uv[1] - p[1]) * ny;
  return { temp: T, tint: -duv * 3000 };
}

export function tempTintToXy(temp: number, tint: number): [number, number] {
  const p = xyToUv(planckianXY(temp));
  const q = xyToUv(planckianXY(temp * 1.001));
  const tx = q[0] - p[0], ty = q[1] - p[1];
  const n = Math.hypot(tx, ty) || 1;
  const duv = -tint / 3000;
  return uvToXy([p[0] + (-ty / n) * duv, p[1] + (tx / n) * duv]);
}

/** EXIF LightSource → CCT, for DNG CalibrationIlluminant interpolation. */
export function illuminantCCT(code: number): number | undefined {
  const table: Record<number, number> = {
    1: 5500, 2: 4150, 3: 2850, 4: 5500, 9: 5500, 10: 6500, 11: 7500, 12: 6430, 13: 5000, 14: 4150,
    15: 3525, 16: 2925, 17: 2856, 18: 4874, 19: 6774, 20: 5503, 21: 6504, 22: 7504, 23: 5003, 24: 3200,
  };
  return table[code];
}
