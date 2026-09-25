import { srgbEotf as eotf, srgbOetf as oetf } from "../color/transfer.ts";
/**
 * Gradients for the Gradient Map and Gradient Fill layers: colour stops (sRGB
 * hex, location 0…1, opacity), preset palettes, and the 1024-sample table the
 * GPU reads (display-encoded Display P3, the tone pass's working encoding).
 *
 * Interpolation is in encoded sRGB, as Photoshop's "classic" gradients.
 */

export interface GradientStop { pos: number; color: string; /** 0…1 */ alpha: number }
export interface Gradient { stops: GradientStop[] }

export interface GradientPreset { id: string; colors: string[] }

/**
 * Preset palettes, dark → light (so a Gradient Map puts the first colour in the
 * shadows and the last in the highlights). "tealGold" is schemecolor.com's
 * "Teal and Gold" palette (Skobeloff, Teal, Dark Goldenrod, Chinese Gold, Goldenrod).
 */
export const GRADIENT_PRESETS: GradientPreset[] = [
  { id: "tealGold", colors: ["#006C77", "#008182", "#B7850E", "#CC9802", "#DBA620"] },
  { id: "tealOrange", colors: ["#0E2A33", "#1D6A73", "#D9894A", "#FFD9A8"] },
  { id: "navyGold", colors: ["#0D1B3E", "#2B4C7E", "#C9A227", "#F6E7A1"] },
  { id: "goldenHour", colors: ["#2A170C", "#8A4A1D", "#E39A3F", "#FFE6AE"] },
  { id: "sunset", colors: ["#2B1055", "#7A2C6E", "#E2615A", "#FFC878"] },
  { id: "roseGold", colors: ["#2E1A1F", "#8C585C", "#D8A49F", "#FBE8E3"] },
  { id: "forest", colors: ["#0F1A14", "#2E4A3A", "#99A276", "#ECE5CE"] },
  { id: "nordic", colors: ["#18212C", "#475B6E", "#A5B2BC", "#F0EEE9"] },
  { id: "vintage", colors: ["#1D1E2C", "#5A5470", "#C7A46A", "#F3E8D1"] },
  { id: "pastel", colors: ["#4E5D80", "#95AFC6", "#F1C4C0", "#FFF3DE"] },
  { id: "cyber", colors: ["#12002B", "#5B1A8C", "#1FA6A6", "#B8FFF2"] },
  { id: "sepia", colors: ["#1E120A", "#6B4A2E", "#C29E74", "#F5E8D3"] },
  { id: "cyanotype", colors: ["#0B1E3F", "#2C5A8C", "#9CC0DB", "#F1F6FA"] },
  { id: "bw", colors: ["#000000", "#FFFFFF"] },
];

/** Evenly spaced, opaque stops from a list of colours. */
export function gradientFrom(colors: string[]): Gradient {
  const n = Math.max(1, colors.length - 1);
  return { stops: colors.map((c, i) => ({ pos: colors.length === 1 ? 0 : i / n, color: c, alpha: 1 })) };
}
export const presetGradient = (id: string): Gradient => gradientFrom(GRADIENT_PRESETS.find((p) => p.id === id)?.colors ?? ["#000000", "#FFFFFF"]);

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const v = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(v) || h.length < 6) return [0, 0, 0];
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
export function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

const sorted = (g: Gradient) => [...g.stops].sort((a, b) => a.pos - b.pos);

/** Colour and opacity at `x` (0…1), encoded sRGB. */
export function gradientAt(g: Gradient, x: number): [number, number, number, number] {
  const s = sorted(g);
  if (!s.length) return [0, 0, 0, 1];
  if (x <= s[0].pos) return [...hexToRgb(s[0].color), s[0].alpha];
  const last = s[s.length - 1];
  if (x >= last.pos) return [...hexToRgb(last.color), last.alpha];
  let i = 0;
  while (i < s.length - 2 && x > s[i + 1].pos) i++;
  const a = s[i], b = s[i + 1];
  const t = b.pos > a.pos ? (x - a.pos) / (b.pos - a.pos) : 0;
  const ca = hexToRgb(a.color), cb = hexToRgb(b.color);
  return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t, a.alpha + (b.alpha - a.alpha) * t];
}


/** sRGB (encoded) → Display P3 (encoded): the same colour in the tone pass's encoding. */
export function srgbToP3Encoded(r: number, g: number, b: number): [number, number, number] {
  const R = eotf(r), G = eotf(g), B = eotf(b);
  return [oetf(0.8224621 * R + 0.177538 * G), oetf(0.0331942 * R + 0.9668058 * G), oetf(0.0170827 * R + 0.0723974 * G + 0.9105199 * B)];
}

/** `n` samples (rgba) over 0…1 for the GPU. */
export function gradientTable(g: Gradient, n = 1024): Float32Array {
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const [r, gg, b, a] = gradientAt(g, i / (n - 1));
    const p = srgbToP3Encoded(r, gg, b);
    out.set([p[0], p[1], p[2], a], i * 4);
  }
  return out;
}

/** CSS linear-gradient (left → right) for swatches and the editor bar. */
export function gradientCss(g: Gradient, reverse = false): string {
  const parts = sorted(g).map((s) => {
    const [r, gg, b] = hexToRgb(s.color);
    const pos = reverse ? 1 - s.pos : s.pos;
    return { pos, css: `rgba(${Math.round(r * 255)},${Math.round(gg * 255)},${Math.round(b * 255)},${s.alpha}) ${(pos * 100).toFixed(1)}%` };
  }).sort((a, b) => a.pos - b.pos);
  return `linear-gradient(90deg, ${parts.map((p) => p.css).join(", ")})`;
}
