/**
 * The automatic grade as ordinary layers.
 *
 * The decision engine still decides everything it did (curves, region colour,
 * natural skin, subject priority, atmospheric perspective…); this turns its
 * colour and curve results into labelled layers with smart masks — visible,
 * editable, removable — and clears them from the parameters so nothing is
 * applied twice. What stays in Develop: everything that happens in scene-linear
 * light before the tone curve (exposure and highlights per region, detail
 * multipliers, distance detail), plus the global saturation and vibrance.
 *
 * Also migrates parameters saved by earlier versions (region / distance / cell
 * curves, region colour) into layers.
 */
import { GROUPS, type Group } from "../neural/scene.ts";
import { DEPTH_BANDS, neutralSemantic, type CellKey, type Curves, type DepthBand, type Params, type Region, type SemanticAdjust } from "../decision/params.ts";
import { allMask, isNeutralLayer, makeLayer, type Layer, type SmartMask } from "./model.ts";

export const REGION_NAME: Record<Region, string> = {
  sky: "Sky", vegetation: "Greens", building: "Buildings", ground: "Ground", terrain: "Terrain", water: "Water",
  person: "People", vehicle: "Vehicles", animal: "Animals", interior: "Interior", other: "Other", skin: "Skin",
};
const BAND_NAME: Record<DepthBand, string> = { near: "Near", middle: "Middle", far: "Far" };

/**
 * 2: region vibrance became a share of the global vibrance (version 1 greyed people).
 * 3: curves before colour, region / distance colour leave skin out, saturation relative.
 */
export const AUTO_LAYERS_VERSION = 3;

const COLOUR_KEYS = ["saturation", "vibrance", "hue", "warmth", "tint"] as const;
const curvesFlat = (c: Partial<Curves> | undefined) => !c || (["l", "r", "g", "b"] as const).every((k) => !c[k] || c[k]!.every((q) => Math.abs(q.x - q.y) < 1e-4));
const regionMask = (r: Region): SmartMask => ({ ...allMask(), kind: "region", region: r });
const bandMask = (b: DepthBand): SmartMask => ({ ...allMask(), kind: "distance", band: b });

/**
 * A region's colour settings as a Light & colour layer. Region vibrance is relative:
 * −0.6 on people meant "people get 40 % of the photo's vibrance", so the layer's
 * own (absolute) vibrance is that share of the global one — not −60 %, which greys
 * skin and other soft colours.
 */
function basicFrom(s: SemanticAdjust, globalVibrance: number, globalSaturation: number, minus?: SemanticAdjust) {
  const d = (k: (typeof COLOUR_KEYS)[number]) => (s[k] ?? 0) - (minus?.[k] ?? 0);
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  // Region saturation added to the global one (1 + g + s); the layer runs before the
  // global stage, which multiplies by (1 + g): s / (1 + g) gives the same total.
  return { exposure: 0, temp: d("warmth"), tint: d("tint"), saturation: r3(d("saturation") / Math.max(0.2, 1 + globalSaturation)), vibrance: r3(d("vibrance") * globalVibrance), hue: d("hue") };
}

/**
 * Moves the automatic (or saved) colour and curve settings of `p` into layers
 * appended to `p.layers`, and clears them from `p`. Idempotent: running it
 * again finds nothing left to move.
 */
export function buildAutoLayers(p: Params): Params {
  const layers: Layer[] = [...(p.layers ?? [])];
  const gv = p.color?.vibrance ?? 0;
  const push = (l: Layer) => { if (!isNeutralLayer(l)) layers.push(l); };

  const gs = p.color?.saturation ?? 0;
  const exceptSkin = (m: SmartMask): SmartMask => ({ ...m, exceptSkin: true });
  const cellMask = (k: CellKey): SmartMask => { const [g, b] = k.split(".") as [Group, DepthBand]; return { ...allMask(), kind: "cell", region: g, band: b }; };
  const cellName = (k: CellKey, what: string) => { const [g, b] = k.split(".") as [Group, DepthBand]; return `${REGION_NAME[g]} · ${BAND_NAME[b].toLowerCase()} ${what}`; };

  // Tone first, in the order the curves always ran: the photo's own (black point,
  // contrast, whites), regions, distance, region at a distance, then skin last.
  if (!curvesFlat(p.curves)) push(makeLayer("curves", "Tone & black point", { auto: "curves.photo", params: structuredClone(p.curves) }));
  const rc = Object.entries(p.regionCurves ?? {}) as Array<[Region, Curves]>;
  for (const [r, c] of rc) {
    if (r !== "skin" && !curvesFlat(c)) push(makeLayer("curves", `${REGION_NAME[r]} tone`, { auto: `curves.${r}`, mask: regionMask(r), params: structuredClone(c) }));
  }
  for (const [b, c] of Object.entries(p.depthCurves ?? {}) as Array<[DepthBand, Curves]>) {
    if (!curvesFlat(c)) push(makeLayer("curves", `${BAND_NAME[b]} tone`, { auto: `curves.${b}`, mask: bandMask(b), params: structuredClone(c) }));
  }
  for (const [k, c] of Object.entries(p.cellCurves ?? {}) as Array<[CellKey, Curves]>) {
    if (!curvesFlat(c)) push(makeLayer("curves", cellName(k, "tone"), { mask: cellMask(k), params: structuredClone(c) }));
  }
  for (const [r, c] of rc) {
    if (r === "skin" && !curvesFlat(c)) push(makeLayer("curves", `${REGION_NAME[r]} tone`, { auto: `curves.${r}`, mask: regionMask(r), params: structuredClone(c) }));
  }

  // Colour. Skin keeps its own correction: other regions' and distance colour leave it out
  // (people's colour reaches it, and "Natural skin" holds skin's difference from people).
  for (const g of GROUPS) {
    const m = regionMask(g);
    push(makeLayer("basic", `${REGION_NAME[g]} colour`, { auto: `colour.${g}`, mask: g === "person" ? m : exceptSkin(m), params: basicFrom(p.semantic[g], gv, gs) }));
  }
  for (const b of DEPTH_BANDS) {
    const s = p.distance?.[b];
    if (s) push(makeLayer("basic", `${BAND_NAME[b]} colour`, { auto: `colour.${b}`, mask: exceptSkin(bandMask(b)), params: basicFrom(s, gv, gs) }));
  }
  for (const [k, s] of Object.entries(p.cells ?? {}) as Array<[CellKey, SemanticAdjust]>) {
    push(makeLayer("basic", cellName(k, "colour"), { mask: exceptSkin(cellMask(k)), params: basicFrom(s, gv, gs) }));
  }
  if (p.skin) push(makeLayer("basic", "Natural skin", { auto: "colour.skin", mask: regionMask("skin"), params: basicFrom(p.skin, gv, gs, p.semantic.person) }));

  // Clear what moved.
  const clearColour = (s: SemanticAdjust): SemanticAdjust => ({ ...s, saturation: 0, vibrance: 0, hue: 0, warmth: 0, tint: 0 });
  const semantic = Object.fromEntries(GROUPS.map((g) => [g, clearColour(p.semantic[g])])) as Params["semantic"];
  const flat = { l: [{ x: 0, y: 0 }, { x: 1, y: 1 }], r: [{ x: 0, y: 0 }, { x: 1, y: 1 }], g: [{ x: 0, y: 0 }, { x: 1, y: 1 }], b: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
  return {
    ...p,
    layers,
    autoLayersVersion: AUTO_LAYERS_VERSION,
    curves: flat,
    semantic,
    skin: p.skin ? clearColour(p.skin) : neutralSemantic(),
    distance: Object.fromEntries(DEPTH_BANDS.map((b) => [b, clearColour(p.distance?.[b] ?? neutralSemantic())])) as Params["distance"],
    regionCurves: {},
    depthCurves: {},
    cellCurves: {},
    cells: {},
  };
}
