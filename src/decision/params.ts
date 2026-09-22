/**
 * Processing parameters — the single contract between the decision engine
 * (which produces them from measurements) and the renderer (which applies
 * them). Everything here is plain data so that it can be logged, diffed,
 * edited in the UI and serialised with an export.
 */
import { GROUPS, type Group } from "../neural/scene.ts";
import type { LookProfile } from "../looks/profile.ts";
import { BUILTIN_PROFILES, DEFAULT_PROFILE_ID } from "../looks/builtin.ts";

export interface CurvePoint { x: number; y: number }

/** A user-chosen focus point: position in the image (0..1) and the refined distance there. */
export interface FocusPoint { x: number; y: number; dist: number }

export const MAX_FOCUS_POINTS = 8;

export interface SemanticAdjust {
  /** Local exposure offset (EV), e.g. a backlit person. */
  exposure: number;
  /** Extra highlight compression for this region (0..1). */
  highlights: number;
  /** Saturation multiplier delta (0 = unchanged, +0.1 = ×1.1). */
  saturation: number;
  vibrance: number;
  /** OkLab hue rotation in degrees. */
  hue: number;
  /** Multipliers applied to the global value (1 = unchanged). */
  clarity: number;
  texture: number;
  sharpen: number;
  denoise: number;
  dehaze: number;
  /** Colour temperature (−1 cool … +1 warm) and tint (−1 green … +1 magenta) of this region. */
  warmth: number;
  tint: number;
}

export interface Params {
  /** Master switch per stage (for A/B debugging). */
  enable: {
    denoise: boolean; deblur: boolean; wb: boolean; exposure: boolean; localTone: boolean;
    curves: boolean; lut: boolean; semantic: boolean; dehaze: boolean; sharpen: boolean; dof: boolean;
  };
  exposure: number;
  /** Absolute rendering white: temperature (K) and tint. */
  wb: { temp: number; tint: number };
  tone: {
    highlights: number; // −1..1  (negative recovers/compresses)
    shadows: number; // −1..1  (positive lifts)
    whites: number; // −1..1
    blacks: number; // −1..1
    contrast: number; // −1..1
    rolloff: number; // 0..1 shoulder softness
  };
  local: {
    /** Compression of the large-scale (coarse base) log range, 0..0.8. */
    compression: number;
    /** Medium-scale detail gain (clarity), −0.5..1. */
    clarity: number;
    /** Fine detail gain (texture), −0.5..1. */
    texture: number;
    /** Pivot of range compression and shadows/highlights: the scene's own key
     * (log2 luminance, before exposure) — not a fixed middle grey. */
    anchorEV: number;
  };
  color: { saturation: number; vibrance: number };
  curves: { l: CurvePoint[]; r: CurvePoint[]; g: CurvePoint[]; b: CurvePoint[] };
  /** The creative layer: one look profile on top of the technical base. */
  profile: LookProfile;
  denoise: { luma: number; chroma: number; shadowBoost: number };
  deblur: { strength: number };
  sharpen: { amount: number; radius: number; threshold: number };
  dehaze: { strength: number; light: [number, number, number]; beta: number; minT: number };
  semantic: Record<Group, SemanticAdjust>;
  depth: { near: number; far: number };
  /**
   * Depth of field. With no `points`, `focus` (automatic) is the single focal
   * distance. With points, a pixel stays sharp if it is near the distance of
   * *any* point — several subjects at different distances can all be sharp,
   * which no single focal plane can do.
   */
  dof: {
    focus: number; strength: number; points: FocusPoint[]; auto: boolean;
    /** "focus": blur from the focus distance / points. "zones": blur set per depth zone by hand. */
    mode?: "focus" | "zones";
    /** Blur 0..1 for each depth zone (near → far). */
    zones?: number[];
    /** The 4 inner zone boundaries in distance units (natural breaks of this photo's depth). */
    zoneBounds?: number[];
  };
}

export function neutralSemantic(): SemanticAdjust {
  return { exposure: 0, highlights: 0, saturation: 0, vibrance: 0, hue: 0, clarity: 1, texture: 1, sharpen: 1, denoise: 1, dehaze: 1, warmth: 0, tint: 0 };
}

export function defaultParams(): Params {
  const flat: CurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  return {
    enable: { denoise: true, deblur: true, wb: true, exposure: true, localTone: true, curves: true, lut: true, semantic: true, dehaze: true, sharpen: true, dof: false },
    exposure: 0,
    wb: { temp: 6504, tint: 0 },
    tone: { highlights: 0, shadows: 0, whites: 0, blacks: 0, contrast: 0, rolloff: 0.5 },
    local: { compression: 0, clarity: 0, texture: 0, anchorEV: Math.log2(0.18) },
    color: { saturation: 0, vibrance: 0 },
    curves: { l: [...flat], r: [...flat], g: [...flat], b: [...flat] },
    profile: structuredClone(BUILTIN_PROFILES.find((q) => q.id === DEFAULT_PROFILE_ID)!),
    denoise: { luma: 0, chroma: 0, shadowBoost: 0 },
    deblur: { strength: 0 },
    sharpen: { amount: 0, radius: 1, threshold: 0.01 },
    dehaze: { strength: 0, light: [1, 1, 1], beta: 1, minT: 0.45 },
    semantic: Object.fromEntries(GROUPS.map((g) => [g, neutralSemantic()])) as Record<Group, SemanticAdjust>,
    depth: { near: 1, far: 1 },
    dof: { focus: 0.3, strength: 0, points: [], auto: false },
  };
}

/** One inspectable automatic decision. */
export interface Decision {
  id: string;
  value: number | string | boolean | number[];
  reason: string;
  inputs: Record<string, number | string>;
}
