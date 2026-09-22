/**
 * The neutral display transform around the upscaling network: scene-linear
 * (normalised by the exposure gain) ↔ display-referred [0, 1]. Extended
 * Reinhard with white point WHITE, then the sRGB curve — per channel, no look,
 * and exactly invertible below the white point.
 */
/** Reinhard white point in normalised (gain-applied) linear units. */
export const WHITE = 4;

const oetf = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const eotf = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

/** Normalised linear → display-referred [0, 1]. */
export function toDisplay(v: number): number {
  const x = Math.max(0, v);
  const r = (x * (1 + x / (WHITE * WHITE))) / (1 + x);
  return oetf(Math.min(1, r));
}

/** Exact inverse of toDisplay (for values below the white point). */
export function fromDisplay(t: number): number {
  const r = eotf(Math.min(1, Math.max(0, t)));
  // r(1 + v) = v + v²/W²  →  v²/W² + (1 − r)v − r = 0
  const a = 1 / (WHITE * WHITE), b = 1 - r;
  return (-b + Math.sqrt(b * b + 4 * a * r)) / (2 * a);
}
