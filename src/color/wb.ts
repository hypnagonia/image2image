/**
 * White balance as a working-space 3×3.
 *
 * RAW: development produced  working = A₀ · raw  with A₀ = M(n₀) · diag(1/n₀)
 * for the as-shot neutral n₀. Rendering for another white (temperature/tint →
 * xy → camera neutral nₜ through the same DNG model, including the illuminant-
 * dependent matrix interpolation) is  working' = Aₜ · raw = Aₜ · A₀⁻¹ · working.
 * This is exactly "white balance in camera space, then the camera matrix",
 * evaluated without re-developing the RAW.
 *
 * Display-referred sources have no camera space: white balance is a von Kries
 * (Bradford) adaptation between the D65 white and the requested white.
 */
import { solveCameraColor, xyToNeutral, type CameraColor, type CameraColorInput } from "./dng.ts";
import { diag, inverse, mul, mulVec } from "./mat3.ts";
import { bradford, D65_XY, REC2020_TO_XYZ, tempTintToXy, XYZ_TO_REC2020, xyToTempTint, XYZToxy } from "./spaces.ts";

function fullMatrix(c: CameraColor): number[] {
  return mul(c.cameraToWorking, diag(c.gains));
}

function normaliseLuminance(W: number[]): number[] {
  const white = mulVec(W, [1, 1, 1]);
  const Y = 0.2627 * white[0] + 0.678 * white[1] + 0.0593 * white[2];
  return W.map((v) => v / Y);
}

export function wbMatrix(input: CameraColorInput | undefined, cam0: CameraColor | undefined, temp: number, tint: number): number[] {
  const xy = tempTintToXy(temp, tint);
  if (input && cam0 && (input.dng || input.libraw)) {
    const nt = xyToNeutral(input, xy);
    const ct = solveCameraColor(input, nt);
    return normaliseLuminance(mul(fullMatrix(ct), inverse(fullMatrix(cam0))));
  }
  // Display-referred: the image was rendered for D65; adapt from the requested white to D65.
  const A = mul(XYZ_TO_REC2020, mul(bradford(xy, D65_XY), REC2020_TO_XYZ));
  return normaliseLuminance(A);
}

/** Equivalent temperature/tint of a camera neutral (RAW), for the UI. */
export function neutralToTempTint(input: CameraColorInput, neutral: number[]): { temp: number; tint: number } {
  const c = solveCameraColor(input, neutral);
  return { temp: c.temp, tint: c.tint };
}

/** For display-referred images: the white implied by a working-space grey. */
export function workingGreyToTempTint(rgb: number[]): { temp: number; tint: number } {
  return xyToTempTint(XYZToxy(mulVec(REC2020_TO_XYZ, rgb)));
}
