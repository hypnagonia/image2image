/**
 * The layers editor (Photopea-style, phone first).
 *
 *   dock        the stack: top layer first, Develop (the RAW development) last and
 *               fixed; each card: eye, name, "Auto" badge; tap selects, long-press
 *               and drag reorders; ＋ adds a layer above the selected one
 *   properties  the selected layer: name, show/hide, duplicate, delete, reset to
 *               automatic; segments Adjust · Mask · Blend
 *
 * Every change calls ctx.changed(label): the app pushes the parameters (drafts
 * while a control is held) and commits one history step when the gesture ends.
 */
import type { Params, Region, DepthBand } from "../../decision/params.ts";
import { DEPTH_BANDS } from "../../decision/params.ts";
import { GROUPS } from "../../neural/scene.ts";
import type { HistTarget } from "../../analysis/previewHist.ts";
import { BLEND_MODES, HUE_RANGES, RANGE_CENTRE, makeLayer, newLayerDefaults, newId, type HueRange, type Layer, type LayerParams, type LayerType, type SmartMask } from "../../layers/model.ts";
import { createToneCurves } from "../toneCurves.ts";
import { t, tOr } from "../i18n.ts";
import { icon } from "./icons.ts";
import { createGradientEditor } from "./gradientEditor.ts";
import { liveLayers } from "../../layers/gpu.ts";
import { el } from "../dom.ts";

type Ctx = {
  params: () => Params | undefined;
  auto: () => Params | undefined;
  coverage: () => Record<string, number> | undefined;
  cellCoverage: () => Record<string, number> | undefined;
  histogram: (target: HistTarget, chan: "l" | "r" | "g" | "b") => ArrayLike<number> | undefined;
  /** Parameters changed (label for the history step). */
  changed: (label: string) => void;
  /** Shows a layer's mask on the photo (its index among the visible layers), or stops. */
  showMask: (liveIndex: number | undefined) => void;
  /** The Develop properties (exposure, tone, colour, detail). */
  develop: HTMLElement;
  /** The Blur properties (depth of field: focus, strength, zones, depth views). */
  blur: HTMLElement;
  /** Something other than Blur became selected: its photo tools (focus picking, zone views) end. */
  leftBlur?: () => void;
};

/** Layer types in the ＋ sheet (each type's icon has the type's name). */
/** The cards that are not layers: always there, at the bottom of the stack. */
type Fixed = "develop" | "blur";

const ADD: LayerType[] = ["curves", "hueSat", "basic", "gradientMap", "gradientFill", "brightContrast", "exposure"];


/** A layer's name as shown: automatic layers in the interface language (unless renamed). */
export function layerName(l: Layer): string {
  if (!l.auto || (l as Layer & { renamed?: boolean }).renamed) return l.name;
  const [kind, what] = l.auto.split(".");
  const regionOrBand = (w: string) => (DEPTH_BANDS as string[]).includes(w) ? t(`band.${w as DepthBand}`) : tOr(`group.${w}`, w);
  if (l.auto === "curves.photo") return t("lay.photoTone");
  if (l.auto === "curves.black") return t("lay.blackPoint");
  if (l.auto === "subject") return t("lay.subject");
  if (kind === "curves" && what) return t("lay.tone", { name: regionOrBand(what) });
  if (kind === "colour" && what) return t("lay.colour", { name: regionOrBand(what) });
  return l.name;
}

export function createLayersPanel(dock: HTMLElement, props: HTMLElement, ctx: Ctx) {
  let selected = "develop";
  let tab: "adjust" | "mask" | "blend" = "adjust";
  let showMask = true;
  let visible = true;

  const layers = () => ctx.params()?.layers ?? [];
  const sel = () => layers().find((l) => l.id === selected);
  const liveIndex = (id: string) => { const p = ctx.params(); return liveLayers(layers(), p?.autoCurves ?? 1, p?.enable).findIndex((l) => l.id === id); };
  const typeName = (ty: LayerType) => t(`lay.type.${ty}`);
  const edit = (label?: string) => { const l = sel(); ctx.changed(label ?? (l ? t("hist.editLayer", { name: layerName(l) }) : t("hist.edit"))); };

  // ------------------------------------------------------------------ dock
  const list = el("div", { class: "lay-list" });
  const addBtn = el("button", { class: "lay-add", title: t("lay.add"), "aria-label": t("lay.add") }, icon("plus", 22));
  dock.replaceChildren(list, addBtn);

  /** A layer's card, or (no layer) one of the fixed cards: Develop, Blur. */
  function card(l: Layer | undefined, fixed: Fixed = "develop"): HTMLElement {
    const id = l?.id ?? fixed;
    const on = id === selected;
    const name = el("span", { class: "lay-name", text: l ? layerName(l) : t(`lay.${fixed}`) });
    const glyph = el("span", { class: "lay-glyph" }, icon(l ? l.type : fixed, 18));
    const hidden = l && !l.visible;
    const c = el("div", { class: "lay-card" + (on ? " on" : "") + (l?.auto ? " auto" : "") + (l ? "" : " develop") + (hidden ? " hidden" : ""), "data-id": id }, glyph, name);
    // Automatic layers: a small dot (the full word is in the properties); hidden layers: dimmed, eye crossed.
    if (l?.auto) c.append(el("span", { class: "lay-badge", title: t("lay.auto") }));
    const eye = el("span", { class: "lay-eye", role: "button", "aria-label": t("lay.visible") }, icon(hidden ? "eyeOff" : "eye", 16));
    if (l) c.append(eye);
    eye.onclick = (e) => { e.stopPropagation(); if (!l) return; l.visible = !l.visible; edit(t(l.visible ? "hist.show" : "hist.hide", { name: layerName(l) })); render(); };
    c.onclick = () => { if (dragMoved) return; selected = id; tab = "adjust"; render(); };
    if (l) enableReorder(c, l);
    return c;
  }

  // Long-press, then drag along the list: reorder (horizontal strip on phones, vertical list on desktop).
  // The card moves in the list while dragging; the stack changes once, on release (one history step).
  let dragMoved = false;
  function enableReorder(c: HTMLElement, l: Layer) {
    let timer = 0, dragging = false, start = { x: 0, y: 0 };
    c.addEventListener("pointerdown", (e) => {
      dragMoved = false;
      start = { x: e.clientX, y: e.clientY };
      timer = window.setTimeout(() => { dragging = true; c.classList.add("dragging"); try { c.setPointerCapture(e.pointerId); } catch { /* pointer gone */ } }, 350);
    });
    // Once dragging, the finger moves the card, not the list.
    c.addEventListener("touchmove", (e) => { if (dragging) e.preventDefault(); }, { passive: false });
    c.addEventListener("pointermove", (e) => {
      if (!dragging) { if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) clearTimeout(timer); return; }
      dragMoved = true;
      const horizontal = getComputedStyle(list).flexDirection === "row";
      const pos = horizontal ? e.clientX : e.clientY;
      const others = [...list.querySelectorAll<HTMLElement>(".lay-card:not(.develop)")].filter((k) => k !== c);
      const before = others.find((k) => { const r = k.getBoundingClientRect(); return pos < (horizontal ? r.left + r.width / 2 : r.top + r.height / 2); });
      const target = before ?? list.querySelector<HTMLElement>(".lay-card.develop");
      if (target && c.nextElementSibling !== target) list.insertBefore(c, target);
    });
    const end = () => {
      clearTimeout(timer);
      if (dragging) {
        dragging = false;
        c.classList.remove("dragging");
        const p = ctx.params();
        if (p && dragMoved) {
          // Display order is top-first; the array is bottom-first.
          const ids = [...list.querySelectorAll<HTMLElement>(".lay-card:not(.develop)")].map((k) => k.dataset.id).reverse();
          const next = ids.map((id) => p.layers.find((x) => x.id === id)).filter((x): x is Layer => !!x);
          if (next.length === p.layers.length && next.some((x, i) => x !== p.layers[i])) { p.layers.splice(0, p.layers.length, ...next); ctx.changed(t("hist.order")); }
          renderDock();
        }
      }
      setTimeout(() => (dragMoved = false), 0);
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
  }

  function renderDock() {
    list.replaceChildren(...[...layers()].reverse().map((l) => card(l)), card(undefined, "develop"), card(undefined, "blur"));
    list.querySelector(".lay-card.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // ------------------------------------------------------------------ add sheet
  const addSheet = el("div", { class: "lay-addsheet", hidden: "" });
  addBtn.onclick = () => { addSheet.hidden = !addSheet.hidden; };
  addSheet.append(el("div", { class: "group-title", text: t("lay.add") }), el("div", { class: "lay-addgrid" }, ...ADD.map((type) => {
    const b = el("button", { class: "lay-addbtn" }, el("span", { class: "g" }, icon(type, 22)), el("span", { text: typeName(type) }));
    b.onclick = () => {
      const p = ctx.params(); if (!p) return;
      const n = p.layers.filter((l) => l.type === type).length + 1;
      const l = makeLayer(type, `${typeName(type)} ${n}`, newLayerDefaults(type));
      const at = p.layers.findIndex((x) => x.id === selected);
      p.layers.splice(at + 1, 0, l); // above the selected one (Develop: at the bottom of the stack)
      selected = l.id; tab = "adjust"; addSheet.hidden = true;
      ctx.changed(t("hist.new", { name: typeName(type) }));
      render();
    };
    return b;
  })));
  dock.append(addSheet);
  // A tap anywhere else closes the ＋ sheet.
  document.addEventListener("pointerdown", (e) => {
    if (!addSheet.hidden && !addSheet.contains(e.target as Node) && !addBtn.contains(e.target as Node)) addSheet.hidden = true;
  }, true);

  // ------------------------------------------------------------------ controls
  function slider(label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string, def: number): HTMLElement {
    const input = el("input", { type: "range", min: String(min), max: String(max), step: String(step) });
    const out = el("output");
    const show = () => { const v = get(); input.value = String(v); out.textContent = fmt(v); out.classList.toggle("auto", Math.abs(v - def) < 1e-6); };
    input.oninput = () => { set(parseFloat(input.value)); show(); edit(); };
    const lab = el("label", { text: label });
    lab.addEventListener("dblclick", () => { set(def); show(); edit(); });
    show();
    return el("div", { class: "row" }, lab, input, out);
  }
  const pct = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}`;
  const deg = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v)}°`;
  const ev = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
  function chips<T extends string>(items: Array<{ id: T; label: string; extra?: string }>, current: T | undefined, pick: (id: T) => void): HTMLElement {
    return el("div", { class: "chips" }, ...items.map((it) => {
      const b = el("button", { class: "chip" + (it.id === current ? " on" : ""), text: it.label + (it.extra ? ` ${it.extra}` : "") });
      b.onclick = () => pick(it.id);
      return b;
    }));
  }
  function toggle(label: string, value: boolean, set: (v: boolean) => void): HTMLElement {
    const cb = el("input", { type: "checkbox" });
    cb.checked = value;
    cb.onchange = () => set(cb.checked);
    return el("label", { class: "toggle" }, label, cb);
  }

  // ------------------------------------------------------------------ adjust: per type
  let hsRange: HueRange = "master";
  function adjustBody(l: Layer): HTMLElement[] {
    switch (l.type) {
      case "curves": {
        const target = maskTarget(l.mask);
        const c = createToneCurves({
          histogram: (ch) => ctx.histogram(target, ch),
          get: () => l.params as LayerParams["curves"],
          set: (v) => { l.params = v; },
          changed: () => edit(),
          enabled: () => true,
        });
        curvesUi = c;
        return [c.el];
      }
      case "hueSat": {
        const h = l.params as LayerParams["hueSat"];
        const r = () => (h.ranges[hsRange] ??= { hue: 0, sat: 0, light: 0, inner: 15, outer: 45 });
        const out: HTMLElement[] = [];
        if (!h.colorize) {
          out.push(chips(HUE_RANGES.map((k) => ({ id: k, label: t(`hs.${k}`), extra: h.ranges[k] && (h.ranges[k]!.hue || h.ranges[k]!.sat || h.ranges[k]!.light) ? "•" : "" })), hsRange, (k) => { hsRange = k; renderProps(); }));
          out.push(slider(t("hs.hue"), -180, 180, 1, () => r().hue, (v) => (r().hue = v), deg, 0));
          out.push(slider(t("hs.sat"), -1, 1, 0.01, () => r().sat, (v) => (r().sat = v), pct, 0));
          out.push(slider(t("hs.light"), -1, 1, 0.01, () => r().light, (v) => (r().light = v), pct, 0));
          if (hsRange !== "master") out.push(rangeBar(h, hsRange));
        } else {
          out.push(slider(t("hs.hue"), 0, 360, 1, () => h.cHue, (v) => (h.cHue = v), (v) => `${Math.round(v)}°`, 30));
          out.push(slider(t("hs.sat"), 0, 1, 0.01, () => h.cSat, (v) => (h.cSat = v), (v) => String(Math.round(v * 100)), 0.25));
          out.push(slider(t("hs.light"), -1, 1, 0.01, () => h.cLight, (v) => (h.cLight = v), pct, 0));
        }
        out.push(toggle(t("hs.colorize"), h.colorize, (v) => { h.colorize = v; edit(); renderProps(); }));
        return out;
      }
      case "gradientMap": {
        const g = l.params as LayerParams["gradientMap"];
        return [createGradientEditor(() => g, (label) => edit(label), slider),
          el("div", { class: "muted grad-tip", text: t("grad.mapTip") })];
      }
      case "gradientFill": {
        const g = l.params as LayerParams["gradientFill"];
        const pctv = (v: number) => `${Math.round(v * 100)}%`;
        return [createGradientEditor(() => g, (label) => edit(label), slider),
          el("div", { class: "group-title", text: t("grad.shape") }),
          chips([{ id: "linear", label: t("grad.linear") }, { id: "radial", label: t("grad.radial") }] as const, g.style, (v) => { g.style = v; edit(); renderProps(); }),
          ...(g.style === "linear" ? [slider(t("grad.angle"), -180, 180, 1, () => g.angle, (v) => (g.angle = v), (v) => `${Math.round(v)}°`, 90)] : []),
          slider(t("grad.scale"), 0.1, 2, 0.01, () => g.scale, (v) => (g.scale = v), pctv, 1),
          slider(t("grad.x"), 0, 1, 0.01, () => g.x, (v) => (g.x = v), pctv, 0.5),
          slider(t("grad.y"), 0, 1, 0.01, () => g.y, (v) => (g.y = v), pctv, 0.5)];
      }
      case "brightContrast": {
        const b = l.params as LayerParams["brightContrast"];
        return [slider(t("bc.brightness"), -1, 1, 0.01, () => b.brightness, (v) => (b.brightness = v), pct, 0),
          slider(t("bc.contrast"), -1, 1, 0.01, () => b.contrast, (v) => (b.contrast = v), pct, 0)];
      }
      case "exposure": {
        const e = l.params as LayerParams["exposure"];
        return [slider(t("ex.exposure"), -3, 3, 0.01, () => e.exposure, (v) => (e.exposure = v), ev, 0),
          slider(t("ex.offset"), -0.1, 0.1, 0.001, () => e.offset, (v) => (e.offset = v), (v) => v.toFixed(3), 0),
          slider(t("ex.gamma"), 0.3, 3, 0.01, () => e.gamma, (v) => (e.gamma = v), (v) => v.toFixed(2), 1)];
      }
      case "basic": {
        const b = l.params as LayerParams["basic"];
        return [slider(t("basic.exposure"), -2, 2, 0.01, () => b.exposure, (v) => (b.exposure = v), ev, 0),
          slider(t("basic.temp"), -1, 1, 0.01, () => b.temp, (v) => (b.temp = v), pct, 0),
          slider(t("basic.tint"), -1, 1, 0.01, () => b.tint, (v) => (b.tint = v), pct, 0),
          slider(t("basic.saturation"), -1, 1, 0.01, () => b.saturation, (v) => (b.saturation = v), pct, 0),
          slider(t("basic.vibrance"), -1, 1, 0.01, () => b.vibrance, (v) => (b.vibrance = v), pct, 0),
          slider(t("basic.hue"), -30, 30, 0.5, () => b.hue, (v) => (b.hue = v), deg, 0)];
      }
    }
    return [];
  }

  /** Hue/Saturation colour range: a rainbow with draggable limits (full effect inside, fading to the outer marks). */
  function rangeBar(h: LayerParams["hueSat"], k: HueRange): HTMLElement {
    const r = h.ranges[k]!;
    const centre = RANGE_CENTRE[k as Exclude<HueRange, "master">];
    const cv = el("canvas", { class: "hs-range" });
    const W = 600, H = 56;
    cv.width = W; cv.height = H;
    const x = (d: number) => ((((centre + d) % 360) + 360) % 360) / 360 * W;
    const draw = () => {
      const c = cv.getContext("2d")!;
      c.clearRect(0, 0, W, H);
      for (let i = 0; i < W; i++) { c.fillStyle = `hsl(${(i / W) * 360}, 90%, 55%)`; c.fillRect(i, 6, 1, 20); }
      c.fillStyle = "rgba(255,255,255,.18)";
      for (let d = -r.outer!; d <= r.outer!; d += 0.5) c.fillRect(x(d), 30, 1.2, 8);
      c.fillStyle = "rgba(255,255,255,.55)";
      for (let d = -r.inner!; d <= r.inner!; d += 0.5) c.fillRect(x(d), 30, 1.2, 8);
      c.fillStyle = "#fff";
      for (const d of [-r.outer!, -r.inner!, r.inner!, r.outer!]) { const px = x(d); c.beginPath(); c.moveTo(px, 28); c.lineTo(px - 7, 48); c.lineTo(px + 7, 48); c.closePath(); c.fill(); }
      lab.textContent = `${Math.round(centre - r.outer!)}° / ${Math.round(centre - r.inner!)}°    ${Math.round(centre + r.inner!)}° \\ ${Math.round(centre + r.outer!)}°`;
    };
    const lab = el("div", { class: "muted hs-range-label" });
    let which: "inner" | "outer" | undefined;
    const pos = (e: PointerEvent) => { const b = cv.getBoundingClientRect(); return ((e.clientX - b.left) / b.width) * 360; };
    const dist = (a: number) => { let d = Math.abs(a - centre) % 360; if (d > 180) d = 360 - d; return d; };
    cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture(e.pointerId); const d = dist(pos(e)); which = Math.abs(d - r.inner!) < Math.abs(d - r.outer!) ? "inner" : "outer"; });
    cv.addEventListener("pointermove", (e) => {
      if (!which) return;
      const d = Math.min(170, dist(pos(e)));
      if (which === "inner") r.inner = Math.min(d, r.outer! - 1); else r.outer = Math.max(d, r.inner! + 1);
      draw(); edit();
    });
    const up = () => { which = undefined; };
    cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
    draw();
    return el("div", { class: "hs-range-wrap" }, el("div", { class: "group-title", text: t("hs.range") }), cv, lab);
  }

  // ------------------------------------------------------------------ mask
  function maskTarget(m: SmartMask): HistTarget {
    if (m.kind === "region" && m.region) return m.region;
    if (m.kind === "distance" && m.band) return m.band;
    if (m.kind === "cell" && m.region && m.band && m.region !== "skin") return `${m.region}.${m.band}` as HistTarget;
    return "photo";
  }
  function maskBody(l: Layer): HTMLElement[] {
    const m = l.mask;
    const cov = ctx.coverage() ?? {};
    const cc = ctx.cellCoverage() ?? {};
    const regions: Region[] = GROUPS.filter((g) => (cov[g] ?? 0) >= 0.5);
    if ((cov.person ?? 0) >= 0.5) regions.splice(regions.indexOf("person") + 1, 0, "skin");
    const set = (patch: Partial<SmartMask>) => { l.mask = { ...m, ...patch }; edit(t("hist.mask", { name: layerName(l) })); renderProps(); };
    const out: HTMLElement[] = [
      chips<SmartMask["kind"]>([
        { id: "all", label: t("mask.all") }, { id: "region", label: t("mask.region") }, { id: "distance", label: t("mask.distance") },
        { id: "cell", label: t("mask.cell") }, { id: "luminance", label: t("mask.luminance") },
      ], m.kind, (k) => set({ kind: k, region: k === "cell" && m.region === "skin" ? "person" : m.region ?? regions[0] ?? "sky", band: m.band ?? "near", lum: m.lum ?? [0, 0.3, 0.08] })),
    ];
    if (m.kind === "region" || m.kind === "cell") {
      const rs = m.kind === "cell" ? regions.filter((r) => r !== "skin") : regions;
      out.push(chips(rs.map((r) => ({ id: r, label: tOr(`group.${r}`, r), extra: cov[r] !== undefined ? `${Math.round(cov[r])}%` : "" })), m.region, (r) => set({ region: r })));
    }
    if (m.kind === "distance" || m.kind === "cell") {
      out.push(chips(DEPTH_BANDS.map((b) => ({ id: b, label: t(`band.${b}`), extra: m.kind === "cell" && m.region && m.region !== "skin" ? `${Math.round(cc[`${m.region}.${b}`] ?? 0)}%` : "" })), m.band, (b) => set({ band: b })));
    }
    if (m.kind === "luminance") {
      const lum = (m.lum ??= [0, 0.3, 0.08]);
      out.push(slider(t("mask.low"), 0, 1, 0.01, () => lum[0], (v) => (lum[0] = v), (v) => String(Math.round(v * 100)), 0));
      out.push(slider(t("mask.high"), 0, 1, 0.01, () => lum[1], (v) => (lum[1] = v), (v) => String(Math.round(v * 100)), 0.3));
      out.push(slider(t("mask.soft"), 0.01, 0.3, 0.01, () => lum[2], (v) => (lum[2] = v), (v) => String(Math.round(v * 100)), 0.08));
    }
    if (m.kind !== "all") {
      out.push(toggle(t("mask.invert"), m.invert, (v) => set({ invert: v })));
      out.push(slider(t("mask.feather"), 0, 1, 0.01, () => m.feather, (v) => (m.feather = v), (v) => `${Math.round(v * 100)}%`, 1));
    }
    out.push(slider(t("mask.density"), 0, 1, 0.01, () => m.density, (v) => (m.density = v), (v) => `${Math.round(v * 100)}%`, 1));
    out.push(toggle(t("mask.show"), showMask, (v) => { showMask = v; applyMaskView(); }));
    return out;
  }
  // Only changes reach the app (each one re-renders the photo and resets other views).
  let maskSent: number | undefined | null = null;
  function applyMaskView() {
    const l = sel();
    const i = l ? liveIndex(l.id) : -1;
    const want = visible && tab === "mask" && showMask && i >= 0 ? i : undefined;
    if (want === maskSent) return;
    maskSent = want;
    ctx.showMask(want);
  }

  // ------------------------------------------------------------------ blend
  function blendBody(l: Layer): HTMLElement[] {
    return [
      el("div", { class: "group-title", text: t("blend.mode") }),
      chips(BLEND_MODES.map((b) => ({ id: b, label: t(`blend.${b}`) })), l.blend, (b) => { l.blend = b; edit(t("hist.blend", { name: layerName(l) })); renderProps(); }),
      slider(t("blend.opacity"), 0, 1, 0.01, () => l.opacity, (v) => (l.opacity = v), (v) => `${Math.round(v * 100)}%`, 1),
    ];
  }

  // ------------------------------------------------------------------ properties
  let curvesUi: ReturnType<typeof createToneCurves> | undefined;
  function renderProps() {
    curvesUi = undefined;
    const l = sel();
    if (!l) {
      if (selected !== "blur") { selected = "develop"; ctx.leftBlur?.(); }
      props.replaceChildren(selected === "blur" ? ctx.blur : ctx.develop);
      applyMaskView();
      return;
    }
    ctx.leftBlur?.();
    const name = el("input", { class: "lay-title", value: layerName(l), "aria-label": t("lay.name") });
    name.onchange = () => { l.name = name.value.trim() || layerName(l); (l as Layer & { renamed?: boolean }).renamed = true; edit(); renderDock(); };
    const act = (ic: Parameters<typeof icon>[0], label: string, fn: () => void) => { const b = el("button", { class: "btn small icon ghost", title: label, "aria-label": label }, icon(ic, 19)); b.onclick = fn; return b; };
    const p = ctx.params()!;
    const titleBox = el("div", { class: "lay-titlebox" }, name);
    if (l.auto) titleBox.append(el("span", { class: "lay-sub", text: `${typeName(l.type)} · ${t("lay.auto")}` }));
    else titleBox.append(el("span", { class: "lay-sub", text: typeName(l.type) }));
    const head = el("div", { class: "lay-head" }, el("span", { class: "lay-glyph big" }, icon(l.type, 20)), titleBox,
      act(l.visible ? "eye" : "eyeOff", t("lay.visible"), () => { l.visible = !l.visible; edit(t(l.visible ? "hist.show" : "hist.hide", { name: layerName(l) })); render(); }),
      act("copy", t("lay.duplicate"), () => {
        const c = { ...structuredClone(l), id: newId(), auto: undefined, name: `${layerName(l)} 2` };
        p.layers.splice(p.layers.indexOf(l) + 1, 0, c);
        selected = c.id; ctx.changed(t("hist.duplicate", { name: layerName(l) })); render();
      }),
      act("trash", t("lay.delete"), () => {
        const i = p.layers.indexOf(l);
        p.layers.splice(i, 1);
        selected = p.layers[Math.min(i, p.layers.length - 1)]?.id ?? "develop";
        ctx.changed(t("hist.delete", { name: layerName(l) })); render();
      }),
    );
    if (l.auto) {
      const orig = ctx.auto()?.layers.find((x) => x.auto === l.auto);
      if (orig) head.append(act("reset", t("lay.resetAuto"), () => {
        delete (l as Layer & { renamed?: boolean }).renamed;
        Object.assign(l, structuredClone({ ...orig, id: l.id }));
        ctx.changed(t("hist.reset", { name: layerName(l) })); render();
      }));
    }
    const segs = el("div", { class: "seg" }, ...(["adjust", "mask", "blend"] as const).map((k) => {
      const b = el("button", { class: k === tab ? "on" : "", text: t(`lay.tab.${k}`) });
      b.onclick = () => { tab = k; renderProps(); };
      return b;
    }));
    const body = tab === "adjust" ? adjustBody(l) : tab === "mask" ? maskBody(l) : blendBody(l);
    props.replaceChildren(head, segs, ...body);
    applyMaskView();
  }

  function render() { renderDock(); renderProps(); }

  return {
    render,
    /** New histograms: redraw the curve box only. */
    refreshHistogram() { curvesUi?.refreshHistogram(); },
    /** The panel became visible / hidden (mask view only while it is shown). */
    setVisible(v: boolean) { visible = v; applyMaskView(); },
    selectDevelop() { selected = "develop"; render(); },
  };
}

