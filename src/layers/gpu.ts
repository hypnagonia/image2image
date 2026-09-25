/**
 * Layers → GPU: one fixed 32-float record per layer (read-only storage buffer)
 * and one row per layer that needs a table in the LUT atlas (1024 samples × 4
 * channels, rgba16float). Mirrors `layers.wgsl`.
 *
 * Record: [0] type  [1] blend  [2] opacity (0 = hidden)  [3] atlas row (−1 none)
 *         [4] mask kind  [5] region (0…10 groups, 11 skin)  [6] band  [7] invert
 *         [8] lum low  [9] lum high  [10] lum softness  [11] feather  [12] density  [13] except skin
 *         [16…31] type parameters
 */
import { GROUPS } from "../neural/scene.ts";
import { DEPTH_BANDS, type Curves } from "../decision/params.ts";
import { curveLUT, CURVE_LUT_SIZE } from "../render/curves.ts";
import { BLEND_MODES, hueSatTable, LAYER_TYPES, type Layer, type LayerParams } from "./model.ts";
import { gradientTable } from "./gradient.ts";

export const RECORD = 32;
export const ATLAS_W = CURVE_LUT_SIZE; // 1024
const MASK_KIND = { all: 0, region: 1, distance: 2, cell: 3, luminance: 4 } as const;

export interface PackedLayers { records: Float32Array; count: number; atlas: Float32Array; rows: number }

/**
 * The module an automatic layer belongs to (for the Regions / Curves switches):
 * the photo's tone curve and the distance curves are "curves", the rest of the
 * automatic grade (region colour, skin, subject, region curves) is "semantic".
 * The user's own layers follow "curves".
 */
export function layerModule(l: Layer): "curves" | "semantic" {
  if (!l.auto) return "curves";
  const [kind, what] = l.auto.split(".");
  if (kind === "curves" && (what === "photo" || (DEPTH_BANDS as string[]).includes(what))) return "curves";
  return "semantic";
}

/** The layers that reach the GPU, in order (the mask view's index counts these). */
export function liveLayers(layers: Layer[], autoStrength = 1, enable?: { curves?: boolean; semantic?: boolean }): Layer[] {
  const on = (l: Layer) => (enable?.[layerModule(l)] ?? true) !== false;
  return layers.filter((l) => l.visible && l.opacity > 0 && on(l) && !(l.auto && autoStrength <= 0));
}

/**
 * `autoStrength` (0…1) scales the opacity of every automatic layer (the "Auto strength" control);
 * `enable` (the module switches) turns layers off with their module.
 */
export function packLayers(layers: Layer[], autoStrength = 1, enable?: { curves?: boolean; semantic?: boolean }): PackedLayers {
  const live = liveLayers(layers, autoStrength, enable);
  const records = new Float32Array(Math.max(1, live.length) * RECORD);
  const rows: Float32Array[] = [];
  live.forEach((l, i) => {
    const r = records.subarray(i * RECORD, (i + 1) * RECORD);
    r[0] = LAYER_TYPES.indexOf(l.type);
    r[1] = Math.max(0, BLEND_MODES.indexOf(l.blend));
    r[2] = Math.min(1, Math.max(0, l.opacity * (l.auto ? Math.min(1, Math.max(0, autoStrength)) : 1)));
    r[3] = -1;
    const m = l.mask;
    r[4] = MASK_KIND[m.kind];
    r[5] = m.region === "skin" ? 11 : m.region ? GROUPS.indexOf(m.region) : 0;
    r[6] = m.band ? DEPTH_BANDS.indexOf(m.band) : 0;
    r[7] = m.invert ? 1 : 0;
    r[8] = m.lum?.[0] ?? 0; r[9] = m.lum?.[1] ?? 1; r[10] = m.lum?.[2] ?? 0.08;
    r[11] = m.feather; r[12] = m.density; r[13] = m.exceptSkin ? 1 : 0;
    const p = r.subarray(16);
    switch (l.type) {
      case "curves": {
        r[3] = rows.length;
        rows.push(curveLUT(l.params as Curves));
        break;
      }
      case "hueSat": {
        const h = l.params as LayerParams["hueSat"];
        p[0] = h.colorize ? 1 : 0; p[1] = (h.cHue * Math.PI) / 180; p[2] = h.cSat; p[3] = h.cLight;
        // Per-hue table: r = hue shift (radians), g = saturation, b = lightness; 1024 samples over 0…360°.
        const t = hueSatTable(h, ATLAS_W), row = new Float32Array(ATLAS_W * 4);
        for (let k = 0; k < ATLAS_W; k++) { row[k * 4] = (t[k * 3] * Math.PI) / 180; row[k * 4 + 1] = t[k * 3 + 1]; row[k * 4 + 2] = t[k * 3 + 2]; row[k * 4 + 3] = 1; }
        r[3] = rows.length;
        rows.push(row);
        break;
      }
      case "gradientMap": {
        const g = l.params as LayerParams["gradientMap"];
        p[0] = g.reverse ? 1 : 0;
        r[3] = rows.length;
        rows.push(gradientTable(g.gradient, ATLAS_W));
        break;
      }
      case "gradientFill": {
        const g = l.params as LayerParams["gradientFill"];
        p[0] = g.style === "radial" ? 1 : 0; p[1] = (g.angle * Math.PI) / 180; p[2] = Math.max(0.02, g.scale); p[3] = g.reverse ? 1 : 0;
        p[4] = g.x; p[5] = g.y;
        r[3] = rows.length;
        rows.push(gradientTable(g.gradient, ATLAS_W));
        break;
      }
      case "brightContrast": { const b = l.params as LayerParams["brightContrast"]; p[0] = b.brightness; p[1] = b.contrast; break; }
      case "exposure": { const e = l.params as LayerParams["exposure"]; p[0] = e.exposure; p[1] = e.offset; p[2] = e.gamma; break; }
      case "basic": {
        const b = l.params as LayerParams["basic"];
        p[0] = b.exposure; p[1] = b.temp; p[2] = b.tint; p[3] = b.saturation; p[4] = b.vibrance; p[5] = (b.hue * Math.PI) / 180;
        break;
      }
    }
  });
  const atlas = new Float32Array(Math.max(1, rows.length) * ATLAS_W * 4);
  rows.forEach((row, i) => atlas.set(row, i * ATLAS_W * 4));
  return { records, count: live.length, atlas, rows: Math.max(1, rows.length) };
}
