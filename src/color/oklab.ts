import { mulVec } from "./mat3.ts";
import { REC2020_TO_SRGB } from "./spaces.ts";

export function linSrgbToOklab(c: readonly number[]): [number, number, number] {
  const l = 0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2];
  const m = 0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2];
  const s = 0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2];
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

export function oklabToLinSrgb(c: readonly number[]): [number, number, number] {
  const l_ = c[0] + 0.3963377774 * c[1] + 0.2158037573 * c[2];
  const m_ = c[0] - 0.1055613458 * c[1] - 0.0638541728 * c[2];
  const s_ = c[0] - 0.0894841775 * c[1] - 1.291485548 * c[2];
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Lightness, chroma and hue (degrees) of a linear Rec.2020 colour, exposure-normalised to Y = 0.18. */
export function lchOf(rec2020: readonly number[]): { L: number; C: number; h: number } {
  const y = 0.2627 * rec2020[0] + 0.678 * rec2020[1] + 0.0593 * rec2020[2];
  const k = y > 1e-6 ? 0.18 / y : 1;
  const lab = linSrgbToOklab(mulVec(REC2020_TO_SRGB, rec2020.map((v) => v * k)));
  const C = Math.hypot(lab[1], lab[2]);
  let h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L: lab[0], C, h };
}
