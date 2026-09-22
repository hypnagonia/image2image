/**
 * Reference-image look creation and look matching.
 *
 * Both produce an ordinary, editable LookProfile made of deterministic grading
 * parameters — never a pixel-to-pixel transfer. Matching compares statistics
 * of the *technical* rendering of the current photo with the reference and
 * moves each parameter only part of the way (scenes differ; histograms are
 * never copied blindly):
 *
 *   tone         luminance-quantile matching → master curve points (≤ 70%, capped)
 *   colour       per luminance zone mean OkLab (a,b) difference → colour balance
 *   saturation   ratio of chroma spread (covariance) → saturation response
 *   hue ranges   per range present in both images: hue offset / chroma / L
 *                differences → HSL shaping (person pixels excluded)
 *   semantic     per region present in both (sky, vegetation, water, …):
 *                region-to-region differences → semantic rules. People are
 *                never matched to anything; they get protection instead.
 */
import { makeProfile, HUE_RANGES, type LookProfile, type Pt, type RGB, type HueRange, type SemanticLook } from "./profile.ts";
import { PALETTE_HELPERS, type ColorStats } from "./palette.ts";
import { linSrgbToOklab, oklabToLinSrgb } from "../color/oklab.ts";
import type { Group } from "../neural/scene.ts";

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const { oetf, eotf } = PALETTE_HELPERS;

/** Typical values of a natural, neutrally rendered photograph (for creation without a source). */
const TYPICAL = { meanC: 0.07, lumP01: 0.02, lumP99: 0.96, iqr: 0.32, rangeC: 0.09, rangeL: 0.62 };

/** OkLab (a,b) shift around mid grey → colour-balance RGB offset (inverse of balanceToAB). */
export function abToBalance(a: number, b: number): RGB {
  const grey = 0.5;
  const base = linSrgbToOklab([eotf(grey), eotf(grey), eotf(grey)]);
  const rgb = oklabToLinSrgb([base[0], base[1] + a, base[2] + b]).map((v) => clamp(oetf(v), 0, 1) - grey);
  return rgb.map(r3) as RGB;
}

export type RegionColors = Partial<Record<Group, ColorStats>>;

/**
 * Tone character, independent of how bright the reference is (brightness is
 * exposure — a technical property — not part of a look):
 *   contrast    log-ratio of the quartiles vs a typical photograph
 *   shoulder    upper-tail shape: a compressed shoulder has a short p90→p99 span
 *               relative to p50→p90
 *   shadows     density of the lower tail relative to the median
 *   black       absolute p1 (a lifted, matte black is a look)
 */
function toneFromStats(ref: ColorStats, strength = 1) {
  const q = ref.lumQ;
  const eps = 1e-3;
  const logIqr = Math.log((q.p75 + eps) / (q.p25 + eps));
  const typicalLogIqr = Math.log(0.62 / 0.3);
  const tail = (q.p99 - q.p90) / Math.max(q.p90 - q.p50, 0.02);
  const shadowRatio = (q.p10 + eps) / (q.p50 + eps);
  return {
    blackPoint: r3(clamp((q.p01 - TYPICAL.lumP01) * 1.2 * strength, -0.03, 0.1)),
    contrast: r3(clamp((logIqr / typicalLogIqr - 1) * 0.6 * strength, -0.35, 0.4)),
    highlightCompression: r3(clamp((0.7 - tail) * 0.5 * strength, 0, 0.35)),
    shadowLift: r3(clamp((shadowRatio - 0.25) * 0.5 * strength, -0.1, 0.15)),
  };
}

function zoneBalance(z: { a: number; b: number; weight: number }, mean: readonly number[], amount: number): RGB {
  if (z.weight < 0.03) return [0, 0, 0];
  // Zone tendency relative to the image's overall cast: that is what makes a split tone.
  return abToBalance(clamp((z.a - mean[1] * 0.5) * amount, -0.04, 0.04), clamp((z.b - mean[2] * 0.5) * amount, -0.04, 0.04));
}

/** Builds an editable profile from a reference image's colour characteristics. */
export function profileFromReference(ref: ColorStats, name: string, regions?: RegionColors): LookProfile {
  const tone = toneFromStats(ref);
  const hsl = Object.fromEntries(HUE_RANGES.map((r) => {
    const s = ref.ranges[r];
    if (s.weight < 0.03) return [r, { hue: 0, sat: 0, lum: 0 }];
    return [r, {
      hue: r3(clamp(s.hueOffset * 0.5, -12, 12)),
      sat: r3(clamp((s.C / TYPICAL.rangeC - 1) * 0.5, -0.4, 0.3)),
      lum: r3(clamp((s.L - TYPICAL.rangeL) * 0.6, -0.15, 0.15)),
    }];
  })) as Record<HueRange, { hue: number; sat: number; lum: number }>;
  const z = ref.zones;
  const semantic: LookProfile["semantic"] = { person: { hue: 0, sat: 0, lum: 0, protect: 0.6 } };
  if (regions?.sky && regions.sky.n > 200) semantic.sky = { hue: 0, sat: r3(clamp((regions.sky.meanC / 0.06 - 1) * 0.3, -0.3, 0.2)), lum: 0, protect: 0 };
  if (regions?.vegetation && regions.vegetation.n > 200) semantic.vegetation = { hue: 0, sat: r3(clamp((regions.vegetation.meanC / 0.08 - 1) * 0.3, -0.3, 0.2)), lum: 0, protect: 0 };
  return makeProfile({
    id: "ref-" + Date.now().toString(36),
    name: "Ref · " + name.replace(/\.[^.]+$/, "").slice(0, 24),
    category: "custom",
    description: `Built from ${name}: palette ${ref.palette.slice(0, 5).map((p) => p.hex).join(" ")}, warm/cool ${ref.warmCool.toFixed(2)}.`,
    tone: { ...tone, rolloff: r3(clamp(0.5 + tone.highlightCompression, 0.3, 0.95)) },
    colorBalance: { shadows: zoneBalance(z.shadows, ref.mean, 0.8), midtones: zoneBalance(z.midtones, ref.mean, 0.6), highlights: zoneBalance(z.highlights, ref.mean, 0.8) },
    saturation: {
      global: r3(clamp(ref.meanC / TYPICAL.meanC, 0.5, 1.35)),
      shadows: r3(clamp(z.midtones.C > 0 ? z.shadows.C / z.midtones.C / 0.85 : 1, 0.5, 1.3)),
      highlights: r3(clamp(z.midtones.C > 0 ? z.highlights.C / z.midtones.C / 0.8 : 1, 0.5, 1.3)),
      knee: r3(clamp(ref.cQuantiles.p99 * 0.8, 0.1, 0.3)),
      compression: 1,
    },
    hsl,
    semantic,
  });
}

function quantileCurve(src: ColorStats, ref: ColorStats, amount: number): Pt[] {
  const keys: Array<keyof ColorStats["lumQ"]> = ["p05", "p25", "p50", "p75", "p95"];
  const pts: Pt[] = [[0, 0]];
  let lastX = 0, lastY = 0;
  // Shape, not brightness: the source median stays where it is and each
  // quantile's ratio to the median is matched to the reference's ratio.
  const sm = Math.max(src.lumQ.p50, 1e-3), rm = Math.max(ref.lumQ.p50, 1e-3);
  for (const k of keys) {
    const x = src.lumQ[k];
    const yRef = clamp(sm * (ref.lumQ[k] / rm), 0, 1);
    // Move part of the way, and never more than 0.15 at any point: different scenes have different histograms.
    let y = x + clamp((yRef - x) * amount, -0.15, 0.15);
    if (x <= lastX + 0.03 || x >= 0.97) continue;
    y = Math.max(y, lastY + 0.01);
    pts.push([r3(x), r3(clamp(y, 0, 1))]);
    lastX = x; lastY = y;
  }
  pts.push([1, 1]);
  return pts;
}

/** Initialises a profile that moves the source's look toward the reference. */
export function matchProfile(src: ColorStats, ref: ColorStats, name: string, srcRegions?: RegionColors, refRegions?: RegionColors, amount = 0.7): LookProfile {
  const tone = { contrast: 0, blackPoint: 0, highlightCompression: 0, shadowLift: 0, rolloff: 0.5, curve: quantileCurve(src, ref, amount) };
  const zd = (a: ColorStats["zones"]["shadows"], b: ColorStats["zones"]["shadows"]): RGB =>
    a.weight > 0.03 && b.weight > 0.03 ? abToBalance(clamp((b.a - a.a) * amount, -0.025, 0.025), clamp((b.b - a.b) * amount, -0.025, 0.025)) : [0, 0, 0];
  const cs = src.zones, cr = ref.zones;
  // Covariance-style chroma scaling: ratio of chroma spread (mean chroma as a robust proxy).
  const satRatio = src.meanC > 1e-3 ? ref.meanC / src.meanC : 1;
  const hsl = Object.fromEntries(HUE_RANGES.map((r) => {
    const a = src.ranges[r], b = ref.ranges[r];
    if (a.weight < 0.03 || b.weight < 0.03) return [r, { hue: 0, sat: 0, lum: 0 }];
    return [r, {
      hue: r3(clamp((b.hueOffset - a.hueOffset) * amount, -15, 15)),
      sat: r3(clamp((a.C > 1e-3 ? b.C / a.C - 1 : 0) * amount, -0.5, 0.5)),
      lum: r3(clamp((b.L - a.L) * amount, -0.15, 0.15)),
    }];
  })) as Record<HueRange, { hue: number; sat: number; lum: number }>;
  const semantic: LookProfile["semantic"] = { person: { hue: 0, sat: 0, lum: 0, protect: 0.75 } };
  const matched: string[] = [];
  for (const g of ["sky", "vegetation", "water", "building", "terrain", "ground"] as Group[]) {
    const a = srcRegions?.[g], b = refRegions?.[g];
    if (!a || !b || a.n < 200 || b.n < 200) continue;
    // Region-to-region only: a region is compared with the *same* kind of region in the reference.
    const ha = Math.atan2(a.mean[2], a.mean[1]), hb = Math.atan2(b.mean[2], b.mean[1]);
    let dh = ((hb - ha) * 180) / Math.PI;
    dh -= 360 * Math.floor((dh + 180) / 360);
    const s: SemanticLook = {
      hue: r3(a.meanC > 0.02 && b.meanC > 0.02 ? clamp(dh * amount * 0.5, -10, 10) : 0),
      sat: r3(clamp((a.meanC > 1e-3 ? b.meanC / a.meanC - 1 : 0) * amount * 0.5, -0.35, 0.35)),
      lum: r3(clamp((b.mean[0] - a.mean[0]) * amount * 0.5, -0.1, 0.1)),
      protect: 0,
    };
    semantic[g] = s;
    matched.push(g);
  }
  return makeProfile({
    id: "match-" + Date.now().toString(36),
    name: "Match · " + name.replace(/\.[^.]+$/, "").slice(0, 22),
    category: "custom",
    description: `Matched toward ${name} (${Math.round(amount * 100)}%). Regions matched: ${matched.join(", ") || "none"}; people protected.`,
    tone,
    colorBalance: { shadows: zd(cs.shadows, cr.shadows), midtones: zd(cs.midtones, cr.midtones), highlights: zd(cs.highlights, cr.highlights) },
    saturation: { global: r3(clamp(1 + (satRatio - 1) * amount, 0.5, 1.5)), shadows: 1, highlights: 1, knee: 0.25, compression: 0.8, lowBoost: 0 },
    hsl,
    semantic,
  });
}
