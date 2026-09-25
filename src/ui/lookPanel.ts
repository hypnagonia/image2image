/**
 * Look tab: profile browser with live thumbnails, palette analysis, reference
 * creation / matching, JSON + .cube import/export, and the profile editor.
 *
 * Built-in profiles are never modified: the first edit forks a custom copy.
 * Custom profiles are kept in localStorage (this device only).
 */
import type { Params } from "../decision/params.ts";
import type { ToWorker } from "../engine/protocol.ts";
import { BUILTIN_PROFILES } from "../looks/builtin.ts";
import { CATEGORIES, HUE_RANGES, MAX_ANCHORS, balanceToAB, parseProfile, serialize, type LookProfile, type DepthCurve, type RGB } from "../looks/profile.ts";
import { abToBalance } from "../looks/reference.ts";
import type { ColorStats } from "../looks/palette.ts";
import { GROUPS, type Group } from "../neural/scene.ts";
import { CurveEditor, hueColor, rainbowGradient } from "./curveEditor.ts";
import { t, tOr } from "./i18n.ts";

type Ctx = {
  send: (m: ToWorker) => void;
  params: () => Params | undefined;
  /** Called after the profile in params changed (sync UI + push to worker). */
  changed: () => void;
  download: (blob: Blob, name: string) => void;
  progress: (text: string | undefined) => void;
};

const STORE = "lookProfiles.v1";

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

/** Built-in profiles are shown translated; the stored id/name/description stay as they are. */
const builtinText = (pr: LookProfile, field: "name" | "desc") =>
  BUILTIN_PROFILES.some((b) => b.id === pr.id) ? tOr(`look.${pr.id}.${field}`, (field === "name" ? pr.name : pr.description) ?? "") : (field === "name" ? pr.name : pr.description) ?? "";
const lookName = (pr: LookProfile) => builtinText(pr, "name");
const lookDesc = (pr: LookProfile) => builtinText(pr, "desc");

export function createLookPanel(root: HTMLElement, ctx: Ctx) {
  let custom: LookProfile[] = [];
  try { custom = (JSON.parse(localStorage.getItem(STORE) ?? "[]") as unknown[]).map((j) => parseProfile(JSON.stringify(j))); } catch { custom = []; }
  const saveCustom = () => { try { localStorage.setItem(STORE, JSON.stringify(custom)); } catch { /* quota / private */ } };
  const all = () => [...BUILTIN_PROFILES, ...custom];
  const isBuiltin = (id: string) => BUILTIN_PROFILES.some((b) => b.id === id);
  const thumbs = new Map<string, ImageData>();
  let lutSources: Array<{ id: string; name: string }> = [];
  let thumbsStale = true;
  let lastPalette: ColorStats | undefined;

  const cur = () => ctx.params()?.profile;

  /** Returns a mutable profile, forking built-ins on first edit. */
  function editable(): LookProfile | undefined {
    const p = ctx.params();
    if (!p) return undefined;
    if (isBuiltin(p.profile.id) || p.profile.id === "neutral") {
      const fork = structuredClone(p.profile);
      fork.id = `${p.profile.id}-edit-${Date.now().toString(36)}`;
      fork.name = t("look.edited", { name: lookName(p.profile) });
      fork.category = "custom";
      custom.push(fork);
      p.profile = fork;
      renderBrowser();
    }
    return p.profile;
  }
  function commit() {
    const p = cur();
    if (!p) return;
    const i = custom.findIndex((c) => c.id === p.id);
    if (i >= 0) { custom[i] = structuredClone(p); saveCustom(); }
    thumbs.delete(p.id);
    ctx.changed();
    renderBrowserSelection();
  }

  // ------------------------------------------------------------------ browser
  const browser = el("div", { class: "look-browser" });
  const desc = el("p", { class: "muted" });
  const intensityOut = el("output");
  const intensity = el("input", { type: "range", min: "0", max: "1", step: "0.01" });
  intensity.oninput = () => { const p = ctx.params(); if (!p) return; p.profile.intensity = +intensity.value; intensityOut.textContent = String(Math.round(+intensity.value * 100)); commit(); };
  const refreshBtn = el("button", { class: "btn small", text: t("look.refresh") });
  refreshBtn.onclick = () => requestThumbs(true);

  function selectProfile(pr: LookProfile) {
    const p = ctx.params();
    if (!p) return;
    const keep = p.profile.intensity;
    p.profile = structuredClone(pr);
    if (pr.id !== "neutral" && keep > 0) p.profile.intensity = pr.intensity === 1 ? keep : pr.intensity;
    ctx.changed();
    renderBrowserSelection();
    renderEditor();
  }

  function card(pr: LookProfile) {
    const c = el("canvas", { class: "look-thumb" });
    const t = thumbs.get(pr.id);
    if (t) { c.width = t.width; c.height = t.height; c.getContext("2d", { colorSpace: "display-p3" } as CanvasRenderingContext2DSettings)!.putImageData(t, 0, 0); }
    const b = el("button", { class: "look-card", "data-id": pr.id }, c, el("span", { text: lookName(pr) }));
    b.onclick = () => selectProfile(pr);
    return b;
  }

  function renderBrowser() {
    const groups = new Map<string, LookProfile[]>();
    for (const p of all()) { const g = groups.get(p.category) ?? []; g.push(p); groups.set(p.category, g); }
    const order = [...CATEGORIES];
    browser.replaceChildren(...order.filter((c) => groups.has(c)).map((c) =>
      el("div", { class: "look-group" }, el("div", { class: "group-title", text: t(`cat.${c}`) }), el("div", { class: "look-row" }, ...groups.get(c)!.map(card)))));
    // No ready-made looks: say where the user's own come from.
    if (!custom.length) browser.append(el("p", { class: "muted", text: t("look.empty") }));
    renderBrowserSelection();
  }
  function renderBrowserSelection() {
    const p = cur();
    for (const b of browser.querySelectorAll<HTMLElement>(".look-card")) b.classList.toggle("on", b.dataset.id === p?.id);
    desc.textContent = p ? `${lookName(p)} — ${lookDesc(p)}` : "";
    if (p) { intensity.value = String(p.intensity); intensityOut.textContent = String(Math.round(p.intensity * 100)); }
  }

  function requestThumbs(force = false) {
    if (!ctx.params() || (!thumbsStale && !force)) return;
    thumbsStale = false;
    const long = Math.round(150 * Math.min(2, window.devicePixelRatio || 1));
    ctx.send({ type: "thumbs", profiles: all(), long });
  }

  // ------------------------------------------------------------------ palette
  const paletteBox = el("div", { class: "palette" });
  const paletteBtn = el("button", { class: "btn small", text: t("look.analysePalette") });
  paletteBtn.onclick = () => ctx.send({ type: "palette" });
  function swatches(list: Array<{ hex: string; weight: number }>, big = false) {
    return el("div", { class: "swatches" + (big ? " big" : "") }, ...list.map((s) => {
      const d = el("div", { class: "sw", title: `${s.hex} · ${(s.weight * 100).toFixed(0)}%` });
      d.style.background = s.hex;
      d.style.flexGrow = String(Math.max(0.05, s.weight));
      return d;
    }));
  }
  function renderPalette(s: ColorStats, into = paletteBox, title = t("look.thisPhoto")) {
    const hue = el("div", { class: "huebar" }, ...s.hueHist.map((v, i) => {
      const b = el("i");
      b.style.height = `${Math.round(Math.min(1, v * 6) * 100)}%`;
      b.style.background = `hsl(${(i * 10 + 5 + 20) % 360} 70% 55%)`;
      return b;
    }));
    const wc = s.warmCool;
    into.replaceChildren(
      el("div", { class: "group-title", text: title }),
      swatches(s.palette, true),
      el("div", { class: "kv" },
        el("dt", { text: t("look.shadows") }), el("dd", {}, swatches(s.zones.shadows.palette)),
        el("dt", { text: t("look.midtones") }), el("dd", {}, swatches(s.zones.midtones.palette)),
        el("dt", { text: t("look.highlights") }), el("dd", {}, swatches(s.zones.highlights.palette)),
        el("dt", { text: t("look.saturation") }), el("dd", { text: `mean C ${s.meanC.toFixed(3)} · p90 ${s.cQuantiles.p90.toFixed(3)}` }),
        el("dt", { text: t("look.warmCool") }), el("dd", { text: `${t(wc > 0.1 ? "look.warm" : wc < -0.1 ? "look.cool" : "look.balanced")} (${wc.toFixed(2)})` }),
      ),
      el("div", { class: "muted", text: t("look.hueDist") }), hue,
    );
  }

  // ------------------------------------------------------------------ reference
  const refInput = el("input", { type: "file", accept: "image/*,.heic,.jpg,.jpeg,.png,.webp", style: "display:none" });
  let refMode: "create" | "match" = "create";
  const matchAmount = el("input", { type: "range", min: "0.2", max: "1", step: "0.05", value: "0.7" });
  const refCreate = el("button", { class: "btn small", text: t("look.refCreate") });
  const refMatch = el("button", { class: "btn small", text: t("look.refMatch") });
  refCreate.onclick = () => { refMode = "create"; refInput.click(); };
  refMatch.onclick = () => { refMode = "match"; refInput.click(); };
  const refInfo = el("div");
  /** File of the last reference request (to translate the engine's result message). */
  let lastRefFile = "";
  refInput.onchange = () => {
    const f = refInput.files?.[0];
    refInput.value = "";
    if (!f) return;
    lastRefFile = f.name;
    ctx.progress(t(refMode === "create" ? "look.analysingRef" : "look.matchingRef"));
    ctx.send({ type: "reference", file: f, mode: refMode, amount: +matchAmount.value });
  };

  // ------------------------------------------------------------------ import / export
  const jsonInput = el("input", { type: "file", accept: ".json,application/json", style: "display:none" });
  const cubeInput = el("input", { type: "file", accept: ".cube", style: "display:none" });
  const importBtn = el("button", { class: "btn small", text: t("look.import") });
  const exportBtn = el("button", { class: "btn small", text: t("look.export") });
  const cubeBtn = el("button", { class: "btn small", text: t("look.importCube") });
  const deleteBtn = el("button", { class: "btn small", text: t("look.delete") });
  importBtn.onclick = () => jsonInput.click();
  cubeBtn.onclick = () => cubeInput.click();
  jsonInput.onchange = async () => {
    const f = jsonInput.files?.[0];
    jsonInput.value = "";
    if (!f) return;
    try {
      const pr = parseProfile(await f.text());
      if (isBuiltin(pr.id) || custom.some((c) => c.id === pr.id)) pr.id = pr.id + "-" + Date.now().toString(36);
      pr.category = pr.category === "neutral" ? "custom" : pr.category;
      custom.push(pr);
      saveCustom();
      renderBrowser();
      selectProfile(pr);
      thumbsStale = true;
      requestThumbs();
      if (pr.lut.id?.startsWith("cube:") && !lutSources.some((l) => l.id === pr.lut.id)) {
        desc.textContent = t("look.needsCube", { name: pr.name, file: pr.lut.file ?? pr.lut.id });
      }
    } catch (e) {
      desc.textContent = t("look.importFailed", { msg: (e as Error).message });
    }
  };
  cubeInput.onchange = async () => {
    const f = cubeInput.files?.[0];
    cubeInput.value = "";
    if (!f) return;
    const name = f.name.replace(/\.cube$/i, "");
    ctx.send({ type: "importLook", name, text: await f.text() });
    // Attach to the current profile (forking if it is built-in).
    const p = editable();
    if (p) { p.lut = { ...p.lut, id: "cube:" + name, file: f.name, strength: p.lut.id ? p.lut.strength : 1 }; commit(); renderEditor(); }
  };
  exportBtn.onclick = () => {
    const p = cur();
    if (!p) return;
    ctx.download(new Blob([serialize(p)], { type: "application/json" }), `${p.id}.json`);
  };
  const exportBtn2 = el("button", { class: "btn small", text: t("look.export") });
  exportBtn2.onclick = exportBtn.onclick;
  deleteBtn.onclick = () => {
    const p = cur();
    if (!p || isBuiltin(p.id)) return;
    custom = custom.filter((c) => c.id !== p.id);
    saveCustom();
    selectProfile(BUILTIN_PROFILES[0]); // back to Neutral
    renderBrowser();
  };

  // ------------------------------------------------------------------ editor
  const editor = el("div", { class: "look-editor" });
  const editToggle = el("button", { class: "btn small", text: t("look.edit") });
  editToggle.onclick = () => { editor.hidden = !editor.hidden; if (!editor.hidden) renderEditor(); };
  editor.hidden = true;

  function num(label: string, get: (p: LookProfile) => number, set: (p: LookProfile, v: number) => void, min: number, max: number, step: number, fmt = (v: number) => v.toFixed(2)) {
    const input = el("input", { type: "range", min: String(min), max: String(max), step: String(step) });
    const out = el("output");
    const p = cur();
    if (p) { input.value = String(get(p)); out.textContent = fmt(get(p)); }
    input.oninput = () => { const q = editable(); if (!q) return; set(q, +input.value); out.textContent = fmt(+input.value); commit(); };
    return el("div", { class: "row" }, el("label", { text: label }), input, out);
  }

  const curveEd = new CurveEditor(220);
  let curveChan: "master" | "r" | "g" | "b" = "master";
  curveEd.onChange = (pts) => {
    const q = editable();
    if (!q) return;
    if (curveChan === "master") q.tone.curve = pts; else q.rgbCurves[curveChan] = pts;
    commit();
  };
  const hueEd = new CurveEditor(260);
  let hueChan: "hue" | "sat" | "lum" | "satlum" = "hue";
  hueEd.onChange = (pts) => {
    const q = editable();
    if (!q) return;
    if (hueChan === "satlum") q.satByLum = pts; else q.hueCurves[hueChan] = pts;
    commit();
  };
  let hueRange: (typeof HUE_RANGES)[number] = "green";
  let semGroup: Group = "sky";
  let depthParam: keyof LookProfile["depth"] = "saturation";

  const pct = (v: number) => `${Math.round(v * 100)}%`;

  /** Colour balance shown as hue angle + amount, stored as RGB offsets. */
  function balanceRows(zone: "shadows" | "midtones" | "highlights") {
    const get = (p: LookProfile) => { const [a, b] = balanceToAB(p.colorBalance[zone]); return { h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360, m: Math.hypot(a, b) }; };
    const set = (p: LookProfile, h: number, m: number) => { p.colorBalance[zone] = abToBalance(m * Math.cos((h * Math.PI) / 180), m * Math.sin((h * Math.PI) / 180)) as RGB; };
    return [
      num(t(`ed.${zone}Hue`), (p) => get(p).h, (p, v) => set(p, v, get(p).m), 0, 359, 1, (v) => `${Math.round(v)}°`),
      num(t(`ed.${zone}Amount`), (p) => get(p).m, (p, v) => set(p, get(p).h, v), 0, 0.06, 0.001, (v) => (v * 1000).toFixed(0)),
    ];
  }

  /** Hue slider whose track is the app's (OkLab) rainbow. */
  function hueSlider(label: string, get: (p: LookProfile) => number, set: (p: LookProfile, v: number) => void) {
    const row = num(label, get, set, 0, 359, 1, (v) => `${Math.round(v)}°`);
    const input = row.querySelector("input") as HTMLInputElement;
    input.classList.add("rainbow");
    input.style.background = rainbowGradient();
    const sw = el("i", { class: "hue-dot" });
    const paint = () => (sw.style.background = hueColor(+input.value, 0.7, 0.15));
    paint();
    input.addEventListener("input", paint);
    row.querySelector("label")!.prepend(sw);
    return row;
  }

  function paletteRows(p: LookProfile): HTMLElement[] {
    const rows: HTMLElement[] = [];
    p.palette.anchors.forEach((_, i) => {
      rows.push(hueSlider(t("ed.anchor", { n: i + 1 }), (q) => q.palette.anchors[i]?.hue ?? 0, (q, v) => { if (q.palette.anchors[i]) q.palette.anchors[i].hue = v; }));
      rows.push(num(t("ed.anchorChroma"), (q) => q.palette.anchors[i]?.sat ?? 1, (q, v) => { if (q.palette.anchors[i]) q.palette.anchors[i].sat = v; }, 0, 2, 0.01));
      rows.push(num(t("ed.anchorWeight"), (q) => q.palette.anchors[i]?.weight ?? 1, (q, v) => { if (q.palette.anchors[i]) q.palette.anchors[i].weight = v; }, 0, 1, 0.01));
    });
    const add = el("button", { class: "btn small", text: t("ed.addAnchor") });
    add.disabled = p.palette.anchors.length >= MAX_ANCHORS;
    add.onclick = () => {
      const q = editable(); if (!q) return;
      const used = q.palette.anchors.map((x) => x.hue);
      q.palette.anchors.push({ hue: used.length ? (used[used.length - 1] + 150) % 360 : 60, sat: 1, weight: 1 });
      if (q.palette.pull === 0 && q.palette.focus === 0) { q.palette.pull = 0.5; q.palette.focus = 0.4; }
      commit(); renderEditor();
    };
    const remove = el("button", { class: "btn small", text: t("ed.removeLast") });
    remove.disabled = !p.palette.anchors.length;
    remove.onclick = () => { const q = editable(); if (!q) return; q.palette.anchors.pop(); commit(); renderEditor(); };
    const fromPhoto = el("button", { class: "btn small", text: t("ed.fromPhoto") });
    fromPhoto.onclick = () => {
      const st = lastPalette;
      if (!st) { ctx.send({ type: "palette" }); desc.textContent = t("ed.analysingPalette"); return; }
      const q = editable(); if (!q) return;
      // Dominant chromatic swatches become the anchors (greys carry no hue).
      const hues = st.palette.filter((sw) => Math.hypot(sw.lab[1], sw.lab[2]) > 0.035).slice(0, 3);
      q.palette.anchors = hues.map((sw) => ({ hue: Math.round(((Math.atan2(sw.lab[2], sw.lab[1]) * 180) / Math.PI + 360) % 360), sat: 1, weight: 1 }));
      if (q.palette.pull === 0) { q.palette.pull = 0.5; q.palette.focus = 0.4; }
      commit(); renderEditor();
    };
    rows.push(el("div", { class: "actions" }, add, remove, fromPhoto));
    rows.push(num(t("ed.pull"), (q) => q.palette.pull, (q, v) => (q.palette.pull = v), 0, 1, 0.01));
    rows.push(num(t("ed.fade"), (q) => q.palette.focus, (q, v) => (q.palette.focus = v), 0, 1, 0.01));
    rows.push(num(t("ed.anchorWidth"), (q) => q.palette.width, (q, v) => (q.palette.width = v), 10, 90, 1, (v) => `${Math.round(v)}°`));
    return rows;
  }

  function chips<T extends string>(items: readonly T[], active: T, pick: (v: T) => void, label: (v: T) => string = (v) => tOr(`chip.${v}`, v)) {
    return el("div", { class: "chips" }, ...items.map((it) => {
      const b = el("button", { class: "chip" + (it === active ? " on" : ""), text: label(it) });
      b.onclick = () => { pick(it); renderEditor(); };
      return b;
    }));
  }

  function renderEditor() {
    const p = cur();
    if (editor.hidden || !p) return;
    const curvePts = curveChan === "master" ? p.tone.curve : p.rgbCurves[curveChan];
    curveEd.set(curvePts, { master: "#ece9e3", r: "#ff6b6b", g: "#6bdc7a", b: "#6b9bff" }[curveChan]);
    hueEd.set(hueChan === "satlum" ? p.satByLum : p.hueCurves[hueChan], "#ffffff", hueChan === "satlum" ? "level" : "rainbow");
    const dc = (p.depth[depthParam] ?? [0, 0, 0]) as DepthCurve;
    const depthRange: Record<string, [number, number, number]> = { saturation: [-1, 1, 0.01], contrast: [-0.5, 0.5, 0.01], temperature: [-0.05, 0.05, 0.001], haze: [0, 0.6, 0.01], blackLevel: [-0.05, 0.15, 0.001] };
    const [dlo, dhi, dst] = depthRange[depthParam];
    const setDepth = (i: number) => (q: LookProfile, v: number) => { const arr = [...((q.depth[depthParam] ?? [0, 0, 0]) as number[])] as DepthCurve; arr[i] = v; q.depth[depthParam] = arr; };
    const lutSel = el("select", {}, el("option", { value: "", text: t("ed.noLut") }), ...lutSources.filter((l) => l.id !== "neutral").map((l) => el("option", { value: l.id, text: tOr(`lut.${l.id}`, l.name) })));
    lutSel.value = p.lut.id ?? "";
    lutSel.onchange = () => { const q = editable(); if (!q) return; q.lut.id = lutSel.value || null; commit(); };
    const sizeSel = el("select", {}, el("option", { value: "17", text: "17³" }), el("option", { value: "33", text: "33³" }), el("option", { value: "65", text: "65³" }));
    sizeSel.value = String(p.lut.size);
    sizeSel.onchange = () => { const q = editable(); if (!q) return; q.lut.size = +sizeSel.value as 17 | 33 | 65; commit(); };
    const nameIn = el("input", { type: "text", value: lookName(p), class: "text" });
    nameIn.onchange = () => { const q = editable(); if (!q) return; q.name = nameIn.value.slice(0, 64) || q.name; commit(); renderBrowser(); };
    const sg = p.semantic[semGroup];
    void sg;
    editor.replaceChildren(
      el("div", { class: "row" }, el("label", { text: t("ed.name") }), nameIn, el("span")),
      el("div", { class: "group-title", text: t("ed.lut") }),
      el("div", { class: "actions" }, lutSel, sizeSel),
      num(t("ed.lutStrength"), (q) => q.lut.strength, (q, v) => (q.lut.strength = v), 0, 1, 0.01),
      el("p", { class: "muted", text: t("ed.lutHint") }),
      el("div", { class: "group-title", text: t("ed.tone") }),
      num(t("ed.contrast"), (q) => q.tone.contrast, (q, v) => (q.tone.contrast = v), -0.5, 0.8, 0.01),
      num(t("ed.blackPoint"), (q) => q.tone.blackPoint, (q, v) => (q.tone.blackPoint = v), -0.05, 0.15, 0.001, (v) => (v * 100).toFixed(1)),
      num(t("ed.shadowLift"), (q) => q.tone.shadowLift, (q, v) => (q.tone.shadowLift = v), -0.2, 0.3, 0.01),
      num(t("ed.highlightComp"), (q) => q.tone.highlightCompression, (q, v) => (q.tone.highlightCompression = v), 0, 0.6, 0.01),
      num(t("ed.rolloff"), (q) => q.tone.rolloff, (q, v) => (q.tone.rolloff = v), 0, 1, 0.01),
      el("div", { class: "group-title", text: t("ed.curves") }),
      chips(["master", "r", "g", "b"] as const, curveChan, (v) => (curveChan = v)),
      el("div", { class: "curve-wrap" }, curveEd.el),
      el("p", { class: "muted", text: t("ed.curvesHint") }),
      el("div", { class: "group-title", text: t("ed.rainbow") }),
      chips(["hue", "sat", "lum", "satlum"] as const, hueChan, (v) => (hueChan = v)),
      el("div", { class: "curve-wrap" }, hueEd.el),
      el("p", { class: "muted", text: t(hueChan === "satlum" ? "ed.satLumHint" : "ed.rainbowHint") }),
      el("div", { class: "group-title", text: t("ed.hsl") }),
      chips(HUE_RANGES, hueRange, (v) => (hueRange = v)),
      num(t("ed.hue"), (q) => q.hsl[hueRange].hue, (q, v) => (q.hsl[hueRange].hue = v), -30, 30, 0.5, (v) => `${v.toFixed(1)}°`),
      num(t("ed.saturation"), (q) => q.hsl[hueRange].sat, (q, v) => (q.hsl[hueRange].sat = v), -1, 1, 0.01),
      num(t("ed.luminance"), (q) => q.hsl[hueRange].lum, (q, v) => (q.hsl[hueRange].lum = v), -0.5, 0.5, 0.01),
      el("div", { class: "group-title", text: t("ed.opponent") }),
      hueSlider(t("ed.oppAxis"), (q) => q.opponent.axis, (q, v) => (q.opponent.axis = v)),
      num(t("ed.oppAmount"), (q) => q.opponent.amount, (q, v) => (q.opponent.amount = v), -1, 1, 0.01),
      el("p", { class: "muted", text: t("ed.oppHint") }),
      el("div", { class: "group-title", text: t("ed.paletteTitle") }),
      el("p", { class: "muted", text: t("ed.paletteHint") }),
      ...paletteRows(p),
      el("div", { class: "group-title", text: t("ed.balance") }),
      ...balanceRows("shadows"), ...balanceRows("midtones"), ...balanceRows("highlights"),
      el("div", { class: "group-title", text: t("ed.satResponse") }),
      num(t("ed.global"), (q) => q.saturation.global, (q, v) => (q.saturation.global = v), 0, 2, 0.01),
      num(t("ed.shadows"), (q) => q.saturation.shadows, (q, v) => (q.saturation.shadows = v), 0, 2, 0.01),
      num(t("ed.highlights"), (q) => q.saturation.highlights, (q, v) => (q.saturation.highlights = v), 0, 2, 0.01),
      num(t("ed.weak"), (q) => q.saturation.lowBoost, (q, v) => (q.saturation.lowBoost = v), -0.5, 1, 0.01),
      num(t("ed.knee"), (q) => q.saturation.knee, (q, v) => (q.saturation.knee = v), 0.05, 0.4, 0.005, (v) => v.toFixed(3)),
      num(t("ed.compression"), (q) => q.saturation.compression, (q, v) => (q.saturation.compression = v), 0, 3, 0.05),
      el("div", { class: "group-title", text: t("ed.semantic") }),
      chips(GROUPS.filter((g) => g !== "other"), semGroup, (v) => (semGroup = v), (g) => t(`group.${g}`)),
      ...(["hue", "sat", "lum", "protect"] as const).map((k) => {
        const range: Record<string, [number, number, number]> = { hue: [-30, 30, 0.5], sat: [-1, 1, 0.01], lum: [-0.5, 0.5, 0.01], protect: [0, 1, 0.01] };
        const [lo, hi, st] = range[k];
        return num(t(({ hue: "ed.hue", sat: "ed.saturation", lum: "ed.luminance", protect: "ed.protect" } as const)[k]), (q) => q.semantic[semGroup]?.[k] ?? 0,
          (q, v) => { q.semantic[semGroup] = { hue: 0, sat: 0, lum: 0, protect: 0, ...q.semantic[semGroup], [k]: v }; }, lo, hi, st);
      }),
      el("div", { class: "group-title", text: t("ed.depth") }),
      chips(["saturation", "contrast", "temperature", "haze", "blackLevel"] as const, depthParam, (v) => (depthParam = v)),
      num(t("ed.near"), () => dc[0], setDepth(0), dlo, dhi, dst, (v) => v.toFixed(3)),
      num(t("ed.middle"), () => dc[1], setDepth(1), dlo, dhi, dst, (v) => v.toFixed(3)),
      num(t("ed.far"), () => dc[2], setDepth(2), dlo, dhi, dst, (v) => v.toFixed(3)),
      el("div", { class: "group-title", text: t("ed.spatial") }),
      ...(["skin", "sky", "foliage", "urban", "emissive"] as const).map((k) =>
        num(t(`ed.sp.${k}`), (q) => q.spatial.semantic[k], (q, v) => (q.spatial.semantic[k] = v), 0, 1, 0.01, pct)),
      ...(["foreground", "background", "distant", "backgroundCooling", "backgroundSaturation", "backgroundContrast"] as const).map((k) =>
        num(t(`ed.sp.${k}`), (q) => q.spatial.depth[k], (q, v) => (q.spatial.depth[k] = v), 0, 1, 0.01, pct)),
      el("div", { class: "actions" }, exportBtn, deleteBtn),
    );
  }

  // ------------------------------------------------------------------ layout
  root.replaceChildren(
    browser, desc,
    el("div", { class: "row" }, el("label", { text: t("look.intensity") }), intensity, intensityOut),
    el("div", { class: "actions" }, editToggle, refreshBtn),
    editor,
    el("div", { class: "group-title", text: t("look.reference") }),
    el("div", { class: "actions" }, refCreate, refMatch),
    el("div", { class: "row" }, el("label", { text: t("look.matchAmount") }), matchAmount, el("span")),
    el("p", { class: "muted", text: t("look.refHint") }),
    refInfo,
    el("div", { class: "group-title", text: t("look.palette") }),
    el("div", { class: "actions" }, paletteBtn),
    paletteBox,
    el("div", { class: "group-title", text: t("look.files") }),
    el("div", { class: "actions" }, importBtn, cubeBtn, exportBtn2),
    jsonInput, cubeInput, refInput,
  );
  renderBrowser();

  return {
    /** New photo / technical change: previews must be regenerated. */
    invalidate() { thumbs.clear(); thumbsStale = true; renderBrowser(); },
    requestThumbs,
    onThumbs(items: Array<{ id: string; width: number; height: number; data: ArrayBuffer }>) {
      for (const t of items) {
        try { thumbs.set(t.id, new ImageData(new Uint8ClampedArray(t.data), t.width, t.height, { colorSpace: "display-p3" })); }
        catch { thumbs.set(t.id, new ImageData(new Uint8ClampedArray(t.data), t.width, t.height)); }
      }
      renderBrowser();
    },
    onPalette(s: ColorStats) { lastPalette = s; renderPalette(s); },
    onProfile(pr: LookProfile, reference: ColorStats, message: string) {
      ctx.progress(undefined);
      custom.push(pr);
      saveCustom();
      renderBrowser();
      selectProfile(pr);
      renderPalette(reference, refInfo, t("look.reference"));
      // A new profile gets a translated note; a match shows the profile's own (generated) description.
      desc.textContent = message === `Profile built from ${lastRefFile}` ? t("look.refBuilt", { file: lastRefFile }) : message;
      thumbsStale = true;
      requestThumbs();
    },
    onLuts(list: Array<{ id: string; name: string }>) { lutSources = list; renderEditor(); },
    sync() { renderBrowserSelection(); renderEditor(); },
    /** Every look that can be chosen (built-in and saved), for the LLM prompt. */
    list() { return all().map((pr) => ({ id: pr.id, name: pr.name, description: pr.description ?? "" })); },
    /** Chooses a look by id, as a tap on its card would; false if there is none. */
    select(id: string) { const pr = all().find((q) => q.id === id); if (pr) selectProfile(pr); return !!pr; },
    get palette() { return lastPalette; },
  };
}
