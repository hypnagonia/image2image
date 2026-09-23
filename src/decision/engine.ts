/**
 * Module: Automatic Decision Engine.
 *
 *   in:  AnalysisReport (+ camera colour, RAW metadata)
 *   out: Params + a Decision trace explaining every automatic value
 *
 * Principle: semantic class decides *which* operations are appropriate for a
 * region, measurement decides *how much*, depth provides spatial context.
 * There are no fixed per-class corrections ("sky = highlights −30"): every
 * number below is a function of what was measured in this photograph, and
 * falls to zero when the measured condition is absent.
 *
 * All rules are deterministic and small; the constants are named, and each
 * decision records the inputs it used (see the Debug panel in the app).
 */
import { GROUPS, type Group } from "../neural/scene.ts";
import { defaultParams, neutralSemantic, type Decision, type Params } from "./params.ts";
import type { AnalysisReport, RegionStats } from "../analysis/types.ts";
import { noiseAt, BLUR_THRESHOLD } from "../analysis/analysis.ts";
import { lchOf } from "../color/oklab.ts";
import type { CameraColor } from "../color/dng.ts";
import { mulVec, inverse } from "../color/mat3.ts";

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Minimum area for a region to be considered at all. */
const MIN_AREA = 0.01;
/** How much each class matters when deciding overall exposure. */
const EXPOSURE_IMPORTANCE: Record<Group, number> = {
  person: 3, animal: 2.5, vehicle: 1.5, building: 1.2, vegetation: 1, terrain: 1, interior: 1, other: 1, ground: 0.8, water: 0.8, sky: 0.35,
};
/** Middle grey the renderer's tone curve maps to display ~46% (sRGB-encoded). */
export const MIDDLE_GREY = 0.18;

export interface EngineContext {
  report: AnalysisReport;
  camera?: CameraColor;
  referred: "scene" | "display";
  isProRaw: boolean;
  iso?: number;
  /** Apply the suggested exposure correction (off by default: the camera's exposure is kept). */
  autoExposure?: boolean;
  /** Camera neutral → rendering temperature/tint (DNG colour model). */
  solveNeutral?: (neutral: number[]) => { temp: number; tint: number };
}

export interface Plan {
  /** Fast GPU denoise (always safe on phones). */
  denoise: boolean;
  /** Neural denoise — never automatic; only when the user asks (desktop). */
  scunet: boolean;
  nafnet: boolean;
  /** Tile strength for SCUNet / NAFNet given a tile rectangle (working px). */
  denoiseTile: (x: number, y: number, size: number) => number;
  deblurTile: (x: number, y: number, size: number) => number;
}

export interface DecisionResult {
  params: Params;
  decisions: Decision[];
  plan: Plan;
  /** Conservative exposure correction the engine would apply with Auto exposure on (EV). */
  exposureSuggestion: number;
  /** Automatic depth-of-field justification (not applied unless enabled). */
  dofSuggestion: { justified: boolean; focus: number; strength: number; reason: string; x?: number; y?: number; zoneEdges?: number[]; zones?: Array<{ share: number; label: string; lo: number; hi: number }> };
}

export function decide(ctx: EngineContext): DecisionResult {
  const { report: R } = ctx;
  const p = defaultParams();
  const D: Decision[] = [];
  const note = (id: string, value: Decision["value"], reason: string, inputs: Decision["inputs"] = {}) => D.push({ id, value, reason, inputs });
  const G = R.groups;
  const present = (g: Group) => G[g].area >= MIN_AREA;

  // ------------------------------------------------------------------ exposure
  // Subject key: importance- and nearness-weighted mean log luminance.
  let wsum = 0, ksum = 0;
  for (const g of GROUPS) {
    const s = G[g];
    if (s.area < 0.002) continue;
    const w = s.area * EXPOSURE_IMPORTANCE[g] * (1.3 - 0.6 * clamp(s.dist, 0, 1));
    wsum += w;
    ksum += w * s.meanEV;
  }
  const keyEV = wsum > 0 ? ksum / wsum : R.global.meanEV;
  const keyY = Math.pow(2, keyEV);
  // Dim scenes keep their mood: only part of the gap to middle grey is closed.
  const p95 = R.lum.p95;
  const dim = smooth(-2.5, -5.5, Math.log2(p95)); // 0 = normal, 1 = genuinely dark scene
  const night = dim > 0.5 && R.lum.p999 / Math.max(R.lum.p50, 1e-6) > 64;
  let exposureSuggestion = 0;
  // Exposure is the camera's call. A ProRAW already carries Apple's metered
  // exposure (BaselineExposure), and re-targeting every frame to middle grey
  // flattens deliberate low- and high-key shots. So the engine only *suggests*
  // a correction, and only when the subject key falls outside a comfortable
  // band — never by more than 1 EV. It is applied only when Auto exposure is on.
  const bandLo = Math.log2(MIDDLE_GREY) - 1.6, bandHi = Math.log2(MIDDLE_GREY) + 1.0;
  let sug = keyEV < bandLo ? (bandLo - keyEV) * 0.5 : keyEV > bandHi ? (bandHi - keyEV) * 0.5 : 0;
  sug *= 1 - 0.6 * dim; // dim scenes keep their mood
  const headroomEV = 2.3 - Math.log2(Math.max(R.lum.p999, 1e-6));
  if (sug > 0) sug = Math.min(sug, Math.max(headroomEV + 1.0, 0)); // don't blow highlights to lift shadows
  sug = clamp(sug, -1, 1);
  if (Math.abs(sug) < 0.15) sug = 0;
  exposureSuggestion = Math.round(sug * 100) / 100;
  p.exposure = ctx.autoExposure ? exposureSuggestion : 0;
  // Local tone compression pulls the scene toward this anchor, so it must be the
  // luminance the subject is *displayed* at — the comfortable band — not the
  // measured key. With an underexposed frame (key well below the band) an
  // unclamped anchor drags the highlights down toward the dark subject and
  // barely lifts the shadows: the photograph comes out dim with flat shadows.
  p.local.anchorEV = r2(clamp(clamp(keyEV + p.exposure, bandLo, bandHi) - p.exposure, -7, 0));
  note("exposure", p.exposure,
    (ctx.autoExposure ? "auto exposure on: " : "camera exposure kept; ") +
    `subject key ${keyEV.toFixed(2)} EV (comfortable band ${bandLo.toFixed(1)}…${bandHi.toFixed(1)} EV)` +
    (exposureSuggestion !== 0 ? `; suggested ${exposureSuggestion > 0 ? "+" : ""}${exposureSuggestion} EV` : "; no correction needed") +
    (dim > 0.05 ? `; dim scene (${(dim * 100).toFixed(0)}%)` : "") + (night ? "; night scene" : ""),
    { keyEV: r2(keyEV), p50EV: r2(Math.log2(R.lum.p50)), p95EV: r2(Math.log2(p95)), p999EV: r2(Math.log2(R.lum.p999)), dim: r2(dim), suggested: exposureSuggestion });

  // ----------------------------------------------------------- white balance
  const camT = ctx.camera?.temp ?? 6504, camTint = ctx.camera?.tint ?? 0;
  p.wb = { temp: camT, tint: camTint };
  {
    // Neutral candidates: classes that are usually achromatic *and* measured low-chroma.
    const cands: Group[] = ["building", "ground", "terrain", "interior", "other", "vehicle"];
    let wr = 0, acc = [0, 0, 0];
    const used: string[] = [];
    for (const g of cands) {
      const s = G[g];
      if (s.area < MIN_AREA || s.clipHi > 0.3) continue;
      const { C } = lchOf(s.rgb);
      if (C > 0.07) continue; // clearly coloured material, not a neutral reference
      const w = s.area * (1 - C / 0.07);
      const y = Math.max(1e-6, 0.2627 * s.rgb[0] + 0.678 * s.rgb[1] + 0.0593 * s.rgb[2]);
      acc = acc.map((a, i) => a + (w * s.rgb[i]) / y);
      wr += w;
      used.push(g);
    }
    const scene: "scene" | "display" = ctx.referred;
    const baseStrength = ctx.isProRaw ? 0.35 : scene === "display" ? 0.3 : 0.5;
    if (wr > 0.05 && ctx.camera) {
      const cast = acc.map((a) => a / wr);
      // Cast expressed as a camera-space neutral change: new neutral ∝ neutral · M⁻¹·cast.
      const M = ctx.camera.cameraToWorking;
      const camCast = mulVec(inverse(M), cast);
      const g = camCast[1] || 1;
      const rel = camCast.map((v) => v / g);
      const castLch = lchOf(cast);
      // Intentional illumination: warm casts in dim or golden light are kept.
      const warm = castLch.h > 30 && castLch.h < 110;
      const keep = warm ? 0.5 + 0.4 * dim : 0;
      const conf = clamp(wr / 0.25, 0, 1);
      const strength = baseStrength * conf * (1 - keep);
      const n0 = ctx.camera.neutral;
      const n1 = n0.map((v, i) => v * (1 + (rel[i] - 1) * strength));
      p.wb = approxTempTint(ctx, n1);
      // Guard: never move more than ±900 K / ±12 tint from the camera.
      p.wb.temp = clamp(p.wb.temp, camT - 900, camT + 900);
      p.wb.tint = clamp(p.wb.tint, camTint - 12, camTint + 12);
      p.wb.temp = Math.round(p.wb.temp);
      p.wb.tint = r2(p.wb.tint);
      note("wb", [p.wb.temp, p.wb.tint],
        `camera ${Math.round(camT)}K/${camTint.toFixed(1)}; neutral references (${used.join(", ")}) show a cast of chroma ${castLch.C.toFixed(3)} at hue ${castLch.h.toFixed(0)}°; ` +
        `corrected ${(strength * 100).toFixed(0)}%` + (keep > 0 ? ` (warm light partly kept as intentional)` : ""),
        { camT: Math.round(camT), camTint: r2(camTint), castC: r3(castLch.C), castH: Math.round(castLch.h), refArea: r2(wr), strength: r2(strength) });
    } else {
      note("wb", [Math.round(camT), r2(camTint)], ctx.camera ? "no reliable neutral reference in the scene — camera white balance kept" : "display-referred source — white balance kept",
        { refArea: r2(wr) });
    }
  }

  // ------------------------------------------------------------------- tone
  const evAdj = p.exposure;
  const drEV = Math.log2(R.lum.p999 / Math.max(R.lum.p01, 1e-6));
  p.local.compression = r2(clamp((drEV - 6.5) / 9, 0, 0.55));
  note("local.compression", p.local.compression, `scene range p0.1–p99.9 = ${drEV.toFixed(1)} EV; display comfortably holds ≈ 6.5 EV before local compression helps`, { rangeEV: r2(drEV) });

  const hiEV = Math.log2(R.lum.p999) + evAdj; // brightest meaningful highlight after exposure
  const clip = R.global.clipHi;
  p.tone.highlights = r2(-clamp(smooth(0.3, 2.5, hiEV) * 0.8 + clip * 1.5, 0, 0.9));
  note("tone.highlights", p.tone.highlights,
    `p99.9 at ${hiEV.toFixed(2)} EV relative to white after exposure; ${(clip * 100).toFixed(1)}% of the frame clipped in the source (not recoverable — only rolled off)`,
    { hiEV: r2(hiEV), clipped: r3(clip) });

  const loEV = Math.log2(R.lum.p05) + evAdj;
  // Shadow lift is capped by noise: lifting noisy shadows reveals noise.
  const shNoise = R.noise.shadow;
  const noiseCap = 1 - smooth(0.004, 0.02, shNoise);
  p.tone.shadows = r2(clamp(smooth(-3.5, -7.5, loEV) * 0.55, 0, 0.55) * noiseCap * (1 - 0.5 * dim));
  note("tone.shadows", p.tone.shadows, `p5 at ${loEV.toFixed(2)} EV after exposure; shadow noise σ ${(shNoise * 255).toFixed(2)}/255 caps the lift at ${(noiseCap * 100).toFixed(0)}%`,
    { p5EV: r2(loEV), shadowNoise255: r2(shNoise * 255), dim: r2(dim) });

  p.tone.blacks = r2(clamp(-(R.global.clipLo - 0.002) * 20, -0.3, 0) + (R.global.clipLo < 0.0005 && loEV > -6 ? -0.08 : 0));
  note("tone.blacks", p.tone.blacks, `${(R.global.clipLo * 100).toFixed(2)}% of pixels already at black`, { clipLo: r3(R.global.clipLo) });
  p.tone.whites = 0;
  // Global contrast: flat scenes (low log-spread) get a little more, contrasty ones none.
  const spread = R.global.sdEV;
  p.tone.contrast = r2(clamp((1.6 - spread) * 0.12, -0.1, 0.18));
  p.tone.rolloff = r2(clamp(0.45 + 0.4 * smooth(0.5, 2.5, hiEV), 0.4, 0.9));
  note("tone.contrast", p.tone.contrast, `log-luminance spread ${spread.toFixed(2)} EV (flat < 1.6 EV)`, { sdEV: r2(spread) });

  const lc = R.global.localContrast;
  p.local.clarity = r2(clamp((0.32 - lc) * 0.9, -0.1, 0.25));
  p.local.texture = r2(clamp(0.1 - 4 * Math.max(0, R.noise.mid - 0.004), 0, 0.15));
  note("local.clarity", p.local.clarity, `mean medium-scale local contrast ${lc.toFixed(2)} EV (target ≈ 0.32 EV)`, { localContrastEV: r2(lc) });
  note("local.texture", p.local.texture, `fine texture boost limited by noise σ ${(R.noise.mid * 255).toFixed(2)}/255`, { noise255: r2(R.noise.mid * 255) });

  // ------------------------------------------------------------------- colour
  const C = R.global.chroma;
  p.color.vibrance = r2(clamp((0.075 - C) / 0.075, -0.3, 1) * 0.35);
  p.color.saturation = r2(clamp((0.06 - C) * 1.5, -0.1, 0.06));
  note("color.vibrance", p.color.vibrance, `mean displayed chroma ${C.toFixed(3)} (natural target ≈ 0.075)`, { chroma: r3(C) });

  // --------------------------------------------------------------- denoise
  // Visibility of noise after the chosen exposure: σ scales with 2^EV in linear,
  // roughly 2^(EV/2.4) in the encoded domain.
  const expGain = Math.pow(2, Math.max(0, evAdj) / 2.4) * (1 + p.tone.shadows * 0.6);
  const sMid = R.noise.mid * expGain, sSh = R.noise.shadow * expGain * (1 + p.tone.shadows);
  const sC = R.noise.chroma * expGain;
  p.denoise.luma = r2(smooth(0.0025, 0.012, Math.max(sMid, 0.7 * sSh)) * 0.9);
  p.denoise.chroma = r2(smooth(0.002, 0.008, sC) * 1.0);
  p.denoise.shadowBoost = r2(clamp((sSh - sMid) / Math.max(sMid, 1e-4), 0, 1) * 0.5);
  note("denoise", [p.denoise.luma, p.denoise.chroma],
    `measured noise (encoded, after exposure/shadow lift) σ mid ${(sMid * 255).toFixed(2)}/255, shadows ${(sSh * 255).toFixed(2)}/255, chroma ${(sC * 255).toFixed(2)}/255` +
    (ctx.isProRaw ? " — ProRAW is already noise-reduced by Apple, so this is residual noise" : ""),
    { sigmaMid255: r2(sMid * 255), sigmaShadow255: r2(sSh * 255), sigmaChroma255: r2(sC * 255), iso: ctx.iso ?? 0 });

  // --------------------------------------------------------------- deblur
  const blur = R.blur;
  p.deblur.strength = r2(smooth(BLUR_THRESHOLD, 2.6, blur.median) * 0.8);
  note("deblur", p.deblur.strength, blur.edgeBlocks < 20 ? "too few edges to judge sharpness — restoration off" :
    `median blur σ ≈ ${blur.median.toFixed(2)} px over ${blur.edgeBlocks} edge blocks; ${(blur.blurredFraction * 100).toFixed(0)}% above ${BLUR_THRESHOLD}px`,
    { blurMedian: r2(blur.median), blurredFraction: r2(blur.blurredFraction), edgeBlocks: blur.edgeBlocks });
  if (blur.edgeBlocks < 20) p.deblur.strength = 0;

  // --------------------------------------------------------------- sharpen
  const noiseGate = 1 - smooth(0.004, 0.015, sMid * (1 - p.denoise.luma * 0.7));
  const baseSharp = ctx.isProRaw ? 0.35 : ctx.referred === "display" ? 0.15 : 0.5;
  p.sharpen.amount = r2(clamp(baseSharp + 0.25 * clamp(blur.median - 1.0, -0.5, 1.2), 0.05, 0.8) * noiseGate * (1 - 0.5 * p.deblur.strength));
  p.sharpen.radius = r2(clamp(0.7 + 0.25 * (blur.median || 1), 0.7, 1.4));
  p.sharpen.threshold = r3(Math.max(0.003, 2.5 * sMid * (1 - 0.6 * p.denoise.luma)));
  note("sharpen", [p.sharpen.amount, p.sharpen.radius],
    `${ctx.isProRaw ? "ProRAW (lightly sharpened by Apple)" : ctx.referred === "display" ? "processed HEIC/JPEG (already sharpened)" : "unsharpened RAW"}; blur σ ${r2(blur.median || 0)} px; noise gate ${(noiseGate * 100).toFixed(0)}%`,
    { blur: r2(blur.median || 0), noiseGate: r2(noiseGate), threshold: p.sharpen.threshold });

  // --------------------------------------------------------------- dehaze
  {
    const far = (["terrain", "building", "vegetation", "water"] as Group[]).filter((g) => present(g) && G[g].dist > 0.55);
    const near = (["terrain", "building", "vegetation", "ground", "person", "vehicle", "interior", "other"] as Group[]).filter((g) => present(g) && G[g].dist < 0.45);
    const wmean = (gs: Group[], f: (s: RegionStats) => number) => {
      let a = 0, w = 0;
      for (const g of gs) { a += G[g].area * f(G[g]); w += G[g].area; }
      return w > 0 ? a / w : NaN;
    };
    const dcFar = wmean(far, (s) => s.darkChannel), dcNear = wmean(near, (s) => s.darkChannel);
    const lcFar = wmean(far, (s) => s.localContrast), lcNear = wmean(near, (s) => s.localContrast);
    let score = 0;
    let why = "no distant landscape/architecture — nothing to dehaze";
    if (far.length && Number.isFinite(dcFar)) {
      const veil = smooth(0.18, 0.45, dcFar - (Number.isFinite(dcNear) ? dcNear * 0.5 : 0));
      const flat = Number.isFinite(lcNear) && lcNear > 0 ? smooth(0.1, 0.6, 1 - lcFar / lcNear) : 0.5;
      score = veil * flat;
      why = `distant regions (${far.join(", ")}) dark channel ${dcFar.toFixed(2)} vs near ${Number.isFinite(dcNear) ? dcNear.toFixed(2) : "–"}; local contrast far/near ${Number.isFinite(lcNear) ? (lcFar / lcNear).toFixed(2) : "–"}`;
    }
    // Never remove atmosphere completely: cap at 0.55 of the physical model.
    p.dehaze.strength = r2(clamp(score, 0, 1) * 0.55);
    const A = R.atmosphere.light;
    const skyA = present("sky") ? G.sky.rgb : undefined;
    p.dehaze.light = (skyA ? A.map((a) => a * 0.5 + 0.5 * Math.min(1, a)) : A).map(r3) as [number, number, number];
    p.dehaze.beta = r2(1.2 + 1.2 * score);
    note("dehaze", p.dehaze.strength, why, { dcFar: r3(dcFar || 0), dcNear: r3(dcNear || 0), lcFar: r3(lcFar || 0), lcNear: r3(lcNear || 0) });
  }

  // --------------------------------------------------------------- depth
  // Distant things get less micro-contrast and sharpening than near ones, in
  // proportion to how much depth range the scene actually has.
  const dRange = R.global.distSd;
  p.depth.near = r2(1 + 0.15 * smooth(0.1, 0.3, dRange));
  p.depth.far = r2(1 - 0.45 * smooth(0.1, 0.3, dRange));
  note("depth", [p.depth.near, p.depth.far], `depth spread σ ${dRange.toFixed(2)} (0 = flat scene)`, { distSd: r2(dRange) });

  // --------------------------------------------------------------- semantic
  for (const g of GROUPS) {
    const s = G[g];
    const a = neutralSemantic();
    p.semantic[g] = a;
    if (s.area < MIN_AREA) continue;
    const lch = lchOf(s.rgb);
    const why: string[] = [];
    switch (g) {
      case "sky": {
        // Highlight control only where the sky is actually bright after exposure.
        const skyEV = s.meanEV + evAdj;
        a.highlights = r2(clamp(smooth(-1.2, 0.8, skyEV) * 0.5 + s.clipHi, 0, 0.8));
        if (a.highlights > 0) why.push(`sky at ${skyEV.toFixed(2)} EV, ${(s.clipHi * 100).toFixed(0)}% clipped → highlight control ${a.highlights}`);
        // Saturation toward a natural sky chroma, only if the sky is blue-ish.
        if (lch.h > 200 && lch.h < 290) {
          a.saturation = r2(clamp((0.09 - lch.C) * 2.5, -0.1, 0.18));
          why.push(`blue sky chroma ${lch.C.toFixed(3)} → saturation ${a.saturation}`);
        }
        a.sharpen = 0.05; a.texture = 0.2; a.clarity = 0.3;
        a.denoise = r2(1 + 0.4 * smooth(0.002, 0.01, sMid)); // smooth gradients show noise most
        a.dehaze = 0.2;
        why.push("smooth gradient: minimal sharpening/texture, stronger denoise");
        break;
      }
      case "vegetation": {
        // Hue correction: phone greens lean yellow; pull hue toward ~128° when measured yellower.
        if (lch.h > 85 && lch.h < 125 && lch.C > 0.03) {
          a.hue = r2(clamp((122 - lch.h) * 0.25, 0, 5));
          why.push(`foliage hue ${lch.h.toFixed(0)}° (yellowish) → +${a.hue}°`);
        }
        a.saturation = r2(clamp((0.085 - lch.C) * 1.2, -0.12, 0.08));
        a.texture = r2(1 + 0.3 * (1 - smooth(0.004, 0.012, sMid)));
        a.clarity = 1.1; a.sharpen = 1.05; a.denoise = r2(0.6 + 0.4 * smooth(0.02, 0.06, 0.03 - s.texture));
        why.push(`chroma ${lch.C.toFixed(3)} → saturation ${a.saturation}; texture ×${a.texture}; denoise ×${a.denoise} (keeps leaf detail)`);
        break;
      }
      case "building": {
        a.texture = 1.2; a.clarity = 1.15; a.sharpen = 1.15; a.denoise = 0.8;
        a.highlights = r2(clamp(s.clipHi * 1.5 + smooth(0, 1.5, s.meanEV + evAdj) * 0.2, 0, 0.5));
        why.push(`architecture: texture/edges; highlight control ${a.highlights} from ${(s.clipHi * 100).toFixed(0)}% clipped`);
        break;
      }
      case "water": {
        a.highlights = r2(clamp(smooth(-0.5, 1.5, s.meanEV + evAdj) * 0.4 + s.clipHi, 0, 0.7));
        a.saturation = r2(clamp((0.07 - lch.C) * 1.2, -0.08, 0.08));
        a.clarity = 0.9; a.sharpen = 0.5; a.texture = 0.8;
        why.push(`specular highlights ${a.highlights}; colour ${a.saturation}`);
        break;
      }
      case "person": {
        // Natural skin: no extra saturation/texture; gentle fill light if the subject is underexposed vs the scene.
        const under = (keyEV - s.meanEV);
        a.exposure = r2(clamp((under - 0.6) * 0.45, 0, 0.7));
        a.saturation = r2(clamp((0.06 - lch.C) * 0.5, -0.06, 0));
        a.vibrance = -0.6; a.texture = 0.25; a.clarity = 0.35; a.sharpen = 0.55; a.denoise = 1.0; a.dehaze = 0.3;
        why.push(`people: skin protected (vibrance ×0.4, texture ×0.25)` + (a.exposure > 0 ? `; ${under.toFixed(2)} EV darker than the scene key → +${a.exposure} EV fill` : ""));
        break;
      }
      case "animal": a.texture = 1.0; a.sharpen = 0.9; a.vibrance = -0.3; break;
      case "vehicle": a.clarity = 0.9; a.sharpen = 1.0; a.highlights = r2(clamp(s.clipHi * 1.5, 0, 0.5)); break;
      case "terrain": a.texture = 1.2; a.clarity = 1.15; a.sharpen = 1.05; a.denoise = 0.75; break;
      case "ground": a.texture = 0.9; a.sharpen = 0.85; break;
      case "interior": a.clarity = 0.85; a.sharpen = 0.85; break;
      case "other": break;
    }
    // Texture-poor, noisy regions: less sharpening/texture whatever the class.
    if (s.texture < 0.01 && g !== "sky") {
      a.sharpen = r2(a.sharpen * 0.6);
      a.texture = r2(a.texture * 0.7);
      why.push(`smooth region (texture ${s.texture.toFixed(3)}) → less sharpening`);
    }
    if (why.length) note(`semantic.${g}`, JSON.stringify(a), why.join("; "), { area: r2(s.area), meanEV: r2(s.meanEV), chroma: r3(lch.C), hue: Math.round(lch.h), dist: r2(s.dist) });
  }

  // --------------------------------------------------------------- DoF suggestion
  let dof = { justified: false, focus: 0.3, strength: 0, reason: "" };
  {
    const subj = (["person", "animal"] as Group[]).filter((g) => G[g].area > 0.06 && G[g].area < 0.6).sort((a, b) => G[b].area - G[a].area)[0];
    const bgDist = R.global.dist;
    if (subj && G[subj].dist < 0.4 && bgDist - G[subj].dist > 0.25 && R.global.distSd > 0.18) {
      dof = { justified: true, focus: r2(G[subj].dist), strength: r2(clamp((bgDist - G[subj].dist) * 1.5, 0.3, 0.9)), reason: `${subj} subject at distance ${G[subj].dist.toFixed(2)} with background at ${bgDist.toFixed(2)}` };
    } else {
      dof.reason = "no near subject clearly separated from a distant background";
    }
    p.dof.focus = dof.focus;
    note("dof", dof.justified ? "suggested" : "not justified", dof.reason, {});
  }

  // --------------------------------------------------------------- plan
  const plan = makePlan(ctx, p);
  note("plan", [plan.denoise ? "GPU denoise" : "-", plan.nafnet ? "NAFNet" : "-"].join(" "),
    `${plan.denoise ? "noise-adaptive GPU denoise (blended per region by the decided strength)" : "noise below visibility — no denoise"}; ${plan.nafnet ? "restoration on tiles measured as blurred" : "image is sharp enough — NAFNet skipped"}`, {});
  return { params: p, decisions: D, plan, dofSuggestion: dof, exposureSuggestion };
}

function approxTempTint(ctx: EngineContext, neutral: number[]): { temp: number; tint: number } {
  return ctx.solveNeutral ? ctx.solveNeutral(neutral) : { temp: ctx.camera?.temp ?? 6504, tint: ctx.camera?.tint ?? 0 };
}

function makePlan(ctx: EngineContext, p: Params): Plan {
  const R = ctx.report;
  const g = R.blocks;
  // Max over the blocks a tile covers.
  const over = (x: number, y: number, size: number, f: (i: number) => number) => {
    const b0x = Math.floor(x / g.size), b1x = Math.min(g.bw - 1, Math.floor((x + size - 1) / g.size));
    const b0y = Math.floor(y / g.size), b1y = Math.min(g.bh - 1, Math.floor((y + size - 1) / g.size));
    let m = 0;
    for (let by = b0y; by <= b1y; by++) for (let bx = b0x; bx <= b1x; bx++) {
      const v = f(by * g.bw + bx);
      if (v > m) m = v;
    }
    return m;
  };
  const denoise = p.denoise.luma > 0.08 || p.denoise.chroma > 0.15;
  const scunet = false;
  const nafnet = p.deblur.strength > 0.05;
  const expGain = Math.pow(2, Math.max(0, p.exposure) / 2.4) * (1 + p.tone.shadows);
  return {
    denoise,
    scunet,
    nafnet,
    denoiseTile: (x, y, size) => {
      if (!scunet) return 0;
      // Local noise relative to visibility; the render-time blend applies the final strength.
      const n = over(x, y, size, (i) => {
        const r = g.data.subarray(i * 16, i * 16 + 16);
        return Math.max(noiseAt(R.noise, r[0]), r[2] * 0.8) * expGain;
      });
      return n > 0.0022 ? 1 : 0;
    },
    deblurTile: (x, y, size) => {
      if (!nafnet) return 0;
      const s = over(x, y, size, (i) => (Number.isFinite(R.blur.perBlock[i]) ? R.blur.perBlock[i] : 0));
      return smooth(BLUR_THRESHOLD, 2.6, s) * p.deblur.strength / 0.8;
    },
  };
}
