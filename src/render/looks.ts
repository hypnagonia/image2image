/**
 * Camera colour science, Stage C: creative looks as 3D LUTs (17³ or 33³).
 *
 * LUT domain and range: display-encoded Display P3 (sRGB transfer), [0,1]³.
 * The LUT only *styles* an already correctly rendered image — RAW colour
 * conversion happens before it (DNG matrices → working space → tone), never
 * inside it. Imported .cube files are assumed to be authored for the same
 * encoding (true of most Rec.709/sRGB display LUTs, applied here to P3).
 */
import { linSrgbToOklab, oklabToLinSrgb } from "../color/oklab.ts";
import { mulVec } from "../color/mat3.ts";
import { P3_TO_SRGB, rgbToXYZ, SRGB, P3_D65 } from "../color/spaces.ts";
import { inverse, mul } from "../color/mat3.ts";
import { srgbEotf as eotf, srgbOetf as oetf } from "../color/transfer.ts";

export interface Look {
  id: string;
  name: string;
  description: string;
  /** Maps an OkLab colour (of display-linear sRGB-primaries RGB) to a styled OkLab colour. */
  fn?: (lab: [number, number, number]) => [number, number, number];
  /** Imported LUT data (size³ × 3, r fastest). */
  table?: { size: number; data: Float32Array };
}

const SRGB_TO_P3 = mul(inverse(rgbToXYZ(P3_D65)), rgbToXYZ(SRGB));
const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

function hueDist(a: number, b: number) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export const LOOKS: Look[] = [
  { id: "neutral", name: "Neutral", description: "Identity — the corrected rendering, no styling." },
  {
    id: "natural",
    name: "Natural",
    description: "Subtle camera-like response: highlight chroma roll-off, skin hues held, a touch of warmth in highlights.",
    fn: ([L, a, b]) => {
      const C = Math.hypot(a, b);
      const h = (Math.atan2(b, a) * 180) / Math.PI;
      // Chroma rolls off approaching white (film/sensor-like), less so for skin.
      const skin = 1 - smooth(18, 40, hueDist(h, 55));
      const roll = 1 - 0.35 * smooth(0.72, 1.0, L) * (1 - 0.5 * skin);
      // Very high chroma compressed gently (keeps gamut-edge colours from looking electronic).
      const comp = C > 0.2 ? (0.2 + (C - 0.2) * 0.7) / C : 1;
      const k = roll * comp;
      // Warm highlights / neutral shadows: ±0.004 in b.
      const warm = 0.004 * smooth(0.6, 0.95, L);
      return [L, a * k, b * k + warm];
    },
  },
  {
    id: "vivid",
    name: "Vivid",
    description: "Richer colour with protected skin and highlight roll-off.",
    fn: ([L, a, b]) => {
      const C = Math.hypot(a, b);
      const h = (Math.atan2(b, a) * 180) / Math.PI;
      const skin = 1 - smooth(18, 40, hueDist(h, 55));
      const boost = 1 + 0.18 * (1 - skin * 0.7) * (1 - smooth(0.12, 0.3, C));
      const roll = 1 - 0.3 * smooth(0.75, 1.0, L);
      const k = boost * roll;
      const Lc = L + 0.03 * Math.sin((L - 0.5) * Math.PI); // gentle S
      return [Lc, a * k, b * k];
    },
  },
  {
    id: "soft",
    name: "Soft film",
    description: "Lower contrast, lifted toe, restrained colour — negative-film-like.",
    fn: ([L, a, b]) => {
      const Lc = 0.035 + L * 0.94 - 0.03 * Math.sin((L - 0.5) * Math.PI);
      const k = 0.88 * (1 - 0.3 * smooth(0.7, 1, L));
      return [Lc, a * k + 0.003, b * k + 0.006 * (1 - L)];
    },
  },
  {
    id: "film-crosstalk",
    name: "Film crosstalk",
    description: "Dye-layer crosstalk: colours pull slightly toward their neighbours, saturated tones soften, shadows gain density.",
    fn: ([L, a, b]) => {
      const C = Math.hypot(a, b);
      const h = Math.atan2(b, a);
      // Neighbouring dye layers bleed: hue drifts toward the nearest of the three
      // subtractive primaries' complements, chroma compresses nonlinearly.
      const drift = 0.06 * Math.sin(3 * h) * smooth(0.02, 0.12, C);
      const hh = h - drift;
      const Cc = C * (1 - 0.18 * smooth(0.06, 0.25, C));
      const Ld = L - 0.02 * Math.sin(Math.PI * L) * smooth(0.0, 0.5, 1 - L);
      return [Ld, Cc * Math.cos(hh), Cc * Math.sin(hh)];
    },
  },
  {
    id: "print",
    name: "Print density",
    description: "Print-stock-like response: reds and oranges gain density, cyans deepen, highlights warm slightly.",
    fn: ([L, a, b]) => {
      const C = Math.hypot(a, b);
      const hd = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
      const warm = 1 - smooth(20, 55, hueDist(hd, 45));
      const cyan = 1 - smooth(20, 55, hueDist(hd, 200));
      const Ld = L - C * (0.12 * warm + 0.1 * cyan);
      const k = 1 + 0.06 * warm - 0.04 * (1 - warm - cyan);
      return [Ld, a * k, b * k + 0.005 * smooth(0.65, 0.95, L)];
    },
  },
  {
    id: "mono",
    name: "Monochrome",
    description: "Black and white with a mild red-filter response.",
    fn: ([L, a, b]) => {
      const h = Math.atan2(b, a);
      const C = Math.hypot(a, b);
      const Lm = L + C * 0.25 * Math.cos(h - 0.5) - C * 0.2 * Math.max(0, -Math.cos(h - 4.0));
      return [Math.min(1, Math.max(0, Lm)), 0, 0];
    },
  },
];

/** Builds an RGBA float LUT (size³, r fastest) in the look domain. */
export function buildLUT(look: Look, size: 17 | 33 | 65): Float32Array {
  const out = new Float32Array(size * size * size * 4);
  const P3toS = P3_TO_SRGB;
  for (let bi = 0; bi < size; bi++)
    for (let gi = 0; gi < size; gi++)
      for (let ri = 0; ri < size; ri++) {
        const e = [ri / (size - 1), gi / (size - 1), bi / (size - 1)];
        let o = e;
        if (look.table) {
          o = sampleTable(look.table, e);
        } else if (look.fn) {
          const lin = mulVec(P3toS, e.map(eotf));
          const lab = look.fn(linSrgbToOklab(lin));
          const rgb = mulVec(SRGB_TO_P3, oklabToLinSrgb(lab));
          o = rgb.map((v) => oetf(Math.min(1, Math.max(0, v))));
        }
        const k = ((bi * size + gi) * size + ri) * 4;
        out[k] = o[0]; out[k + 1] = o[1]; out[k + 2] = o[2]; out[k + 3] = 1;
      }
  return out;
}

function sampleTable(t: { size: number; data: Float32Array }, e: number[]): number[] {
  const n = t.size;
  const f = e.map((v) => Math.min(n - 1, Math.max(0, v * (n - 1))));
  const i0 = f.map(Math.floor), i1 = i0.map((v) => Math.min(n - 1, v + 1));
  const w = f.map((v, i) => v - i0[i]);
  const at = (r: number, g: number, b: number, c: number) => t.data[((b * n + g) * n + r) * 3 + c];
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let acc = 0;
    for (let k = 0; k < 8; k++) {
      const rr = k & 1 ? i1[0] : i0[0], gg = k & 2 ? i1[1] : i0[1], bb = k & 4 ? i1[2] : i0[2];
      const ww = (k & 1 ? w[0] : 1 - w[0]) * (k & 2 ? w[1] : 1 - w[1]) * (k & 4 ? w[2] : 1 - w[2]);
      acc += ww * at(rr, gg, bb, c);
    }
    out[c] = acc;
  }
  return out;
}

/** Parses an Adobe/Resolve .cube 3D LUT. */
export function parseCube(text: string, name: string): Look {
  let size = 0;
  const vals: number[] = [];
  let dmin = [0, 0, 0], dmax = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    if (key === "LUT_3D_SIZE") size = parseInt(parts[1], 10);
    else if (key === "DOMAIN_MIN") dmin = parts.slice(1, 4).map(Number);
    else if (key === "DOMAIN_MAX") dmax = parts.slice(1, 4).map(Number);
    else if (key === "LUT_1D_SIZE") throw new Error("1D .cube LUTs are not supported — use a 3D LUT");
    else if (/^[-+0-9.]/.test(key)) vals.push(+parts[0], +parts[1], +parts[2]);
  }
  if (!size || vals.length !== size * size * size * 3) throw new Error(`Invalid .cube (size ${size}, ${vals.length / 3} entries)`);
  if (dmin.some((v) => v !== 0) || dmax.some((v) => v !== 1)) throw new Error(".cube with a non-unit domain is not supported");
  return { id: "cube:" + name, name, description: `Imported ${size}³ LUT`, table: { size, data: Float32Array.from(vals) } };
}
