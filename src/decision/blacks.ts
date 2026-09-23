/**
 * Black-point check: does the photograph's black actually render as black?
 *
 * A milky rendering is not visible in the input histogram — it is made by the
 * rendering itself (tone curve, shadow lift, haze). So the darkest tones are
 * pushed through the tone curve that will be used, and the result is read in
 * display code values (0…255):
 *
 *   scene EV of the darkest 0.1% (+ exposure + the shadow lift that the local
 *   tone stage applies deep down) → tone curve → sRGB encoding → code value
 *
 * A scene only *has* black when its darkest tones are far below white: shadow
 * material, not fog. Haze, fog and a flat overcast sky legitimately have no
 * black, and dehaze deals with those, so this check leaves them alone. When
 * there is true black and it renders grey, the black point is deepened just
 * enough to land it near code 2, while the darkest 1% must stay above code 4
 * so shadow separation survives.
 */
import type { Params } from "./params.ts";
import { toneCurve } from "../render/curves.ts";

/** Display code (0…255) of a scene luminance through this tone curve. */
export function renderCode(tone: Params["tone"], ev: number): number {
  const v = toneCurve(tone)(Math.pow(2, ev));
  return (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255;
}

export interface BlackReport {
  /** The scene contains genuinely dark material (not haze or fog). */
  hasTrueBlack: boolean;
  /** Code value the darkest 0.1% / 1% render at before the correction. */
  deepBefore: number;
  lowBefore: number;
  /** … and after it. */
  deepAfter: number;
  lowAfter: number;
  /** Black-point correction for Params.tone.blacks (≤ 0 deepens). */
  blacks: number;
}

/** Target code value for the darkest 0.1%, and the floor for the darkest 1%. */
const DEEP_TARGET = 2.5;
const DEEP_OK = 5;
const LOW_FLOOR = 4;

/**
 * Whether the scene has black is judged on the scene itself; whether it comes
 * out black is judged after the rendering lifts it.
 *
 * @param deepEV scene log2 luminance of the darkest 0.1%, after exposure
 * @param lowEV  the same for the darkest 1%
 * @param liftEV shadow lift the local tone stage applies to the deepest tones
 * @param clipLo fraction of the frame already at black in the source
 */
export function checkBlacks(tone: Params["tone"], deepEV0: number, lowEV0: number, liftEV: number, clipLo: number): BlackReport {
  const deepEV = deepEV0 + liftEV, lowEV = lowEV0 + liftEV;
  const deepBefore = renderCode({ ...tone, blacks: 0 }, deepEV);
  const lowBefore = renderCode({ ...tone, blacks: 0 }, lowEV);
  // Below ≈ −8.5 EV the scene holds shadow material dark enough to render as
  // black; above it its darkest tones are dark *material* (open shade, foliage)
  // or haze, and forcing those to black would only destroy them.
  const hasTrueBlack = deepEV0 <= -8.5 || clipLo > 0.002;
  const flat = { hasTrueBlack, deepBefore, lowBefore, deepAfter: deepBefore, lowAfter: lowBefore, blacks: 0 };
  if (!hasTrueBlack || deepBefore <= DEEP_OK) return flat;
  // Deepen just enough: scan the (monotone) black point for the value that puts
  // the darkest 0.1% at the target without dropping the darkest 1% below the floor.
  let best = 0;
  for (let i = 1; i <= 100; i++) {
    const b = -i * 0.005; // −0.005 … −0.5
    if (renderCode({ ...tone, blacks: b }, lowEV) < LOW_FLOOR) break;
    best = b;
    if (renderCode({ ...tone, blacks: b }, deepEV) <= DEEP_TARGET) break;
  }
  return {
    hasTrueBlack,
    deepBefore,
    lowBefore,
    deepAfter: renderCode({ ...tone, blacks: best }, deepEV),
    lowAfter: renderCode({ ...tone, blacks: best }, lowEV),
    blacks: Math.round(best * 100) / 100,
  };
}
