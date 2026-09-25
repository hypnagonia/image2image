/**
 * Regions tab: per-segment control of the technical rendering, by what things
 * are (the 11 semantic regions + skin), by how far away they are (near /
 * middle / far: this photo's own depth layers) — or both at once: "the far
 * buildings" and "the near buildings" are separate. Everything is blended
 * through soft masks (semantic probability × distance-band weight), so there
 * are no hard edges.
 *
 *   Group by region     a region → All (its own settings), or one of its distances
 *   Group by distance   a distance → All (everything at that distance), or one region there
 *
 * Region settings start at what the decision engine chose (amber = automatic);
 * distance and region-at-a-distance settings are relative layers on top
 * (neutral = no change).
 */
import { cellKey, DEPTH_BANDS, neutralSemantic, type CellKey, type Curves, type DepthBand, type Params, type Region, type SemanticAdjust } from "../decision/params.ts";
import { GROUPS, type Group } from "../neural/scene.ts";
import type { HistTarget } from "../analysis/previewHist.ts";
import { t } from "./i18n.ts";
import { createToneCurves } from "./toneCurves.ts";

type Ctx = {
  params: () => Params | undefined;
  auto: () => Params | undefined;
  coverage: () => Record<string, number> | undefined;
  /** Share of the frame (%) of each region at each distance ("building.far"). */
  cellCoverage: () => Record<string, number> | undefined;
  /** Share of the frame (0…1) of each distance band. */
  bandShare: () => number[] | undefined;
  /** Intensity histogram of what a curve acts on, per channel (drawn behind it). */
  histogram?: (target: HistTarget, chan: "l" | "r" | "g" | "b") => ArrayLike<number> | undefined;
  changed: () => void;
  /** Highlight on the photo: a region (index; 11 = skin), optionally only at a depth range; or only a depth range; undefined stops. */
  highlight: (h: { region?: number; range?: [number, number] } | undefined) => void;
};

/** Same colours as the Regions overlay in the Depth tab. */
const COLORS: Record<Region, string> = {
  skin: "#f2b48c",
  sky: "#5999ff", vegetation: "#33bf33", building: "#bf7349", ground: "#8c8c8c", terrain: "#997f40",
  water: "#1a59cc", person: "#ffbf99", vehicle: "#e63333", animal: "#e6991a", interior: "#994db3", other: "#4d4d4d",
};
const BAND_COLORS: Record<DepthBand, string> = { near: "#f0c060", middle: "#9fb4c8", far: "#6f86b8" };

interface Def { key: keyof SemanticAdjust; label: string; min: number; max: number; step: number; fmt: (v: number) => string }
const pct = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}`;
const mult = (v: number) => `×${v.toFixed(2)}`;
const DEFS: Array<Def | string> = [
  t("reg.light"),
  { key: "exposure", label: t("reg.exposure"), min: -2, max: 2, step: 0.05, fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)} EV` },
  { key: "highlights", label: t("reg.highlights"), min: 0, max: 1, step: 0.01, fmt: (v) => `−${Math.round(v * 100)}` },
  t("reg.colour"),
  { key: "warmth", label: t("reg.warmth"), min: -1, max: 1, step: 0.01, fmt: pct },
  { key: "tint", label: t("reg.tint"), min: -1, max: 1, step: 0.01, fmt: pct },
  { key: "saturation", label: t("reg.saturation"), min: -1, max: 1, step: 0.01, fmt: pct },
  { key: "vibrance", label: t("reg.vibrance"), min: -1, max: 1, step: 0.01, fmt: pct },
  { key: "hue", label: t("reg.hue"), min: -30, max: 30, step: 0.5, fmt: (v) => `${v.toFixed(1)}°` },
  t("reg.detail"),
  { key: "clarity", label: t("reg.clarity"), min: 0, max: 2, step: 0.01, fmt: mult },
  { key: "texture", label: t("reg.texture"), min: 0, max: 2, step: 0.01, fmt: mult },
  { key: "sharpen", label: t("reg.sharpen"), min: 0, max: 2, step: 0.01, fmt: mult },
  { key: "denoise", label: t("reg.denoise"), min: 0, max: 2, step: 0.01, fmt: mult },
  { key: "dehaze", label: t("reg.dehaze"), min: 0, max: 2, step: 0.01, fmt: mult },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}

/** What the settings and curves below edit. */
type Target = { kind: "region"; region: Region } | { kind: "distance"; band: DepthBand } | { kind: "cell"; cell: CellKey; group: Group; band: DepthBand };

export function createRegionsPanel(root: HTMLElement, ctx: Ctx) {
  let mode: "region" | "distance" = "region";
  let selected: Region = "sky";
  let band: DepthBand = "near";
  /** Within the selected region: all of it, or one distance. Within the selected distance: all of it, or one region. */
  let subBand: DepthBand | undefined;
  let subGroup: Group | undefined;
  let showAll = false;
  let highlight = true;
  let visible = false;

  const target = (): Target => {
    if (mode === "region") return subBand && selected !== "skin" ? { kind: "cell", cell: cellKey(selected, subBand), group: selected, band: subBand } : { kind: "region", region: selected };
    return subGroup ? { kind: "cell", cell: cellKey(subGroup, band), group: subGroup, band } : { kind: "distance", band };
  };
  const isNeutral = (tg: Target) => tg.kind !== "region";
  /** The settings object of a target (cells are created on first edit). */
  const adjOf = (p: Params, tg: Target, create = false): SemanticAdjust | undefined => {
    if (tg.kind === "region") return tg.region === "skin" ? p.skin : p.semantic[tg.region];
    if (tg.kind === "distance") return (p.distance ??= { near: neutralSemantic(), middle: neutralSemantic(), far: neutralSemantic() })[tg.band];
    p.cells ??= {};
    if (create && !p.cells[tg.cell]) p.cells[tg.cell] = neutralSemantic();
    return p.cells[tg.cell];
  };
  const autoOf = (tg: Target): SemanticAdjust | undefined => {
    const a = ctx.auto();
    if (isNeutral(tg)) return neutralSemantic();
    return a && tg.kind === "region" ? (tg.region === "skin" ? a.skin : a.semantic[tg.region]) : undefined;
  };
  const curvesOf = (p: Params, tg: Target): Curves | undefined =>
    tg.kind === "region" ? p.regionCurves[tg.region] : tg.kind === "distance" ? p.depthCurves[tg.band] : p.cellCurves?.[tg.cell];
  const setCurves = (p: Params, tg: Target, c: Curves) => {
    if (tg.kind === "region") p.regionCurves[tg.region] = c;
    else if (tg.kind === "distance") p.depthCurves[tg.band] = c;
    else (p.cellCurves ??= {})[tg.cell] = c;
  };
  const histKey = (tg: Target): HistTarget => (tg.kind === "region" ? tg.region : tg.kind === "distance" ? tg.band : tg.cell);
  const bandRange = (b: DepthBand): [number, number] => {
    const [b1, b2] = ctx.params()?.depthBands ?? [0.33, 0.66];
    return b === "near" ? [-1, b1] : b === "middle" ? [b1, b2] : [b2, 2];
  };

  const modeChips = el("div", { class: "chips" });
  const chipsBox = el("div", { class: "chips" });
  const subChips = el("div", { class: "chips sub" });
  const sliders = el("div");
  const hlToggle = el("input", { type: "checkbox" });
  hlToggle.checked = highlight;
  hlToggle.onchange = () => { highlight = hlToggle.checked; applyHighlight(); };
  const allToggle = el("input", { type: "checkbox" });
  allToggle.onchange = () => { showAll = allToggle.checked; render(); };
  const reset = el("button", { class: "btn small", text: t("reg.reset") });
  reset.onclick = () => {
    const p = ctx.params(), a = ctx.auto();
    if (!p || !a) return;
    const tg = target();
    if (tg.kind === "region") {
      if (tg.region === "skin") p.skin = structuredClone(a.skin); else p.semantic[tg.region] = structuredClone(a.semantic[tg.region]);
      if (a.regionCurves[tg.region]) p.regionCurves[tg.region] = structuredClone(a.regionCurves[tg.region]!); else delete p.regionCurves[tg.region];
    } else if (tg.kind === "distance") {
      p.distance[tg.band] = neutralSemantic();
      if (a.depthCurves[tg.band]) p.depthCurves[tg.band] = structuredClone(a.depthCurves[tg.band]!); else delete p.depthCurves[tg.band];
    } else {
      delete p.cells[tg.cell];
      delete p.cellCurves[tg.cell];
    }
    ctx.changed();
    render();
  };
  const resetAll = el("button", { class: "btn small", text: t("reg.resetAll") });
  resetAll.onclick = () => {
    const p = ctx.params(), a = ctx.auto();
    if (!p || !a) return;
    p.semantic = structuredClone(a.semantic);
    p.skin = structuredClone(a.skin);
    p.regionCurves = structuredClone(a.regionCurves);
    p.depthCurves = structuredClone(a.depthCurves);
    p.distance = { near: neutralSemantic(), middle: neutralSemantic(), far: neutralSemantic() };
    p.cells = {};
    p.cellCurves = {};
    ctx.changed();
    render();
  };

  // Curves of whatever is selected, blended by its soft mask.
  const curves = createToneCurves({
    histogram: (c) => ctx.histogram?.(histKey(target()), c),
    get: () => { const p = ctx.params(); return p ? curvesOf(p, target()) : undefined; },
    set: (c) => { const p = ctx.params(); if (p) setCurves(p, target(), c); },
    changed: () => ctx.changed(),
    enabled: () => !!ctx.params(),
  });
  const skinNote = el("p", { class: "muted", text: t("reg.skinHint") });
  const relNote = el("p", { class: "muted", text: t("reg.relHint") });
  const curvesTitle = el("div", { class: "group-title", text: t("reg.curves") });
  root.replaceChildren(
    el("p", { class: "muted", text: t("reg.hint") }),
    modeChips,
    chipsBox,
    subChips,
    el("label", { class: "toggle" }, t("reg.highlight"), hlToggle),
    el("label", { class: "toggle" }, t("reg.showAll"), allToggle),
    skinNote,
    relNote,
    sliders,
    curvesTitle,
    curves.el,
    el("div", { class: "actions" }, reset, resetAll),
  );

  function applyHighlight() {
    if (!visible || !highlight) { ctx.highlight(undefined); return; }
    const tg = target();
    if (tg.kind === "region") ctx.highlight({ region: tg.region === "skin" ? 11 : GROUPS.indexOf(tg.region) });
    else if (tg.kind === "distance") ctx.highlight({ range: bandRange(tg.band) });
    else ctx.highlight({ region: GROUPS.indexOf(tg.group), range: bandRange(tg.band) });
  }

  const chip = (label: string, color: string | undefined, on: boolean, share: number | undefined, click: () => void) => {
    const kids: Array<Node | string> = [];
    if (color) { const dot = el("i", { class: "hue-dot" }); dot.style.background = color; kids.push(dot); }
    kids.push(`${label}${share !== undefined ? ` ${share < 1 ? share.toFixed(1) : Math.round(share)}%` : ""}`);
    const b = el("button", { class: "chip" + (on ? " on" : "") }, ...kids);
    b.onclick = click;
    return b;
  };
  const edited = (p: Params | undefined, tg: Target) => {
    if (!p) return false;
    if (tg.kind === "cell") return !!p.cells?.[tg.cell] || !!p.cellCurves?.[tg.cell];
    if (tg.kind === "distance") return JSON.stringify(p.distance?.[tg.band] ?? neutralSemantic()) !== JSON.stringify(neutralSemantic());
    return false;
  };

  function render() {
    const p = ctx.params();
    const cov = ctx.coverage() ?? {};
    const cc = ctx.cellCoverage() ?? {};
    const shares = ctx.bandShare();
    modeChips.replaceChildren(
      chip(t("reg.byRegion"), undefined, mode === "region", undefined, () => { mode = "region"; subGroup = undefined; render(); applyHighlight(); }),
      chip(t("reg.byDistance"), undefined, mode === "distance", undefined, () => { mode = "distance"; subBand = undefined; render(); applyHighlight(); }),
    );
    const present = (g: Group) => showAll || (cov[g] ?? 0) >= 0.5;
    if (mode === "region") {
      const regions: Region[] = GROUPS.filter(present);
      // Skin whenever there are people (its share is not measured: it is a layer).
      if (showAll || (cov.person ?? 0) >= 0.5) regions.splice(regions.indexOf("person") + 1 || regions.length, 0, "skin");
      if (!regions.includes(selected) && regions.length) selected = [...regions].sort((a, b) => (cov[b] ?? 0) - (cov[a] ?? 0))[0];
      chipsBox.replaceChildren(...regions.map((g) => chip(t(`group.${g}`), COLORS[g], g === selected, cov[g], () => { selected = g; subBand = undefined; render(); applyHighlight(); })));
      // Distances of this region that exist in the photo.
      const bands = selected === "skin" ? [] : DEPTH_BANDS.filter((b) => showAll || (cc[cellKey(selected as Group, b)] ?? 0) >= 0.3);
      if (subBand && !bands.includes(subBand)) subBand = undefined;
      subChips.replaceChildren(...(bands.length > 1 || (bands.length === 1 && showAll) ? [
        chip(t("reg.all"), undefined, !subBand, undefined, () => { subBand = undefined; render(); applyHighlight(); }),
        ...bands.map((b) => {
          const tg: Target = { kind: "cell", cell: cellKey(selected as Group, b), group: selected as Group, band: b };
          return chip(t(`band.${b}`) + (edited(p, tg) ? " •" : ""), BAND_COLORS[b], subBand === b, cc[cellKey(selected as Group, b)], () => { subBand = b; render(); applyHighlight(); });
        }),
      ] : []));
    } else {
      chipsBox.replaceChildren(...DEPTH_BANDS.map((b, i) => chip(t(`band.${b}`) + (edited(p, { kind: "distance", band: b }) ? " •" : ""), BAND_COLORS[b], b === band, shares ? shares[i] * 100 : undefined, () => { band = b; subGroup = undefined; render(); applyHighlight(); })));
      // Regions present at this distance.
      const groups = GROUPS.filter((g) => showAll || (cc[cellKey(g, band)] ?? 0) >= 0.3);
      if (subGroup && !groups.includes(subGroup)) subGroup = undefined;
      subChips.replaceChildren(
        chip(t("reg.all"), undefined, !subGroup, undefined, () => { subGroup = undefined; render(); applyHighlight(); }),
        ...groups.map((g) => {
          const tg: Target = { kind: "cell", cell: cellKey(g, band), group: g, band };
          return chip(t(`group.${g}`) + (edited(p, tg) ? " •" : ""), COLORS[g], subGroup === g, cc[cellKey(g, band)], () => { subGroup = g; render(); applyHighlight(); });
        }),
      );
    }
    const tg = target();
    skinNote.hidden = !(tg.kind === "region" && tg.region === "skin");
    relNote.hidden = tg.kind === "region";
    curves.render();
    if (!p) { sliders.replaceChildren(); return; }
    const auto = autoOf(tg);
    const read = () => adjOf(p, tg) ?? neutralSemantic();
    sliders.replaceChildren(...DEFS.map((d) => {
      if (typeof d === "string") return el("div", { class: "group-title", text: d });
      const input = el("input", { type: "range", min: String(d.min), max: String(d.max), step: String(d.step) });
      const out = el("output");
      const show = () => {
        const v = (read()[d.key] as number) ?? 0;
        input.value = String(v);
        out.textContent = d.fmt(v);
        out.classList.toggle("auto", auto !== undefined && Math.abs(((auto[d.key] as number) ?? 0) - v) < 1e-6);
      };
      input.oninput = () => {
        (adjOf(p, tg, true) as unknown as Record<string, number>)[d.key] = +input.value;
        show();
        ctx.changed();
      };
      const label = el("label", { text: d.label });
      label.addEventListener("dblclick", () => {
        if (!auto) return;
        (adjOf(p, tg, true) as unknown as Record<string, number>)[d.key] = (auto[d.key] as number) ?? 0;
        show();
        ctx.changed();
      });
      show();
      return el("div", { class: "row" }, label, input, out);
    }));
  }

  return {
    render,
    /** Redraws only the curve box (new histograms), leaving the sliders alone. */
    refreshCurves: () => curves.refreshHistogram(),
    setVisible(v: boolean) { visible = v; applyHighlight(); if (v) render(); },
  };
}
