/**
 * Built-in look profiles. All original: authored from this engine's own
 * parameters (no commercial LUTs copied). LUT components reference the
 * procedural LUT sources in src/render/looks.ts.
 *
 * Design rule for every profile: skin (person regions) is protected, neon and
 * very saturated colours are compressed rather than clipped, and depth is used
 * only as a continuous curve.
 */
import { makeProfile, type LookProfile } from "./profile.ts";

const skin = { person: { hue: 0, sat: 0, lum: 0, protect: 0.6 } };

export const BUILTIN_PROFILES: LookProfile[] = [
  makeProfile({ id: "neutral", name: "Neutral", category: "neutral", description: "No creative grade — the technically corrected rendering." }),

  makeProfile({
    id: "clean", name: "Clean", category: "clean digital",
    description: "Modern, crisp and honest: gentle contrast, highlight chroma roll-off, neon compressed.",
    tone: { contrast: 0.08, highlightCompression: 0.08, rolloff: 0.6 },
    saturation: { global: 1.02, highlights: 0.9, knee: 0.22, compression: 0.8 },
    lut: { id: "natural", strength: 0.6 },
    semantic: { ...skin, person: { hue: 0, sat: 0, lum: 0, protect: 0.4 } },
  }),

  makeProfile({
    id: "soft-cine", name: "Soft Cinema", category: "soft cinematic",
    description: "Low-contrast cinema negative: open shadows, long highlight shoulder, restrained colour.",
    tone: { contrast: -0.12, blackPoint: 0.025, highlightCompression: 0.25, shadowLift: 0.06, rolloff: 0.9 },
    saturation: { global: 0.9, shadows: 0.85, highlights: 0.85, knee: 0.18, compression: 1.2 },
    colorBalance: { shadows: [-0.005, 0.005, 0.015], midtones: [0.005, 0, -0.005], highlights: [0.012, 0.006, -0.01] },
    hsl: { green: { hue: 6, sat: -0.15, lum: -0.03 }, yellow: { hue: -4, sat: -0.1, lum: 0 }, blue: { hue: -4, sat: -0.1, lum: 0 } },
    lut: { id: "film-crosstalk", strength: 0.5 },
    depth: { contrast: [0.02, 0, -0.06], haze: [0, 0.02, 0.07] },
    semantic: skin,
    satByLum: [[0, 0.44], [0.45, 0.56], [1, 0.42]],
  }),

  makeProfile({
    id: "warm-cine", name: "Golden Cine", category: "warm cinematic",
    description: "Warm highlights and mid-tones over neutral-cool shadows; foliage pushed toward olive.",
    tone: { contrast: 0.15, blackPoint: 0.01, highlightCompression: 0.15, rolloff: 0.7 },
    colorBalance: { shadows: [-0.01, 0.0, 0.02], midtones: [0.02, 0.008, -0.012], highlights: [0.035, 0.015, -0.02] },
    saturation: { global: 1.0, shadows: 0.85, highlights: 0.95, knee: 0.2, compression: 0.9 },
    hsl: { green: { hue: -10, sat: -0.2, lum: -0.04 }, yellow: { hue: -6, sat: 0.05, lum: 0.02 }, orange: { hue: 0, sat: 0.08, lum: 0.02 }, blue: { hue: -6, sat: -0.12, lum: 0 }, cyan: { hue: 6, sat: -0.1, lum: 0 } },
    lut: { id: "print", strength: 0.45 },
    semantic: { ...skin, sky: { hue: 0, sat: -0.1, lum: 0, protect: 0 } },
  }),

  makeProfile({
    id: "teal-warm", name: "Teal & Warm", category: "warm cinematic",
    description: "Complementary split: teal shadows, warm skin-friendly mid-tones and highlights.",
    tone: { contrast: 0.14, blackPoint: 0.02, highlightCompression: 0.18, shadowLift: 0.03, rolloff: 0.7 },
    colorBalance: { shadows: [-0.015, 0.012, 0.03], midtones: [0.015, 0.0, -0.01], highlights: [0.03, 0.012, -0.015] },
    saturation: { global: 0.95, shadows: 0.9, highlights: 0.9, knee: 0.2, compression: 1.0 },
    hsl: { green: { hue: 18, sat: -0.3, lum: -0.05 }, cyan: { hue: 0, sat: 0.1, lum: -0.03 }, blue: { hue: -10, sat: 0.05, lum: -0.03 }, orange: { hue: 0, sat: 0.05, lum: 0.02 } },
    lut: { id: "film-crosstalk", strength: 0.4 },
    semantic: { person: { hue: 0, sat: 0, lum: 0, protect: 0.65 }, water: { hue: -6, sat: 0.08, lum: 0, protect: 0 } },
    opponent: { axis: 65, amount: 0.25 },
  }),

  makeProfile({
    id: "cool-cine", name: "Cold Steel", category: "cool cinematic",
    description: "Cool, clean and restrained: blue-steel shadows, neutral highlights, desaturated warms.",
    tone: { contrast: 0.12, blackPoint: 0.015, highlightCompression: 0.12, rolloff: 0.6 },
    colorBalance: { shadows: [-0.015, 0.0, 0.03], midtones: [-0.01, 0.0, 0.012], highlights: [-0.004, 0.0, 0.006] },
    saturation: { global: 0.85, shadows: 0.8, highlights: 0.8, knee: 0.18, compression: 1.0 },
    hsl: { orange: { hue: 0, sat: -0.15, lum: 0 }, yellow: { hue: 8, sat: -0.3, lum: 0 }, green: { hue: 12, sat: -0.35, lum: -0.03 }, blue: { hue: 0, sat: 0.05, lum: -0.03 } },
    depth: { temperature: [0, -0.004, -0.012], haze: [0, 0.01, 0.05] },
    semantic: skin,
  }),

  makeProfile({
    id: "muted-cine", name: "Muted Film", category: "muted cinematic",
    description: "Faded blacks and quiet colour, every hue slightly desaturated; nothing screams.",
    tone: { contrast: -0.05, blackPoint: 0.05, highlightCompression: 0.22, shadowLift: 0.02, rolloff: 0.85 },
    saturation: { global: 0.72, shadows: 0.8, highlights: 0.8, knee: 0.14, compression: 1.5 },
    colorBalance: { shadows: [0.0, 0.004, 0.012], midtones: [0.006, 0.003, 0.0], highlights: [0.01, 0.006, 0.0] },
    hsl: { green: { hue: -8, sat: -0.15, lum: 0 }, red: { hue: 4, sat: -0.1, lum: 0 } },
    lut: { id: "film-crosstalk", strength: 0.6 },
    semantic: skin,
  }),

  makeProfile({
    id: "hc-cine", name: "Deep Contrast", category: "high-contrast cinematic",
    description: "Dense blacks and punchy mid-tones with a filmic shoulder — contrast without clipping.",
    tone: { contrast: 0.38, blackPoint: -0.02, highlightCompression: 0.2, shadowLift: -0.05, rolloff: 0.75 },
    saturation: { global: 0.95, shadows: 0.75, highlights: 0.85, knee: 0.2, compression: 1.1 },
    colorBalance: { shadows: [-0.006, 0.0, 0.012], highlights: [0.012, 0.006, -0.006] },
    lut: { id: "print", strength: 0.55 },
    depth: { contrast: [0.06, 0, -0.05] },
    semantic: skin,
  }),

  makeProfile({
    id: "pastel", name: "Pastel", category: "pastel",
    description: "Airy and light: lifted, soft tones with gentle, evenly weighted colour.",
    tone: { contrast: -0.25, blackPoint: 0.07, highlightCompression: 0.12, shadowLift: 0.12, rolloff: 0.9 },
    saturation: { global: 0.85, shadows: 0.7, highlights: 1.0, knee: 0.12, compression: 1.8, lowBoost: 0.25 },
    colorBalance: { shadows: [0.006, 0.0, 0.015], highlights: [0.01, 0.004, 0.0] },
    hsl: { green: { hue: 10, sat: -0.2, lum: 0.05 }, blue: { hue: -8, sat: -0.05, lum: 0.05 }, magenta: { hue: 0, sat: 0.05, lum: 0.03 } },
    semantic: skin,
  }),

  makeProfile({
    id: "documentary", name: "Documentary", category: "documentary",
    description: "Truthful and slightly reserved: faithful hues, a little less saturation, honest contrast.",
    tone: { contrast: 0.06, highlightCompression: 0.08, rolloff: 0.55 },
    saturation: { global: 0.9, shadows: 0.9, highlights: 0.9, knee: 0.22, compression: 0.8 },
    semantic: { person: { hue: 0, sat: 0, lum: 0, protect: 0.8 } },
  }),

  makeProfile({
    id: "mono", name: "Monochrome", category: "documentary",
    description: "Black and white through a mild red filter; rich mid-tone separation.",
    tone: { contrast: 0.2, blackPoint: -0.01, highlightCompression: 0.12, rolloff: 0.7 },
    lut: { id: "mono", strength: 1 },
  }),

  makeProfile({
    id: "night", name: "Night City", category: "night",
    description: "Cool shadows, warm practical lights; neon compressed instead of clipped; clean deep blacks.",
    tone: { contrast: 0.18, blackPoint: -0.015, highlightCompression: 0.3, shadowLift: -0.03, rolloff: 0.9 },
    colorBalance: { shadows: [-0.01, 0.0, 0.025], midtones: [0.0, 0.0, 0.005], highlights: [0.02, 0.01, -0.01] },
    saturation: { global: 0.95, shadows: 0.7, highlights: 0.9, knee: 0.16, compression: 2.0 },
    hsl: { orange: { hue: -4, sat: 0.05, lum: 0.02 }, magenta: { hue: 0, sat: -0.2, lum: 0 }, violet: { hue: 0, sat: -0.2, lum: 0 }, cyan: { hue: 0, sat: -0.1, lum: 0 } },
    semantic: skin,
  }),

  makeProfile({
    id: "landscape", name: "Landscape", category: "landscape",
    description: "Depth-aware atmosphere: rich near foliage, softer bluer distance, deep but natural skies.",
    tone: { contrast: 0.12, highlightCompression: 0.15, rolloff: 0.7 },
    saturation: { global: 1.03, highlights: 0.92, knee: 0.2, compression: 1.0, lowBoost: 0.1 },
    hsl: { green: { hue: 4, sat: -0.08, lum: -0.04 }, yellow: { hue: -3, sat: 0.05, lum: 0 }, blue: { hue: -3, sat: 0.06, lum: -0.05 } },
    depth: { saturation: [0.06, 0, -0.18], contrast: [0.05, 0, -0.07], temperature: [0.003, 0, -0.01], haze: [0, 0.02, 0.08] },
    semantic: { sky: { hue: -3, sat: 0.05, lum: -0.04, protect: 0 }, vegetation: { hue: 3, sat: -0.05, lum: -0.02, protect: 0 }, water: { hue: -4, sat: 0.05, lum: 0, protect: 0 }, person: { hue: 0, sat: 0, lum: 0, protect: 0.6 } },
  }),

  makeProfile({
    id: "architecture", name: "Architecture", category: "architecture",
    description: "Neutral materials stay neutral; clean whites, cool-neutral shadows, crisp near contrast.",
    tone: { contrast: 0.14, blackPoint: -0.005, highlightCompression: 0.1, rolloff: 0.55 },
    saturation: { global: 0.92, shadows: 0.85, highlights: 0.85, knee: 0.2, compression: 1.0 },
    colorBalance: { shadows: [-0.006, 0.0, 0.01] },
    depth: { contrast: [0.05, 0.02, -0.04] },
    semantic: { building: { hue: 0, sat: -0.12, lum: 0, protect: 0.2 }, sky: { hue: -2, sat: 0.04, lum: -0.03, protect: 0 }, person: { hue: 0, sat: 0, lum: 0, protect: 0.6 } },
  }),

  makeProfile({
    id: "portrait", name: "Portrait", category: "portrait-neutral",
    description: "Skin first: natural skin hues and density, soft highlight roll-off, quieter backgrounds.",
    tone: { contrast: 0.04, highlightCompression: 0.2, shadowLift: 0.03, rolloff: 0.85 },
    saturation: { global: 0.95, highlights: 0.9, knee: 0.18, compression: 1.0 },
    colorBalance: { midtones: [0.006, 0.002, -0.004] },
    hsl: { orange: { hue: 0, sat: -0.04, lum: 0.02 }, red: { hue: 3, sat: -0.06, lum: 0 }, green: { hue: 0, sat: -0.12, lum: -0.02 } },
    depth: { saturation: [0, -0.05, -0.12], contrast: [0.02, 0, -0.05] },
    semantic: { person: { hue: 0, sat: 0, lum: 0, protect: 0.85 } },
  }),
];

// ---------------------------------------------------------------------------
// Cinema palettes: a restricted colour script (2–3 anchor hues). Hues are
// pulled toward the anchors, colours far from all anchors are desaturated.
// Anchor hues are OkLab degrees: red ≈ 29, orange ≈ 55, amber ≈ 70,
// yellow ≈ 100, green ≈ 140, teal ≈ 190, cyan ≈ 210, blue ≈ 260,
// violet ≈ 300, magenta ≈ 340. People are protected in every palette.

const protectPeople = { person: { hue: 0, sat: 0, lum: 0, protect: 0.55 } };
const a = (hue: number, sat = 1, weight = 1) => ({ hue, sat, weight });

BUILTIN_PROFILES.push(
  makeProfile({
    id: "pal-amber-teal", name: "Amber & Teal", category: "cinema palette",
    description: "Two-colour script: warm amber skin and practicals against teal shadows and skies.",
    palette: { anchors: [a(68, 1.1), a(200, 1.0)], pull: 0.55, focus: 0.5, width: 38 },
    tone: { contrast: 0.16, blackPoint: 0.015, highlightCompression: 0.18, rolloff: 0.75 },
    colorBalance: { shadows: [-0.012, 0.008, 0.022], highlights: [0.02, 0.01, -0.012] },
    saturation: { global: 1.0, knee: 0.2, compression: 1.0 },
    semantic: protectPeople,
  }),
  makeProfile({
    id: "pal-neon-noir", name: "Neon Noir", category: "cinema palette",
    description: "Night palette of magenta and cyan with warm practical lights; everything else sinks into dark neutrals.",
    palette: { anchors: [a(340, 1.15), a(210, 1.1), a(60, 0.9, 0.7)], pull: 0.6, focus: 0.65, width: 34 },
    tone: { contrast: 0.28, blackPoint: -0.015, highlightCompression: 0.3, shadowLift: -0.04, rolloff: 0.9 },
    colorBalance: { shadows: [-0.006, 0.0, 0.02] },
    saturation: { global: 1.05, shadows: 0.8, knee: 0.18, compression: 1.6 },
    semantic: protectPeople,
  }),
  makeProfile({
    id: "pal-desert-gold", name: "Desert Gold", category: "cinema palette",
    description: "Sun-bleached ochre and orange with a pale, washed sky; lifted blacks, dusty highlights.",
    palette: { anchors: [a(72, 1.05), a(48, 1.0), a(235, 0.6, 0.8)], pull: 0.5, focus: 0.45, width: 40 },
    tone: { contrast: 0.05, blackPoint: 0.04, highlightCompression: 0.25, shadowLift: 0.04, rolloff: 0.85 },
    colorBalance: { midtones: [0.02, 0.01, -0.015], highlights: [0.025, 0.015, -0.01] },
    saturation: { global: 0.9, highlights: 0.8, knee: 0.18, compression: 1.2 },
    semantic: protectPeople,
  }),
  makeProfile({
    id: "pal-code-green", name: "Code Green", category: "cinema palette",
    description: "Monochromatic green cast — greens and yellow-greens only, cool dense shadows.",
    palette: { anchors: [a(135, 0.9), a(110, 0.7, 0.8)], pull: 0.65, focus: 0.75, width: 45 },
    tone: { contrast: 0.22, blackPoint: -0.01, highlightCompression: 0.15, rolloff: 0.7 },
    colorBalance: { shadows: [-0.01, 0.012, 0.004], midtones: [-0.008, 0.012, -0.004], highlights: [-0.004, 0.008, -0.006] },
    saturation: { global: 0.85, knee: 0.14, compression: 1.5 },
    semantic: { person: { hue: 0, sat: 0, lum: 0, protect: 0.35 } },
  }),
  makeProfile({
    id: "pal-crimson", name: "Crimson Accent", category: "cinema palette",
    description: "Near-monochrome world where only reds keep their colour.",
    palette: { anchors: [a(28, 1.2)], pull: 0.3, focus: 0.95, width: 30 },
    tone: { contrast: 0.22, blackPoint: -0.01, highlightCompression: 0.15, rolloff: 0.7 },
    saturation: { global: 1.05, knee: 0.22, compression: 0.8 },
  }),
  makeProfile({
    id: "pal-autumn-duo", name: "Autumn Duotone", category: "cinema palette",
    description: "Orange and blue only: foliage and skin fall into warm, skies and shade into cool.",
    palette: { anchors: [a(55, 1.1), a(255, 0.9)], pull: 0.5, focus: 0.55, width: 42 },
    tone: { contrast: 0.14, highlightCompression: 0.15, rolloff: 0.7 },
    colorBalance: { shadows: [-0.006, 0.0, 0.012], highlights: [0.012, 0.006, -0.006] },
    semantic: protectPeople,
  }),
  makeProfile({
    id: "pal-pastel-pop", name: "Pastel Pop", category: "cinema palette",
    description: "Candy script of pink, mint and butter yellow; soft, bright and low in contrast.",
    palette: { anchors: [a(350, 0.8), a(170, 0.8), a(98, 0.7)], pull: 0.5, focus: 0.35, width: 40 },
    tone: { contrast: -0.2, blackPoint: 0.06, highlightCompression: 0.1, shadowLift: 0.1, rolloff: 0.9 },
    saturation: { global: 0.9, knee: 0.12, compression: 1.8, lowBoost: 0.2 },
    semantic: protectPeople,
  }),
  makeProfile({
    id: "pal-arctic", name: "Arctic", category: "cinema palette",
    description: "Ice blue and pale cyan; warm colours are drained almost to grey.",
    palette: { anchors: [a(235, 0.9), a(205, 0.7, 0.8)], pull: 0.4, focus: 0.8, width: 40 },
    tone: { contrast: 0.08, blackPoint: 0.02, highlightCompression: 0.12, rolloff: 0.7 },
    colorBalance: { shadows: [-0.012, 0.0, 0.025], midtones: [-0.008, 0.0, 0.012] },
    saturation: { global: 0.85, knee: 0.14, compression: 1.2 },
    semantic: { person: { hue: 0, sat: 0, lum: 0, protect: 0.4 } },
  }),
  makeProfile({
    id: "pal-sodium", name: "Sodium Night", category: "cinema palette",
    description: "Street-lamp orange against deep teal night; neon compressed, blacks dense.",
    palette: { anchors: [a(62, 1.1), a(195, 0.8)], pull: 0.55, focus: 0.6, width: 36 },
    tone: { contrast: 0.2, blackPoint: -0.015, highlightCompression: 0.28, shadowLift: -0.03, rolloff: 0.9 },
    colorBalance: { shadows: [-0.012, 0.004, 0.02] },
    saturation: { global: 1.0, shadows: 0.75, knee: 0.16, compression: 1.8 },
    semantic: protectPeople,
  }),
  makeProfile({
    id: "pal-emerald", name: "Jungle Emerald", category: "cinema palette",
    description: "Deep emerald greens with warm ochre earth and skin; humid, rich, controlled.",
    palette: { anchors: [a(155, 1.1), a(62, 1.0)], pull: 0.45, focus: 0.35, width: 42 },
    tone: { contrast: 0.15, highlightCompression: 0.18, rolloff: 0.75 },
    colorBalance: { shadows: [-0.006, 0.006, 0.004] },
    saturation: { global: 1.0, knee: 0.2, compression: 1.0 },
    semantic: protectPeople,
  }),
  makeProfile({
    id: "pal-magenta-dusk", name: "Magenta Dusk", category: "cinema palette",
    description: "Dusk script of magenta, violet and a last orange glow.",
    palette: { anchors: [a(335, 1.05), a(290, 1.0), a(50, 0.9, 0.8)], pull: 0.5, focus: 0.45, width: 38 },
    tone: { contrast: 0.12, blackPoint: 0.015, highlightCompression: 0.2, rolloff: 0.8 },
    colorBalance: { shadows: [0.004, -0.006, 0.02], highlights: [0.02, 0.004, 0.0] },
    semantic: protectPeople,
  }),
  makeProfile({
    id: "pal-bleach", name: "Bleach Bypass", category: "cinema palette",
    description: "Silver-retained print look: harsh contrast, metallic highlights, colour nearly bleached out.",
    palette: { anchors: [], pull: 0, focus: 0, width: 40 },
    tone: { contrast: 0.42, blackPoint: -0.02, highlightCompression: 0.12, shadowLift: -0.06, rolloff: 0.55 },
    saturation: { global: 0.42, shadows: 0.7, highlights: 0.6, knee: 0.1, compression: 1.0 },
    colorBalance: { shadows: [-0.004, 0.0, 0.008] },
  }),
);

// ---------------------------------------------------------------------------
// Restrained cinema: how films are usually graded — saturation well below a
// phone's, one or two quiet anchor colours, everything else sinking toward
// neutral; highlights roll off softly, blacks are dense but not crushed.

const quiet = (anchors: Array<{ hue: number; sat: number; weight: number }>, focus: number, pull = 0.45, width = 40) => ({ anchors, pull, focus, width });

BUILTIN_PROFILES.push(
  makeProfile({
    id: "muted-slate-rust", name: "Slate & Rust", category: "muted cinematic",
    description: "Two quiet colours — slate blue and rust — over desaturated neutrals.",
    palette: quiet([a(250, 0.7), a(45, 0.8)], 0.6),
    tone: { contrast: 0.14, blackPoint: 0.015, highlightCompression: 0.22, rolloff: 0.8 },
    saturation: { global: 0.65, shadows: 0.7, highlights: 0.75, knee: 0.12, compression: 1.6 },
    colorBalance: { shadows: [-0.008, 0.0, 0.014], highlights: [0.01, 0.005, -0.004] },
    semantic: protectPeople,
  }),
  makeProfile({
    id: "muted-overcast", name: "Overcast Drama", category: "muted cinematic",
    description: "Grey, heavy light: steel shadows, pale skies, colour drained to a whisper; skin kept alive.",
    palette: quiet([a(215, 0.6), a(55, 0.7, 0.8)], 0.55, 0.35),
    tone: { contrast: 0.2, blackPoint: 0.01, highlightCompression: 0.25, shadowLift: -0.02, rolloff: 0.85 },
    saturation: { global: 0.55, shadows: 0.6, highlights: 0.6, knee: 0.1, compression: 1.8 },
    colorBalance: { shadows: [-0.01, 0.002, 0.014], midtones: [-0.004, 0.0, 0.004] },
    semantic: { person: { hue: 0, sat: 0.1, lum: 0, protect: 0.7 } },
  }),
  makeProfile({
    id: "muted-nordic", name: "Nordic", category: "muted cinematic",
    description: "Cold, pale and quiet: desaturated greens and blues, lifted blacks, clean whites.",
    palette: quiet([a(200, 0.6), a(150, 0.5, 0.7)], 0.5),
    tone: { contrast: 0.02, blackPoint: 0.04, highlightCompression: 0.15, shadowLift: 0.04, rolloff: 0.8 },
    saturation: { global: 0.6, shadows: 0.65, highlights: 0.7, knee: 0.1, compression: 1.6 },
    colorBalance: { shadows: [-0.008, 0.0, 0.012], midtones: [-0.006, 0.0, 0.006] },
    semantic: protectPeople,
  }),
  makeProfile({
    id: "muted-olive", name: "Olive Drab", category: "muted cinematic",
    description: "Khaki and olive with dusty skies — the colour of a period war film.",
    palette: quiet([a(95, 0.75), a(70, 0.7), a(230, 0.4, 0.6)], 0.65, 0.5),
    tone: { contrast: 0.22, blackPoint: 0.005, highlightCompression: 0.2, rolloff: 0.75 },
    saturation: { global: 0.6, shadows: 0.6, highlights: 0.6, knee: 0.11, compression: 1.6 },
    colorBalance: { shadows: [-0.004, 0.006, -0.002], midtones: [0.004, 0.006, -0.01] },
    lut: { id: "film-crosstalk", strength: 0.5 },
    semantic: protectPeople,
  }),
  makeProfile({
    id: "muted-tobacco", name: "Tobacco", category: "muted cinematic",
    description: "Warm browns and amber in dense, low-key shadows; everything else near-neutral.",
    palette: quiet([a(62, 0.8), a(40, 0.7)], 0.7, 0.5, 45),
    tone: { contrast: 0.26, blackPoint: -0.01, highlightCompression: 0.25, shadowLift: -0.04, rolloff: 0.85 },
    saturation: { global: 0.62, shadows: 0.55, highlights: 0.7, knee: 0.12, compression: 1.5 },
    colorBalance: { shadows: [0.006, 0.002, -0.006], midtones: [0.014, 0.006, -0.012], highlights: [0.012, 0.006, -0.006] },
    lut: { id: "print", strength: 0.4 },
    semantic: protectPeople,
  }),
  makeProfile({
    id: "muted-dusty-rose", name: "Dusty Rose", category: "muted cinematic",
    description: "Faded rose and grey-green, soft contrast — a quiet, romantic period look.",
    palette: quiet([a(10, 0.7), a(150, 0.5, 0.8)], 0.5, 0.4),
    tone: { contrast: -0.06, blackPoint: 0.045, highlightCompression: 0.18, shadowLift: 0.04, rolloff: 0.9 },
    saturation: { global: 0.62, shadows: 0.6, highlights: 0.8, knee: 0.1, compression: 1.8 },
    colorBalance: { shadows: [0.004, -0.004, 0.006], highlights: [0.012, 0.004, 0.002] },
    semantic: protectPeople,
  }),
  makeProfile({
    id: "muted-graphite", name: "Graphite", category: "muted cinematic",
    description: "Almost monochrome — a trace of cool colour in the shadows, warm skin barely there.",
    palette: quiet([a(220, 0.5, 0.7)], 0.85, 0.3),
    tone: { contrast: 0.24, blackPoint: -0.005, highlightCompression: 0.18, rolloff: 0.75 },
    saturation: { global: 0.4, shadows: 0.5, highlights: 0.4, knee: 0.08, compression: 1.5 },
    colorBalance: { shadows: [-0.006, 0.0, 0.01] },
    semantic: { person: { hue: 0, sat: 0, lum: 0, protect: 0.45 } },
  }),
  makeProfile({
    id: "muted-sepia", name: "Sepia Wash", category: "muted cinematic",
    description: "Near-monochrome warm wash, like a toned print; a faint memory of the original colour.",
    palette: quiet([a(65, 0.6)], 0.9, 0.6, 50),
    tone: { contrast: 0.12, blackPoint: 0.03, highlightCompression: 0.2, rolloff: 0.85 },
    saturation: { global: 0.45, shadows: 0.5, highlights: 0.5, knee: 0.08, compression: 1.5 },
    colorBalance: { shadows: [0.008, 0.002, -0.008], midtones: [0.014, 0.006, -0.014], highlights: [0.01, 0.006, -0.008] },
  }),
  makeProfile({
    id: "muted-noir-teal", name: "Noir Teal", category: "muted cinematic",
    description: "Hard, dark and nearly colourless, with a thread of teal in the shadows.",
    palette: quiet([a(195, 0.7)], 0.8, 0.4),
    tone: { contrast: 0.36, blackPoint: -0.02, highlightCompression: 0.2, shadowLift: -0.06, rolloff: 0.7 },
    saturation: { global: 0.5, shadows: 0.7, highlights: 0.4, knee: 0.1, compression: 1.5 },
    colorBalance: { shadows: [-0.012, 0.008, 0.016] },
    semantic: { person: { hue: 0, sat: 0, lum: 0, protect: 0.4 } },
  }),
  makeProfile({
    id: "muted-winter", name: "Winter Light", category: "muted cinematic",
    description: "Low sun in the cold: pale warm highlights, cool muted shade, very little saturation.",
    palette: quiet([a(230, 0.55), a(70, 0.6, 0.8)], 0.55, 0.4),
    tone: { contrast: 0.08, blackPoint: 0.03, highlightCompression: 0.2, shadowLift: 0.03, rolloff: 0.85 },
    saturation: { global: 0.58, shadows: 0.6, highlights: 0.65, knee: 0.1, compression: 1.6 },
    colorBalance: { shadows: [-0.01, 0.0, 0.016], highlights: [0.014, 0.008, -0.006] },
    semantic: protectPeople,
  }),
);

export const DEFAULT_PROFILE_ID = "clean";
