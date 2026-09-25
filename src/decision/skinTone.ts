/**
 * Natural skin: measure the colour of the skin itself and pull it back only
 * when it is overdriven — too saturated, too red, or drifting toward
 * yellow-green. Never boosts: skin that already looks natural is left alone.
 *
 * Skin pixels: Apple's skin matte (ProRAW) where present, otherwise the person
 * probability × a skin-colour likelihood (OkLab hue ≈ 25…80°, moderate
 * chroma) — faces and hands, not clothes. Measured on the refined image
 * (guide resolution, scene-linear Rec.2020).
 */
import type { Params, SemanticAdjust } from "./params.ts";

export interface SkinStats { share: number; L: number; C: number; hue: number }

// Linear Rec.2020 → linear sRGB (for OkLab).
const M = [1.6605, -0.5876, -0.0728, -0.1246, 1.1329, -0.0083, -0.0182, -0.1006, 1.1187];
function oklab(r: number, g: number, b: number): [number, number, number] {
  const R = M[0] * r + M[1] * g + M[2] * b, G = M[3] * r + M[4] * g + M[5] * b, B = M[6] * r + M[7] * g + M[8] * b;
  const l = Math.cbrt(Math.max(0, 0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B));
  const m = Math.cbrt(Math.max(0, 0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B));
  const s = Math.cbrt(Math.max(0, 0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B));
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Weighted mean skin colour (OkLab L, chroma, hue in degrees), or undefined when there is too little skin. */
export function measureSkin(
  lin: Float32Array, w: number, h: number,
  person: { width: number; height: number; probs: Float32Array; plane: number },
  apple?: { data: Uint8Array; width: number; height: number },
): SkinStats | undefined {
  let W = 0, sa = 0, sb = 0, sl = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const [L, a, b] = oklab(lin[i], lin[i + 1], lin[i + 2]);
    if (L < 0.1) continue;
    const C = Math.hypot(a, b);
    let hd = Math.atan2(b, a) - 0.9;
    hd -= 2 * Math.PI * Math.floor((hd + Math.PI) / (2 * Math.PI));
    const col = Math.exp(-((hd / 0.45) ** 2)) * smooth(0.012, 0.03, C) * (1 - smooth(0.2, 0.28, C));
    const px = Math.min(person.width - 1, Math.floor((x / w) * person.width)), py = Math.min(person.height - 1, Math.floor((y / h) * person.height));
    let wgt = person.probs[person.plane + py * person.width + px] * col;
    if (apple) {
      const ax = Math.min(apple.width - 1, Math.floor((x / w) * apple.width)), ay = Math.min(apple.height - 1, Math.floor((y / h) * apple.height));
      wgt = Math.max(wgt, apple.data[ay * apple.width + ax] / 255);
    }
    if (wgt < 0.05) continue;
    W += wgt; sa += wgt * a; sb += wgt * b; sl += wgt * L;
  }
  const share = W / (w * h);
  if (share < 0.002) return undefined;
  const a = sa / W, b = sb / W;
  // Chroma of the mean colour: the typical skin colour, not inflated by noise.
  return { share, L: sl / W, C: Math.hypot(a, b), hue: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

/**
 * Corrections for the skin layer when its measured colour is overdriven, taking
 * the photo's and the skin's own saturation into account. Returns what to add
 * to `skin.saturation` and `skin.hue` (degrees), with a reason.
 */
export function naturalSkin(st: SkinStats, p: Pick<Params, "color">, skin: SemanticAdjust): { saturation: number; hue: number; reasons: string[] } {
  const reasons: string[] = [];
  let saturation = 0, hue = 0;
  const Ceff = st.C * Math.max(0, 1 + p.color.saturation + skin.saturation);
  if (Ceff > 0.105) {
    saturation = -Math.min(0.35, (Ceff - 0.095) / Ceff);
    reasons.push(`skin chroma ${Ceff.toFixed(3)} (natural ≲ 0.10) → saturation ${saturation.toFixed(2)}`);
  }
  if (st.hue < 40) {
    hue = Math.min(8, (48 - st.hue) * 0.5);
    reasons.push(`skin hue ${st.hue.toFixed(0)}° (too red) → +${hue.toFixed(1)}° toward natural`);
  } else if (st.hue > 72) {
    hue = -Math.min(8, (st.hue - 64) * 0.5);
    reasons.push(`skin hue ${st.hue.toFixed(0)}° (toward yellow-green) → ${hue.toFixed(1)}° toward natural`);
  }
  return { saturation, hue, reasons };
}
