/**
 * The DNG colour model (DNG Specification 1.6, chapter 6 "Mapping Camera Color
 * Space to CIE XYZ Space"), producing the two things RAW development needs:
 *
 *   1. white-balance gains in camera space      (diag(1 / CameraNeutral))
 *   2. a 3×3 camera→working matrix              (balanced camera RGB → linear Rec.2020 D65)
 *
 * so that   working = M · diag(1/neutral) · camera.
 *
 * A later white-balance *refinement* chosen by the decision engine is applied
 * in working space as  M · diag(g) · M⁻¹, which is algebraically identical to
 * changing the camera-space gains (see docs/PIPELINE.md, "white balance").
 */
import * as m3 from "./mat3.ts";
import { bradford, D50_XY, illuminantCCT, XYZ_D50_TO_REC2020, XYZToxy, xyToTempTint, xyToXYZ, SRGB_TO_REC2020 } from "./spaces.ts";

export interface CameraColorInput {
  /** DNG path: per-illuminant matrices. Absent for non-DNG raws. */
  dng?: {
    illuminants: Array<{ cct: number; colorMatrix: number[]; forwardMatrix?: number[]; calibration?: number[] }>;
    analogBalance: [number, number, number];
    asShotNeutral?: [number, number, number];
  };
  /** Non-DNG path: LibRaw's camera→sRGB matrix and as-shot multipliers. */
  libraw?: { rgbCam: number[]; camMul: [number, number, number] };
  baselineExposure: number;
}

export interface CameraColor {
  /** Camera-space neutral (the camera RGB of a white object). */
  neutral: [number, number, number];
  /** White-balance gains in camera space, normalised so min gain = 1. */
  gains: [number, number, number];
  /** Balanced camera RGB → linear Rec.2020 D65. Maps (1,1,1) → (1,1,1). */
  cameraToWorking: number[];
  /** Scene white chromaticity implied by the neutral, and its temperature/tint. */
  whiteXY: [number, number];
  temp: number;
  tint: number;
  baselineExposure: number;
  source: "dng-forward-matrix" | "dng-color-matrix" | "libraw-rgb-cam" | "identity";
  log: string[];
}

function mat3FromColorMatrix(cm: number[]): number[] {
  // LibRaw stores ColorMatrix as 4×3 (rows = camera channels). Take the first 3 rows.
  return [cm[0], cm[1], cm[2], cm[3], cm[4], cm[5], cm[6], cm[7], cm[8]];
}
function mat3FromForwardMatrix(fm: number[]): number[] {
  // 3×4 (rows = XYZ), camera columns 0..2.
  return [fm[0], fm[1], fm[2], fm[4], fm[5], fm[6], fm[8], fm[9], fm[10]];
}
function mat3FromCalibration(cc: number[]): number[] {
  return [cc[0], cc[1], cc[2], cc[4], cc[5], cc[6], cc[8], cc[9], cc[10]];
}

/** Interpolation weight for illuminant 1 given a CCT (linear in inverse temperature). */
function weight1(cct: number, t1: number, t2: number): number {
  if (t1 === t2) return 1;
  const lo = Math.min(t1, t2), hi = Math.max(t1, t2);
  const t = Math.min(hi, Math.max(lo, cct));
  const w = (1 / t - 1 / t2) / (1 / t1 - 1 / t2);
  return Math.min(1, Math.max(0, w));
}

interface Interp { XYZtoCamera: number[]; forward?: number[]; ABCC: number[] }

function interpolate(input: NonNullable<CameraColorInput["dng"]>, cct: number): Interp {
  const AB = m3.diag(input.analogBalance);
  const ills = input.illuminants;
  const one = (i: number) => {
    const il = ills[i];
    const CC = il.calibration && !m3.isZero(il.calibration) ? mat3FromCalibration(il.calibration) : m3.IDENTITY;
    return {
      CM: mat3FromColorMatrix(il.colorMatrix),
      FM: il.forwardMatrix && !m3.isZero(il.forwardMatrix) ? mat3FromForwardMatrix(il.forwardMatrix) : undefined,
      CC,
    };
  };
  if (ills.length === 1) {
    const a = one(0);
    const ABCC = m3.mul(AB, a.CC);
    return { XYZtoCamera: m3.mul(ABCC, a.CM), forward: a.FM, ABCC };
  }
  const a = one(0), b = one(1);
  const w = weight1(cct, ills[0].cct, ills[1].cct);
  const CM = m3.lerp(b.CM, a.CM, w);
  const CC = m3.lerp(b.CC, a.CC, w);
  const FM = a.FM && b.FM ? m3.lerp(b.FM, a.FM, w) : a.FM ?? b.FM;
  const ABCC = m3.mul(AB, CC);
  return { XYZtoCamera: m3.mul(ABCC, CM), forward: FM, ABCC };
}

/** Finds the white xy whose interpolated matrices map to `neutral` (DNG spec iteration). */
function neutralToXY(input: NonNullable<CameraColorInput["dng"]>, neutral: readonly number[]): [number, number] {
  let xy: [number, number] = [...D50_XY];
  for (let i = 0; i < 30; i++) {
    const cct = xyToTempTint(xy).temp;
    const { XYZtoCamera } = interpolate(input, cct);
    const XYZ = m3.mulVec(m3.inverse(XYZtoCamera), neutral);
    const next = XYZToxy(XYZ);
    if (Math.abs(next[0] - xy[0]) + Math.abs(next[1] - xy[1]) < 1e-7) return next;
    xy = [(xy[0] + next[0]) / 2, (xy[1] + next[1]) / 2];
  }
  return xy;
}

/** Camera neutral for a white of chromaticity xy (inverse of neutralToXY). */
export function xyToNeutral(input: CameraColorInput, xy: readonly number[]): [number, number, number] {
  if (!input.dng) {
    // For non-DNG the matrix does not vary with illuminant: neutral = rgbCam⁻¹ · (white in sRGB).
    return [1, 1, 1];
  }
  const cct = xyToTempTint(xy).temp;
  const { XYZtoCamera } = interpolate(input.dng, cct);
  const n = m3.mulVec(XYZtoCamera, xyToXYZ(xy));
  const mx = Math.max(...n);
  return [n[0] / mx, n[1] / mx, n[2] / mx];
}

export function solveCameraColor(input: CameraColorInput, neutralOverride?: readonly number[]): CameraColor {
  const log: string[] = [];
  if (input.dng && input.dng.illuminants.length) {
    const dng = input.dng;
    const cm = input.libraw?.camMul;
    const fromMul = cm && cm[0] > 0 && cm[1] > 0 && cm[2] > 0 ? [1 / cm[0], 1 / cm[1], 1 / cm[2]] : undefined;
    const raw = (neutralOverride ?? dng.asShotNeutral ?? fromMul ?? [1, 1, 1]) as number[];
    const nmax = Math.max(...raw);
    const neutral: [number, number, number] = [raw[0] / nmax, raw[1] / nmax, raw[2] / nmax];
    const whiteXY = neutralToXY(dng, neutral);
    const { temp, tint } = xyToTempTint(whiteXY);
    const it = interpolate(dng, temp);
    let camToXYZD50: number[];
    let source: CameraColor["source"];
    if (it.forward) {
      // CameraToXYZ_D50 = FM · D · (AB·CC)⁻¹, D = diag(ReferenceNeutral)⁻¹
      const refNeutral = m3.mulVec(m3.inverse(it.ABCC), neutral);
      const D = m3.diag([1 / refNeutral[0], 1 / refNeutral[1], 1 / refNeutral[2]]);
      camToXYZD50 = m3.mul(it.forward, m3.mul(D, m3.inverse(it.ABCC)));
      source = "dng-forward-matrix";
    } else {
      // CameraToXYZ = XYZtoCamera⁻¹, normalised so the neutral maps to Y = 1,
      // then Bradford-adapted from the scene white to D50.
      const inv = m3.inverse(it.XYZtoCamera);
      const Y = m3.mulVec(inv, neutral)[1];
      camToXYZD50 = m3.mul(bradford(whiteXY, D50_XY), m3.scale(inv, 1 / Y));
      source = "dng-color-matrix";
    }
    // Balanced camera (neutral → 1,1,1) → Rec.2020.
    let M = m3.mul(XYZ_D50_TO_REC2020, m3.mul(camToXYZD50, m3.diag(neutral)));
    // Normalise so white maps exactly to (1,1,1) (removes residual D50 rounding).
    const w = m3.mulVec(M, [1, 1, 1]);
    M = [M[0] / w[0], M[1] / w[0], M[2] / w[0], M[3] / w[1], M[4] / w[1], M[5] / w[1], M[6] / w[2], M[7] / w[2], M[8] / w[2]];
    const gmin = Math.min(1 / neutral[0], 1 / neutral[1], 1 / neutral[2]);
    const gains: [number, number, number] = [1 / neutral[0] / gmin, 1 / neutral[1] / gmin, 1 / neutral[2] / gmin];
    // The gain normalisation scales the balanced data by 1/gmin; fold that into M so exposure is unchanged.
    M = m3.scale(M, gmin);
    log.push(`neutral ${neutral.map((x) => x.toFixed(4)).join(" ")} → white xy ${whiteXY.map((x) => x.toFixed(4)).join(",")} (${temp.toFixed(0)}K, tint ${tint.toFixed(1)})`);
    log.push(`matrix source ${source}; camera→Rec.2020 ${m3.fmt(M)}`);
    return { neutral, gains, cameraToWorking: M, whiteXY, temp, tint, baselineExposure: input.baselineExposure, source, log };
  }
  if (input.libraw) {
    const cm = input.libraw.camMul;
    const neutral = (neutralOverride ?? [1 / (cm[0] || 1), 1 / (cm[1] || 1), 1 / (cm[2] || 1)]) as [number, number, number];
    const mx = Math.max(...neutral);
    const n: [number, number, number] = [neutral[0] / mx, neutral[1] / mx, neutral[2] / mx];
    const rc = input.libraw.rgbCam; // 3×4 camera→sRGB (balanced)
    let M = m3.mul(SRGB_TO_REC2020, [rc[0], rc[1], rc[2], rc[4], rc[5], rc[6], rc[8], rc[9], rc[10]]);
    const gmin = Math.min(1 / n[0], 1 / n[1], 1 / n[2]);
    const gains: [number, number, number] = [1 / n[0] / gmin, 1 / n[1] / gmin, 1 / n[2] / gmin];
    M = m3.scale(M, gmin);
    log.push(`LibRaw rgb_cam path; multipliers ${cm.map((x) => x.toFixed(3)).join(" ")}`);
    return { neutral: n, gains, cameraToWorking: M, whiteXY: [0.3127, 0.329], temp: 6504, tint: 0, baselineExposure: input.baselineExposure, source: "libraw-rgb-cam", log };
  }
  return { neutral: [1, 1, 1], gains: [1, 1, 1], cameraToWorking: [...m3.IDENTITY], whiteXY: [0.3127, 0.329], temp: 6504, tint: 0, baselineExposure: 0, source: "identity", log: ["no colour metadata"] };
}

/** Builds CameraColorInput from LibRaw metadata. */
export function cameraColorFromLibRaw(meta: import("../decode/types.ts").LibRawMeta): CameraColorInput {
  const c = meta.color;
  const lv = c.dngLevels;
  const illuminants: NonNullable<CameraColorInput["dng"]>["illuminants"] = [];
  for (const d of [c.dng1, c.dng2]) {
    if (!d || m3.isZero(d.colorMatrix.slice(0, 9))) continue;
    illuminants.push({
      cct: illuminantCCT(d.illuminant) ?? 5000,
      colorMatrix: d.colorMatrix,
      forwardMatrix: m3.isZero(d.forwardMatrix) ? undefined : d.forwardMatrix,
      calibration: m3.isZero(d.calibration) ? undefined : d.calibration,
    });
  }
  const isDng = meta.idata.dngVersion > 0 && illuminants.length > 0;
  const ab = lv.analogBalance;
  const asn = lv.asShotNeutral;
  return {
    dng: isDng
      ? {
          illuminants,
          analogBalance: [ab[0] || 1, ab[1] || 1, ab[2] || 1],
          asShotNeutral: asn[0] > 0 && asn[1] > 0 && asn[2] > 0 ? [asn[0], asn[1], asn[2]] : undefined,
        }
      : undefined,
    libraw: { rgbCam: c.rgbCam, camMul: [c.camMul[0], c.camMul[1], c.camMul[2]] },
    baselineExposure: isDng ? lv.baselineExposure || 0 : 0,
  };
}
