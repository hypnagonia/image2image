/**
 * Look profiles — the creative layer.
 *
 * A profile is applied on top of the technically corrected rendering (camera
 * colour, white balance, exposure, local tone and the display rendering are
 * already done) and is never used to fix camera colour. It is a structured
 * grade, not a LUT: the 3D LUT is one component among tone, curves,
 * hue/saturation/luminance shaping, luminance-dependent colour, saturation
 * response, semantic rules and depth curves.
 *
 * Order inside the creative stage (render_tone.wgsl, `apply_profile`):
 *   profile tone curve → RGB curves → hue-dependent shaping →
 *   saturation response → colour balance (luminance-dependent) → 3D LUT →
 *   semantic rules → depth curves → intensity blend with the technical
 *   result in OkLab.
 *
 * Profiles are plain JSON (see `serialize` / `parseProfile`); a .cube file may
 * accompany one and is referenced by `lut.file`.
 */
import { linSrgbToOklab } from "../color/oklab.ts";
import { monotoneCurve } from "../render/curves.ts";
import { GROUPS, type Group } from "../neural/scene.ts";

export const HUE_RANGES = ["red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta"] as const;
export type HueRange = (typeof HUE_RANGES)[number];
/** Range centres in OkLab hue degrees (measured on sRGB primaries: red ≈ 29°, yellow ≈ 110°, blue ≈ 264°). */
export const HUE_CENTRES: Record<HueRange, number> = { red: 22, orange: 55, yellow: 100, green: 140, cyan: 195, blue: 255, violet: 295, magenta: 335 };

export const CATEGORIES = [
  "neutral", "clean digital", "soft cinematic", "warm cinematic", "cool cinematic", "muted cinematic",
  "high-contrast cinematic", "cinema palette", "pastel", "documentary", "night", "landscape", "architecture", "portrait-neutral", "custom",
] as const;
export type Category = (typeof CATEGORIES)[number];

export type RGB = [number, number, number];
export type Pt = [number, number];
/** Values at distance 0 (near), 0.5 and 1 (far), joined by a smooth monotone-cubic curve. */
export type DepthCurve = [number, number, number];

export interface HSLAdjust { hue: number; sat: number; lum: number }
/** hue in OkLab degrees; sat = chroma multiplier for colours near this anchor; weight = anchor strength. */
export interface PaletteAnchor { hue: number; sat: number; weight: number }
export const MAX_ANCHORS = 6;
const flatHue = (): Pt[] => [[0, 0.5], [1, 0.5]];
export interface SemanticLook { hue: number; sat: number; lum: number; protect: number }

/**
 * Spatial refinement of the look (all 0 … 1; 1 = the subtle upper bound, not
 * "maximum effect"). Applied after the global palette, weighted by the soft
 * semantic masks and continuous depth, and bounded — it refines the grade, it
 * never replaces it. `skin` is protection: skin keeps ~35% of the palette and
 * ~15% of every local correction, with a hue/saturation guard.
 */
export interface SpatialLook {
  semantic: { skin: number; sky: number; foliage: number; urban: number; emissive: number };
  depth: {
    foreground: number;
    background: number;
    distant: number;
    backgroundCooling: number;
    backgroundSaturation: number;
    backgroundContrast: number;
  };
}

/** Spatial refinement defaults by category: none for the technical looks, subtle for creative ones. */
export function defaultSpatial(category: Category): SpatialLook {
  const off = category === "neutral";
  const f = (v: number) => (off ? 0 : v);
  const night = category === "night";
  const landscape = category === "landscape";
  const portrait = category === "portrait-neutral";
  return {
    semantic: { skin: 1, sky: f(landscape ? 0.8 : 0.6), foliage: f(landscape ? 0.8 : 0.6), urban: f(category === "architecture" ? 0.8 : 0.5), emissive: f(night ? 1 : 0.8) },
    depth: {
      foreground: f(portrait ? 0.7 : 0.5),
      background: f(portrait ? 0.7 : 0.5),
      distant: f(landscape ? 0.7 : night ? 0.2 : 0.4),
      backgroundCooling: f(category === "warm cinematic" ? 0.3 : 0.5),
      backgroundSaturation: f(0.5),
      backgroundContrast: f(0.5),
    },
  };
}

export interface LookProfile {
  id: string;
  name: string;
  version: 1;
  category: Category;
  description?: string;
  workingSpace: "linear-wide-gamut";
  tone: {
    /** S-curve strength around the mid-tones (−0.5 … 0.8). */
    contrast: number;
    /** Output black level: > 0 lifts (matte), < 0 deepens (−0.05 … 0.15). */
    blackPoint: number;
    /** Highlight compression: how far white is pulled down / shouldered (0 … 0.6). */
    highlightCompression: number;
    /** Lift of shadow density without moving black (−0.2 … 0.3). */
    shadowLift: number;
    /** Width of the highlight shoulder (0 = hard knee near white, 1 = long soft roll-off). */
    rolloff: number;
    /** Master luminance curve control points, display-encoded [0,1]. */
    curve: Pt[];
  };
  rgbCurves: { r: Pt[]; g: Pt[]; b: Pt[] };
  hsl: Record<HueRange, HSLAdjust>;
  colorBalance: { shadows: RGB; midtones: RGB; highlights: RGB };
  saturation: {
    global: number; // multiplier
    shadows: number; // multiplier in shadows
    highlights: number; // multiplier in highlights
    /** Chroma above which colours are compressed (OkLab C). */
    knee: number;
    /** Strength of high-chroma compression (0 = none). */
    compression: number;
    /** Extra saturation for weak colours (vibrance-like). */
    lowBoost: number;
  };
  lut: { id: string | null; file?: string; size: 17 | 33 | 65; strength: number };
  semantic: Partial<Record<Group, SemanticLook>>;
  depth: { saturation?: DepthCurve; contrast?: DepthCurve; temperature?: DepthCurve; haze?: DepthCurve; blackLevel?: DepthCurve };
  /**
   * Continuous hue curves over the hue circle (x = OkLab hue / 360°, periodic;
   * y = 0.5 is "no change"): hue → hue shift (±60°), hue → saturation (×0…2),
   * hue → luminance (±0.25 OkLab L).
   */
  hueCurves: { hue: Pt[]; sat: Pt[]; lum: Pt[] };
  /**
   * Palette restriction — a film's colour script. Colours are pulled toward the
   * anchor hues (weighted by closeness, so a hue between two anchors drifts
   * toward both instead of snapping) and colours far from every anchor lose
   * saturation (`focus`).
   */
  palette: { anchors: PaletteAnchor[]; pull: number; focus: number; width: number };
  /**
   * Luminance → saturation: x = displayed lightness (OkLab L, 0…1), y = 0.5 is
   * "no change", 1 = ×2. Rich mid-tones with calmer highlights and shadows are
   * a film trait; this is the control for it.
   */
  satByLum: Pt[];
  /**
   * Opponent (warm ↔ cool) separation. `axis` is the OkLab hue of the warm
   * pole in degrees (its opposite is the cool pole); `amount` > 0 stretches
   * colour along that axis and compresses it across, so warm and cool pull
   * apart without hues being rotated; < 0 brings them together.
   */
  opponent: { axis: number; amount: number };
  /** Semantic- and depth-aware refinement of this look (see SpatialLook). */
  spatial: SpatialLook;
  intensity: number;
}

const identity = (): Pt[] => [[0, 0], [1, 1]];
const hslZero = (): Record<HueRange, HSLAdjust> => Object.fromEntries(HUE_RANGES.map((r) => [r, { hue: 0, sat: 0, lum: 0 }])) as Record<HueRange, HSLAdjust>;

export function neutralProfile(): LookProfile {
  return {
    id: "neutral",
    name: "Neutral",
    version: 1,
    category: "neutral",
    description: "No creative grade — the technically corrected rendering.",
    workingSpace: "linear-wide-gamut",
    tone: { contrast: 0, blackPoint: 0, highlightCompression: 0, shadowLift: 0, rolloff: 0.5, curve: identity() },
    rgbCurves: { r: identity(), g: identity(), b: identity() },
    hsl: hslZero(),
    colorBalance: { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0] },
    saturation: { global: 1, shadows: 1, highlights: 1, knee: 0.3, compression: 0, lowBoost: 0 },
    lut: { id: null, size: 33, strength: 1 },
    semantic: {},
    depth: {},
    hueCurves: { hue: flatHue(), sat: flatHue(), lum: flatHue() },
    palette: { anchors: [], pull: 0, focus: 0, width: 40 },
    satByLum: flatHue(),
    opponent: { axis: 65, amount: 0 },
    spatial: defaultSpatial("neutral"),
    intensity: 1,
  };
}

/** Builds a complete profile from a partial description (deep defaults). */
export function makeProfile(p: DeepPartial<LookProfile> & { id: string; name: string }): LookProfile {
  const n = neutralProfile();
  return {
    ...n,
    ...p,
    version: 1,
    workingSpace: "linear-wide-gamut",
    category: (p.category ?? "custom") as Category,
    tone: { ...n.tone, ...(p.tone as object), curve: (p.tone?.curve as Pt[]) ?? n.tone.curve },
    rgbCurves: { ...n.rgbCurves, ...(p.rgbCurves as object) },
    hsl: Object.fromEntries(HUE_RANGES.map((r) => [r, { ...n.hsl[r], ...((p.hsl?.[r] as object) ?? {}) }])) as Record<HueRange, HSLAdjust>,
    colorBalance: { ...n.colorBalance, ...(p.colorBalance as object) },
    saturation: { ...n.saturation, ...(p.saturation as object) },
    lut: { ...n.lut, ...(p.lut as object) },
    semantic: (p.semantic as LookProfile["semantic"]) ?? {},
    depth: (p.depth as LookProfile["depth"]) ?? {},
    hueCurves: { ...n.hueCurves, ...(p.hueCurves as object) },
    palette: { ...n.palette, ...(p.palette as object), anchors: ((p.palette?.anchors as PaletteAnchor[]) ?? []).slice(0, MAX_ANCHORS) },
    satByLum: (p.satByLum as Pt[]) ?? flatHue(),
    opponent: { ...n.opponent, ...(p.opponent as object) },
    spatial: (() => {
      const d = defaultSpatial((p.category ?? "custom") as Category);
      return { semantic: { ...d.semantic, ...(p.spatial?.semantic as object) }, depth: { ...d.depth, ...(p.spatial?.depth as object) } };
    })(),
    intensity: p.intensity ?? 1,
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends Array<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

// ---------------------------------------------------------------------------
// JSON import/export

export function serialize(p: LookProfile): string {
  return JSON.stringify(p, null, 2);
}

const num = (v: unknown, lo: number, hi: number, def: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
const pts = (v: unknown): Pt[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((q) => Array.isArray(q) && q.length === 2).map((q) => [num(q[0], 0, 1, 0), num(q[1], 0, 1, 0)] as Pt).sort((a, b) => a[0] - b[0]);
  return out.length >= 2 ? out : undefined;
};
const rgb = (v: unknown): RGB => (Array.isArray(v) && v.length === 3 ? (v.map((x) => num(x, -0.3, 0.3, 0)) as RGB) : [0, 0, 0]);
const dcurve = (v: unknown, lo: number, hi: number): DepthCurve | undefined => (Array.isArray(v) && v.length === 3 ? (v.map((x) => num(x, lo, hi, 0)) as DepthCurve) : undefined);

/** Parses and validates profile JSON (unknown fields ignored, values clamped). */
export function parseProfile(text: string): LookProfile {
  const j = JSON.parse(text) as Record<string, any>;
  if (!j || typeof j !== "object") throw new Error("Not a profile");
  const n = neutralProfile();
  const t = j.tone ?? {};
  const s = j.saturation ?? {};
  const hsl = hslZero();
  for (const r of HUE_RANGES) {
    const h = j.hsl?.[r];
    if (h) hsl[r] = { hue: num(h.hue, -45, 45, 0), sat: num(h.sat, -1, 1, 0), lum: num(h.lum, -0.5, 0.5, 0) };
  }
  const semantic: LookProfile["semantic"] = {};
  for (const g of GROUPS) {
    const v = j.semantic?.[g];
    if (v) semantic[g] = { hue: num(v.hue, -45, 45, 0), sat: num(v.sat, -1, 1, 0), lum: num(v.lum, -0.5, 0.5, 0), protect: num(v.protect, 0, 1, 0) };
  }
  const d = j.depth ?? {};
  const cat = CATEGORIES.includes(j.category) ? j.category : "custom";
  return {
    id: typeof j.id === "string" && j.id ? j.id.slice(0, 64) : "imported-" + Date.now(),
    name: typeof j.name === "string" && j.name ? j.name.slice(0, 64) : "Imported",
    version: 1,
    category: cat,
    description: typeof j.description === "string" ? j.description.slice(0, 300) : undefined,
    workingSpace: "linear-wide-gamut",
    tone: {
      contrast: num(t.contrast, -0.5, 0.8, 0),
      blackPoint: num(t.blackPoint, -0.05, 0.15, 0),
      highlightCompression: num(t.highlightCompression, 0, 0.6, 0),
      shadowLift: num(t.shadowLift, -0.2, 0.3, 0),
      rolloff: num(t.rolloff, 0, 1, 0.5),
      curve: pts(t.curve) ?? n.tone.curve,
    },
    rgbCurves: { r: pts(j.rgbCurves?.r) ?? identity(), g: pts(j.rgbCurves?.g) ?? identity(), b: pts(j.rgbCurves?.b) ?? identity() },
    hsl,
    colorBalance: { shadows: rgb(j.colorBalance?.shadows), midtones: rgb(j.colorBalance?.midtones), highlights: rgb(j.colorBalance?.highlights) },
    saturation: {
      global: num(s.global, 0, 2, 1), shadows: num(s.shadows, 0, 2, 1), highlights: num(s.highlights, 0, 2, 1),
      knee: num(s.knee, 0.05, 0.4, 0.3), compression: num(s.compression, 0, 3, 0), lowBoost: num(s.lowBoost, -0.5, 1, 0),
    },
    lut: {
      id: typeof j.lut?.id === "string" ? j.lut.id : typeof j.lut?.file === "string" ? "cube:" + j.lut.file.replace(/\.cube$/i, "") : null,
      file: typeof j.lut?.file === "string" ? j.lut.file : undefined,
      size: [17, 33, 65].includes(j.lut?.size) ? j.lut.size : 33,
      strength: num(j.lut?.strength, 0, 1, 1),
    },
    semantic,
    depth: {
      saturation: dcurve(d.saturation, -1, 1), contrast: dcurve(d.contrast, -0.5, 0.5), temperature: dcurve(d.temperature, -0.1, 0.1),
      haze: dcurve(d.haze, 0, 0.6), blackLevel: dcurve(d.blackLevel, -0.05, 0.15),
    },
    hueCurves: { hue: pts(j.hueCurves?.hue) ?? flatHue(), sat: pts(j.hueCurves?.sat) ?? flatHue(), lum: pts(j.hueCurves?.lum) ?? flatHue() },
    palette: {
      anchors: (Array.isArray(j.palette?.anchors) ? j.palette.anchors : []).slice(0, MAX_ANCHORS)
        .map((a: any) => ({ hue: num(a?.hue, 0, 360, 0), sat: num(a?.sat, 0, 2, 1), weight: num(a?.weight, 0, 1, 1) })),
      pull: num(j.palette?.pull, 0, 1, 0), focus: num(j.palette?.focus, 0, 1, 0), width: num(j.palette?.width, 10, 90, 40),
    },
    satByLum: pts(j.satByLum) ?? flatHue(),
    opponent: { axis: num(j.opponent?.axis, 0, 359, 65), amount: num(j.opponent?.amount, -1, 1, 0) },
    // Profiles saved before spatial refinement existed get their category's defaults.
    spatial: (() => {
      const def = defaultSpatial(cat);
      const ss = j.spatial?.semantic ?? {}, sd = j.spatial?.depth ?? {};
      const sem = def.semantic, dep = def.depth;
      return {
        semantic: { skin: num(ss.skin, 0, 1, sem.skin), sky: num(ss.sky, 0, 1, sem.sky), foliage: num(ss.foliage, 0, 1, sem.foliage), urban: num(ss.urban, 0, 1, sem.urban), emissive: num(ss.emissive, 0, 1, sem.emissive) },
        depth: {
          foreground: num(sd.foreground, 0, 1, dep.foreground), background: num(sd.background, 0, 1, dep.background), distant: num(sd.distant, 0, 1, dep.distant),
          backgroundCooling: num(sd.backgroundCooling, 0, 1, dep.backgroundCooling), backgroundSaturation: num(sd.backgroundSaturation, 0, 1, dep.backgroundSaturation),
          backgroundContrast: num(sd.backgroundContrast, 0, 1, dep.backgroundContrast),
        },
      };
    })(),
    intensity: num(j.intensity, 0, 1, 1),
  };
}

/** Fills fields missing from profiles saved by older versions (validates like an import). */
export function normalizeProfile(p: LookProfile): LookProfile {
  return parseProfile(JSON.stringify(p));
}

// ---------------------------------------------------------------------------
// Compilation to GPU data

export const PROFILE_CURVE_SIZE = 1024;
export const DEPTH_CURVE_SIZE = 64;
/** vec4 count of the profile uniform block (keep in sync with render_tone.wgsl `Prof`). */
export const PROFILE_VEC4S = 4 + 8 + 3 + 11 + 1 + MAX_ANCHORS + 3 + 1;

const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/** Parametric tone + master curve on display-encoded luminance, x ∈ [0,1]. */
export function toneFunction(t: LookProfile["tone"]): (x: number) => number {
  const pivot = 0.42;
  const master = monotoneCurve(t.curve.map(([x, y]) => ({ x, y })));
  return (x0: number) => {
    let y = x0;
    // Contrast: two-sided power curve around the pivot. Slope at the pivot is
    // g = 1 + contrast; endpoints fixed; monotone for any g > 0.
    const g = Math.max(0.2, 1 + t.contrast);
    y = y < pivot ? pivot * Math.pow(y / pivot, g) : 1 - (1 - pivot) * Math.pow((1 - y) / (1 - pivot), g);
    // Shadow density: lifts/darkens shadows while black stays at black.
    y = y + t.shadowLift * 4 * y * Math.pow(1 - y, 3);
    // Highlight shoulder: above the knee, compress toward (1 − h/2) smoothly.
    const knee = 1 - 0.15 - 0.45 * t.rolloff;
    if (y > knee && t.highlightCompression > 0) {
      const u = (y - knee) / (1 - knee);
      y = knee + (1 - knee) * (u - t.highlightCompression * 0.5 * u * u);
    }
    // Black point: soft floor (fade) or deeper blacks, never a hard clip.
    const b = t.blackPoint;
    if (b > 0) y = b + y * (1 - b);
    else if (b < 0) { const k = -b; y = y * y / (y + k) * (1 + k); }
    y = Math.min(1, Math.max(0, y));
    return Math.min(1, Math.max(0, master(y)));
  };
}

/** RGBA16F-ready curve table: R = master tone, G/B/A = red/green/blue curves. */
export function profileCurveTable(p: LookProfile): Float32Array {
  const tone = toneFunction(p.tone);
  const cs = [p.rgbCurves.r, p.rgbCurves.g, p.rgbCurves.b].map((c) => monotoneCurve(c.map(([x, y]) => ({ x, y }))));
  const out = new Float32Array(PROFILE_CURVE_SIZE * 4);
  for (let i = 0; i < PROFILE_CURVE_SIZE; i++) {
    const x = i / (PROFILE_CURVE_SIZE - 1);
    out[i * 4] = tone(x);
    for (let c = 0; c < 3; c++) out[i * 4 + 1 + c] = Math.min(1, Math.max(0, cs[c](x)));
  }
  return out;
}

/** 64×2 table over distance (0 near … 1 far): row 0 = (sat, contrast, temperature, haze), row 1 = (black, 0, 0, 0). */
export function depthTable(p: LookProfile): Float32Array {
  const f = (c: DepthCurve | undefined) => {
    if (!c) return () => 0;
    const m = monotoneCurve([{ x: 0, y: c[0] }, { x: 0.5, y: c[1] }, { x: 1, y: c[2] }]);
    return m;
  };
  const fs = [f(p.depth.saturation), f(p.depth.contrast), f(p.depth.temperature), f(p.depth.haze), f(p.depth.blackLevel)];
  const out = new Float32Array(DEPTH_CURVE_SIZE * 2 * 4);
  for (let i = 0; i < DEPTH_CURVE_SIZE; i++) {
    const d = i / (DEPTH_CURVE_SIZE - 1);
    for (let k = 0; k < 4; k++) out[i * 4 + k] = fs[k](d);
    out[(DEPTH_CURVE_SIZE + i) * 4] = fs[4](d);
  }
  return out;
}

/**
 * Smooth periodic curve through points on x ∈ [0,1] (the hue circle): cubic
 * Hermite with finite-difference tangents over the points extended by ±1.
 * The value at x = 1 wraps to x = 0.
 */
export function periodicCurve(points: Pt[]): (x: number) => number {
  const p = [...points].filter(([x]) => x < 1 - 1e-6).sort((a, b) => a[0] - b[0]);
  if (!p.length) return () => 0.5;
  if (p.length === 1) return () => p[0][1];
  const ext: Pt[] = [...p.map(([x, y]) => [x - 1, y] as Pt), ...p, ...p.map(([x, y]) => [x + 1, y] as Pt)];
  const n = ext.length;
  const m = ext.map((_, i) => {
    const a = ext[Math.max(0, i - 1)], b = ext[Math.min(n - 1, i + 1)];
    return (b[1] - a[1]) / Math.max(1e-6, b[0] - a[0]);
  });
  return (x0: number) => {
    const x = x0 - Math.floor(x0);
    let i = 0;
    while (i < n - 2 && ext[i + 1][0] <= x) i++;
    const a = ext[i], b = ext[i + 1];
    const h = b[0] - a[0];
    const t = (x - a[0]) / h, t2 = t * t, t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * a[1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * b[1] + (t3 - t2) * h * m[i + 1];
    return Math.min(1, Math.max(0, y));
  };
}

export const HUE_CURVE_SIZE = 360;

/**
 * 360×2 table. Row 0, per OkLab hue degree: (hue shift rad, chroma factor,
 * L shift, 0). Row 1, per displayed lightness (x = L): (chroma factor, 0, 0, 0).
 */
export function hueCurveTable(p: LookProfile): Float32Array {
  const fh = periodicCurve(p.hueCurves.hue), fs = periodicCurve(p.hueCurves.sat), fl = periodicCurve(p.hueCurves.lum);
  const fsl = monotoneCurve(p.satByLum.map(([x, y]) => ({ x, y })));
  const out = new Float32Array(HUE_CURVE_SIZE * 2 * 4);
  for (let i = 0; i < HUE_CURVE_SIZE; i++) {
    const x = i / HUE_CURVE_SIZE;
    out[i * 4] = ((fh(x) - 0.5) * 2 * 60 * Math.PI) / 180;
    out[i * 4 + 1] = fs(x) * 2;
    out[i * 4 + 2] = (fl(x) - 0.5) * 0.5;
    out[i * 4 + 3] = 0;
    out[(HUE_CURVE_SIZE + i) * 4] = Math.max(0, fsl(i / (HUE_CURVE_SIZE - 1)) * 2);
  }
  return out;
}

export function hasDepth(p: LookProfile): boolean {
  return Object.values(p.depth).some((c) => c && c.some((v) => Math.abs(v) > 1e-4));
}

const eotf = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

/** Colour-balance RGB offsets (display-encoded, around mid grey) → OkLab (a, b) shifts. */
export function balanceToAB(off: RGB): [number, number] {
  const grey = 0.5;
  const base = linSrgbToOklab([eotf(grey), eotf(grey), eotf(grey)]);
  const lab = linSrgbToOklab(off.map((o) => eotf(Math.min(1, Math.max(0, grey + o)))));
  return [lab[1] - base[1], lab[2] - base[2]];
}

/** Uniform block, `PROFILE_VEC4S` vec4s (see render_tone.wgsl `Prof`). */
export function profileUniforms(p: LookProfile, enabled: boolean, lutOn: boolean, lutSize: number): Float32Array {
  const u = new Float32Array(PROFILE_VEC4S * 4);
  let o = 0;
  const v4 = (a: number, b: number, c: number, d: number) => { u[o++] = a; u[o++] = b; u[o++] = c; u[o++] = d; };
  const s = p.saturation;
  // 0: flags / intensity
  v4(enabled ? 1 : 0, p.intensity, lutOn ? p.lut.strength : 0, lutSize);
  // 1: saturation response
  v4(s.global, s.knee, s.compression, s.lowBoost);
  // 2: zone saturation + depth flag
  v4(s.shadows, s.highlights, hasDepth(p) ? 1 : 0, 0);
  // 3: reserved (haze colour, OkLab a/b relative to grey)
  v4(-0.005, -0.012, 0, 0);
  // 4..11: hue ranges (hue shift rad, sat, lum, centre rad)
  for (const r of HUE_RANGES) {
    const h = p.hsl[r];
    v4((h.hue * Math.PI) / 180, h.sat, h.lum, (HUE_CENTRES[r] * Math.PI) / 180);
  }
  // 12..14: colour balance per zone (OkLab a, b offsets)
  for (const z of [p.colorBalance.shadows, p.colorBalance.midtones, p.colorBalance.highlights]) {
    const [a, b] = balanceToAB(z);
    v4(a, b, 0, 0);
  }
  // 15..25: semantic rules per group. With skin protection on, the person group's
  // old blanket "protect" is superseded (it would protect skin twice and clothes fully).
  const sp = p.spatial;
  for (const g of GROUPS) {
    const sg = p.semantic[g];
    const protect = g === "person" && sp.semantic.skin > 0 ? 0 : sg?.protect ?? 0;
    v4(sg ? (sg.hue * Math.PI) / 180 : 0, sg?.sat ?? 0, sg?.lum ?? 0, protect);
  }
  // 26: palette (anchor count, pull, focus, width rad); 27..32: anchors (hue rad, chroma ×, weight, _)
  const pal = p.palette;
  const anchors = pal.anchors.slice(0, MAX_ANCHORS);
  v4(pal.pull > 0 || pal.focus > 0 ? anchors.length : 0, pal.pull, pal.focus, (pal.width * Math.PI) / 180);
  for (let i = 0; i < MAX_ANCHORS; i++) {
    const a = anchors[i];
    v4(a ? (a.hue * Math.PI) / 180 : 0, a?.sat ?? 1, a?.weight ?? 0, 0);
  }
  // 33: opponent separation (cos, sin of the warm pole, amount)
  v4(Math.cos((p.opponent.axis * Math.PI) / 180), Math.sin((p.opponent.axis * Math.PI) / 180), p.opponent.amount, 0);
  // 34..36: spatial refinement — (skin, sky, foliage, urban), (emissive, foreground,
  // background contrast, background saturation), (background cooling, distant, _, _)
  const ss = sp.semantic, sd = sp.depth;
  v4(ss.skin, ss.sky, ss.foliage, ss.urban);
  v4(ss.emissive, sd.foreground, sd.background * sd.backgroundContrast, sd.background * sd.backgroundSaturation);
  v4(sd.background * sd.backgroundCooling, sd.distant, 0, 0);
  return u;
}

export function isNeutral(p: LookProfile): boolean {
  return p.id === "neutral" || p.intensity <= 0;
}

export const smoothstep = smooth;
