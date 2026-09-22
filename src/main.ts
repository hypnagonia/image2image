/**
 * UI thread. Deliberately thin: it owns the DOM and a canvas, and forwards
 * everything else to the engine worker. No pixel processing happens here.
 */
import "./styles.css";
import type { Capabilities, ExportFormat, FromWorker, StageProfile, Summary, ToWorker } from "./engine/protocol.ts";
import type { Decision, Params } from "./decision/params.ts";
import { createLookPanel } from "./ui/lookPanel.ts";
import { createRegionsPanel } from "./ui/regionsPanel.ts";
import { normalizeProfile } from "./looks/profile.ts";
import { crashedWhileProcessing, lastStage, markCompleted, markInflight, noteStage, rememberParams, rememberPhoto, restorablePhoto } from "./ui/session.ts";
import { LANGS, LANG_NAMES, lang, setLang, storedLang, t, tOr, type Lang } from "./ui/i18n.ts";

const worker = new Worker(new URL("./engine/worker.ts", import.meta.url), { type: "module" });
const send = (m: ToWorker) => worker.postMessage(m);

// --------------------------------------------------------------------------- DOM helpers
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

const app = document.getElementById("app")!;
const header = el("header", { class: "top" }, el("h1", { text: "Shikarno" }));
const capsEl = el("div", { class: "caps", text: t("app.starting") });
header.append(capsEl);
// Language: "Auto" follows the browser; a pick is remembered on this device (the page reloads).
// A pill shows the active code; the invisible native select on top of it opens the full list.
const langSel = el("select", { "aria-label": t("app.language") },
  el("option", { value: "", text: t("lang.auto") }), ...LANGS.map((l) => el("option", { value: l, text: LANG_NAMES[l] })));
langSel.value = storedLang() ?? "";
langSel.onchange = () => setLang((langSel.value || undefined) as Lang | undefined);
header.append(el("label", { class: "btn small lang", title: t("app.language") }, lang.toUpperCase(), langSel));
const stage = el("div", { class: "stage" });
const canvas = el("canvas");
const badge = el("div", { class: "badge" });
const rings = el("div", { class: "rings" });
const progress = el("div", { class: "progress" }, el("div", { class: "t" }), el("div", { class: "bar indet" }, el("i")));
const fileInput = el("input", { type: "file", accept: ".dng,.DNG,.heic,.HEIC,.heif,.jpg,.jpeg,.png,image/*,image/x-adobe-dng", style: "display:none" });
const empty = el("div", { class: "empty" },
  el("h2", { text: t("empty.title") }),
  el("p", { text: t("empty.body") }),
  el("button", { class: "btn primary", id: "open-btn", text: t("empty.open") }),
  el("p", { class: "muted fine", text: t("empty.fine") }),
);
stage.append(empty, canvas, rings, badge, progress, fileInput);
canvas.style.display = "none";

const sheet = el("div", { class: "sheet" });
const tabs = el("div", { class: "tabs" });
sheet.append(tabs);
app.append(header, stage, sheet);

const panes: Record<string, HTMLElement> = {};
function addPane(id: string, label: string) {
  const b = el("button", { text: label });
  b.onclick = () => showPane(id);
  b.dataset.id = id;
  tabs.append(b);
  const p = el("div", { class: "pane" });
  p.hidden = true;
  sheet.append(p);
  panes[id] = p;
  return p;
}
function showPane(id: string) {
  if (id === "look") setTimeout(() => lookPanel.requestThumbs(), 0);
  // Deferred: the first call happens while the page is still being built.
  setTimeout(() => {
    regionsPanel.setVisible(id === "regions");
    if (id !== "depth" && zoneHighlight !== undefined) setZoneHighlight(undefined);
  }, 0);
  for (const [k, p] of Object.entries(panes)) p.hidden = k !== id;
  for (const b of tabs.querySelectorAll("button")) b.classList.toggle("on", (b as HTMLElement).dataset.id === id);
}
const autoPane = addPane("auto", t("tab.auto"));
const adjustPane = addPane("adjust", t("tab.adjust"));
const lookPane = addPane("look", t("tab.look"));
const regionsPane = addPane("regions", t("tab.regions"));
const depthPane = addPane("depth", t("tab.depth"));
const exportPane = addPane("export", t("tab.export"));
const debugPane = addPane("debug", t("tab.debug"));
showPane("auto");
autoPane.append(el("p", { class: "muted", text: t("auto.hint") }));

// --------------------------------------------------------------------------- state
let caps: Capabilities | undefined;
let params: Params | undefined;
let autoParams: Params | undefined;
let decisions: Decision[] = [];
let summary: Summary | undefined;
let profile: StageProfile[] = [];
const logLines: string[] = [];
let looks: Array<{ id: string; name: string; description: string }> = [];
let dofInfo: { justified: boolean; focus: number; strength: number; reason: string; x?: number; y?: number; zones?: Array<{ share: number; label: string; lo: number; hi: number }> } | undefined;
let focusMode = false;
let busy = false;

(document.getElementById("open-btn") as HTMLButtonElement).onclick = () => fileInput.click();
fileInput.onchange = () => { const f = fileInput.files?.[0]; if (f) openFile(f); fileInput.value = ""; };
const openBtn = el("button", { class: "btn small", text: t("app.open") });
openBtn.onclick = () => fileInput.click();
header.insertBefore(openBtn, capsEl);

// Fullscreen preview: only the photo (hold still compares with the camera rendering).
const fsBtn = el("button", { class: "btn small fs-btn", text: "⤢", title: t("app.fullscreen"), "aria-label": t("app.fullscreen") });
const fsExit = el("button", { class: "fs-exit", text: "✕", "aria-label": t("app.exitFullscreen") });
function setFullscreen(on: boolean) {
  document.body.classList.toggle("fs", on);
  // Real fullscreen where the platform allows it (not iPhone Safari; the CSS mode covers that).
  const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  try {
    if (on && !document.fullscreenElement) (root.requestFullscreen?.() ?? root.webkitRequestFullscreen?.())?.catch?.(() => {});
    if (!on && document.fullscreenElement) void document.exitFullscreen();
  } catch { /* unsupported */ }
  requestAnimationFrame(() => renderRings());
}
fsBtn.onclick = () => setFullscreen(true);
fsExit.onclick = (e) => { e.stopPropagation(); setFullscreen(false); };
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement) document.body.classList.remove("fs"); });
header.insertBefore(fsBtn, capsEl);
stage.append(fsExit);

let resolution: "auto" | "full" | "half" = "auto";
let exposureSuggestion = 0;
let autoExposure = (() => { try { return localStorage.getItem("autoExposure") === "1"; } catch { return false; } })();
let autoDof = (() => { try { return localStorage.getItem("autoDof") === "1"; } catch { return false; } })();
/** The page died while processing: don't retry automatically — offer a lighter reopen. */
function offerSafeReopen(file: File, saved?: Params) {
  const box = el("div", { class: "empty" },
    el("h2", { text: t("reopen.title") }),
    el("p", { text: t("reopen.body", { file: file.name }) }),
    el("p", { class: "muted", text: t("reopen.stopped", { stage: lastStage() ?? t("reopen.unknown") }) }),
  );
  const half = el("button", { class: "btn primary", text: t("reopen.half") });
  half.onclick = () => { box.remove(); resolution = "half"; resSel.value = "half"; openFile(file, saved); };
  const other = el("button", { class: "btn", text: t("reopen.other") });
  other.onclick = () => { box.remove(); empty.style.display = ""; fileInput.click(); };
  box.append(el("div", { class: "actions", style: "justify-content:center" }, half, other));
  empty.style.display = "none";
  stage.append(box);
}

/** Parameters to re-apply once a restored photo has been analysed. */
let pendingRestore: Params | undefined;

function openFile(f: File, restore?: Params) {
  pendingRestore = restore;
  if (!restore) void rememberPhoto(f);
  markInflight();
  empty.style.display = "none";
  canvas.style.display = "block";
  logLines.length = 0;
  setProgress(t("progress.opening", { file: f.name }));
  busy = true;
  send({ type: "open", file: f, resolution, autoExposure, autoDof });
}

// Drag & drop on desktop.
stage.addEventListener("dragover", (e) => e.preventDefault());
stage.addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) openFile(f); });

function setProgress(text: string | undefined, frac?: number) {
  progress.classList.toggle("on", !!text);
  if (!text) return;
  (progress.querySelector(".t") as HTMLElement).textContent = text;
  const bar = progress.querySelector(".bar") as HTMLElement;
  bar.classList.toggle("indet", frac === undefined);
  (bar.querySelector("i") as HTMLElement).style.width = frac === undefined ? "" : `${Math.round(frac * 100)}%`;
}

/** Worker progress (English stage ids + free-form detail) in the user's language; unknown text passes through. */
function stageText(stage: string, detail?: string): string {
  const ref = /^reference (.+)$/.exec(stage), dl = /^download (.+)$/.exec(stage);
  const name = ref ? t("stage.reference", { what: stageText(ref[1]) }) : dl ? t("stage.download", { what: dl[1] }) : tOr(`stage.${stage}`, stage);
  if (!detail) return name;
  let m: RegExpExecArray | null;
  const d = (m = /^tile (\d+)\/(\d+)$/.exec(detail)) ? t("detail.tile", { n: m[1], total: m[2] })
    : (m = /^rendering (\d+)%$/.exec(detail)) ? t("detail.rendering", { pct: m[1] })
    : (m = /^writing (\S+)$/.exec(detail)) ? t("detail.writing", { format: m[1] })
    : (m = /^encoding (\S+)$/.exec(detail)) ? t("detail.encoding", { format: m[1] })
    : tOr(`detail.${detail}`, detail);
  return `${name} — ${d}`;
}

// --------------------------------------------------------------------------- preview
const ctx = (() => {
  try { return canvas.getContext("2d", { colorSpace: "display-p3" }) as CanvasRenderingContext2D; } catch { return canvas.getContext("2d")!; }
})();
function drawPreview(m: Extract<FromWorker, { type: "preview" }>) {
  if (canvas.width !== m.width || canvas.height !== m.height) { canvas.width = m.width; canvas.height = m.height; }
  let img: ImageData;
  try { img = new ImageData(new Uint8ClampedArray(m.data), m.width, m.height, { colorSpace: "display-p3" }); }
  catch { img = new ImageData(new Uint8ClampedArray(m.data), m.width, m.height); }
  ctx.putImageData(img, 0, 0);
  renderRings();
}

/** On-screen rectangle of the photo inside the letterboxed canvas (object-fit: contain). */
function imageRect() {
  const c = canvas.getBoundingClientRect();
  const k = Math.min(c.width / (canvas.width || 1), c.height / (canvas.height || 1));
  const w = canvas.width * k, h = canvas.height * k;
  return { left: c.left + (c.width - w) / 2, top: c.top + (c.height - h) / 2, width: w, height: h };
}

/** One ring per focus point; numbered so several subjects can be told apart. */
function renderRings() {
  // Rings are an editing aid: only shown while picking focus points.
  let pts: Array<{ x: number; y: number }> = focusMode && params?.enable.dof ? params.dof.points : [];
  const showAuto = focusMode && params?.enable.dof && !pts.length && dofInfo?.x !== undefined;
  if (showAuto) pts = [{ x: dofInfo!.x!, y: dofInfo!.y! }];
  const r = imageRect(), st = stage.getBoundingClientRect();
  rings.replaceChildren(...pts.map((p, i) => {
    const d = el("div", { class: "focus-ring" + (showAuto ? " auto" : ""), text: showAuto ? t("view.ringAuto") : String(i + 1) });
    d.style.left = `${r.left - st.left + p.x * r.width}px`;
    d.style.top = `${r.top - st.top + p.y * r.height}px`;
    return d;
  }));
}
window.addEventListener("resize", renderRings);

// Press and hold: before (camera rendering). Tap in focus mode: add/remove a focus point.
let holdTimer = 0;
let holding = false;
stage.addEventListener("pointerdown", (e) => {
  if (!params || e.target !== canvas) return;
  if (focusMode) {
    const r = imageRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    if (x < 0 || y < 0 || x > 1 || y > 1) return;
    send({ type: "focus", action: "toggle", x, y });
    return;
  }
  holdTimer = window.setTimeout(() => { holding = true; badge.textContent = t("view.before"); badge.classList.add("on"); send({ type: "view", view: currentView, before: true }); }, 180);
});
const endHold = () => {
  clearTimeout(holdTimer);
  if (holding) { holding = false; badge.classList.remove("on"); send({ type: "view", view: currentView, before: false }); }
};
stage.addEventListener("pointerup", endHold);
stage.addEventListener("pointercancel", endHold);
stage.addEventListener("pointerleave", endHold);
let currentView: 0 | 1 | 2 = 0;

// --------------------------------------------------------------------------- params plumbing
let pushTimer = 0;
// While a slider is held, previews render at a quarter of the pixels (drafts);
// releasing it renders the full preview once.
let dragging = false;
document.addEventListener("pointerdown", (e) => { if ((e.target as HTMLElement).matches?.('input[type="range"], .curve-editor')) dragging = true; }, true);
const endDrag = () => { if (!dragging) return; dragging = false; pushParams(); };
document.addEventListener("pointerup", endDrag, true);
document.addEventListener("pointercancel", endDrag, true);

function pushParams() {
  if (!params) return;
  clearTimeout(pushTimer);
  const draft = dragging;
  pushTimer = window.setTimeout(() => send({ type: "params", params: structuredClone(params!), draft }), draft ? 0 : 16);
  rememberParams(params);
}
function getPath(o: unknown, path: string): number {
  return path.split(".").reduce((a: unknown, k) => (a as Record<string, unknown>)[k], o) as number;
}
function setPath(o: unknown, path: string, v: unknown) {
  const ks = path.split(".");
  const last = ks.pop()!;
  const t = ks.reduce((a: unknown, k) => (a as Record<string, unknown>)[k], o) as Record<string, unknown>;
  t[last] = v;
}

interface SliderDef { path: string; label: string; min: number; max: number; step: number; fmt?: (v: number) => string }
const sliders: Array<{ def: SliderDef; input: HTMLInputElement; out: HTMLOutputElement }> = [];
function slider(def: SliderDef): HTMLElement {
  const input = el("input", { type: "range", min: String(def.min), max: String(def.max), step: String(def.step) });
  const out = el("output");
  const row = el("div", { class: "row" }, el("label", { text: def.label }), input, out);
  input.oninput = () => {
    if (!params) return;
    setPath(params, def.path, parseFloat(input.value));
    if (!def.path.startsWith("profile.")) lookPanel.invalidate();
    refreshSlider(sliders.find((s) => s.input === input)!);
    pushParams();
  };
  // Double-tap the label: back to the automatic value.
  row.querySelector("label")!.addEventListener("dblclick", () => {
    if (!params || !autoParams) return;
    setPath(params, def.path, getPath(autoParams, def.path));
    syncControls();
    pushParams();
  });
  sliders.push({ def, input, out });
  return row;
}
function refreshSlider(s: { def: SliderDef; input: HTMLInputElement; out: HTMLOutputElement }) {
  if (!params) return;
  const v = getPath(params, s.def.path);
  s.input.value = String(v);
  s.out.textContent = s.def.fmt ? s.def.fmt(v) : v.toFixed(s.def.step < 0.1 ? 2 : s.def.step < 1 ? 1 : 0);
  const a = autoParams ? getPath(autoParams, s.def.path) : undefined;
  s.out.classList.toggle("auto", a !== undefined && Math.abs(a - v) < 1e-6);
}
const pct = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}`;

const aeToggle = el("input", { type: "checkbox" });
aeToggle.checked = autoExposure;
const aeNote = el("span", { class: "muted" });
aeToggle.onchange = () => {
  autoExposure = aeToggle.checked;
  try { localStorage.setItem("autoExposure", autoExposure ? "1" : "0"); } catch { /* private mode */ }
  if (params) { params.exposure = autoExposure ? exposureSuggestion : 0; if (autoParams) autoParams.exposure = params.exposure; syncControls(); pushParams(); }
};
adjustPane.append(
  el("div", { class: "group-title", text: t("adj.light") }),
  el("label", { class: "toggle" }, el("span", {}, t("adj.autoExposure") + " ", aeNote), aeToggle),
  slider({ path: "exposure", label: t("adj.exposure"), min: -3, max: 3, step: 0.05, fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}` }),
  slider({ path: "tone.highlights", label: t("adj.highlights"), min: -1, max: 1, step: 0.01, fmt: pct }),
  slider({ path: "tone.shadows", label: t("adj.shadows"), min: -1, max: 1, step: 0.01, fmt: pct }),
  slider({ path: "tone.whites", label: t("adj.whites"), min: -1, max: 1, step: 0.01, fmt: pct }),
  slider({ path: "tone.blacks", label: t("adj.blacks"), min: -1, max: 1, step: 0.01, fmt: pct }),
  slider({ path: "tone.contrast", label: t("adj.contrast"), min: -1, max: 1, step: 0.01, fmt: pct }),
  slider({ path: "tone.rolloff", label: t("adj.rolloff"), min: 0, max: 1, step: 0.01, fmt: pct }),
  el("div", { class: "group-title", text: t("adj.wb") }),
  slider({ path: "wb.temp", label: t("adj.temp"), min: 2000, max: 12000, step: 10, fmt: (v) => `${Math.round(v)}K` }),
  slider({ path: "wb.tint", label: t("adj.tint"), min: -60, max: 60, step: 0.5 }),
  el("div", { class: "group-title", text: t("adj.local") }),
  slider({ path: "local.compression", label: t("adj.range"), min: 0, max: 0.8, step: 0.01, fmt: pct }),
  slider({ path: "local.clarity", label: t("adj.clarity"), min: -0.5, max: 1, step: 0.01, fmt: pct }),
  slider({ path: "local.texture", label: t("adj.texture"), min: -0.5, max: 1, step: 0.01, fmt: pct }),
  slider({ path: "dehaze.strength", label: t("adj.dehaze"), min: 0, max: 1, step: 0.01, fmt: pct }),
  el("div", { class: "group-title", text: t("adj.colour") }),
  slider({ path: "color.vibrance", label: t("adj.vibrance"), min: -1, max: 1, step: 0.01, fmt: pct }),
  slider({ path: "color.saturation", label: t("adj.saturation"), min: -1, max: 1, step: 0.01, fmt: pct }),
  el("div", { class: "group-title", text: t("adj.detail") }),
  slider({ path: "denoise.luma", label: t("adj.noiseLuma"), min: 0, max: 1, step: 0.01, fmt: pct }),
  slider({ path: "denoise.chroma", label: t("adj.noiseColour"), min: 0, max: 1, step: 0.01, fmt: pct }),
  slider({ path: "sharpen.amount", label: t("adj.sharpen"), min: 0, max: 1.5, step: 0.01, fmt: pct }),
  slider({ path: "sharpen.radius", label: t("adj.radius"), min: 0.5, max: 2.5, step: 0.05 }),
  el("div", { class: "group-title", text: t("adj.depth") }),
  slider({ path: "depth.near", label: t("adj.nearDetail"), min: 0.5, max: 1.5, step: 0.01 }),
  slider({ path: "depth.far", label: t("adj.farDetail"), min: 0.2, max: 1.5, step: 0.01 }),
);
const dnBtn = el("button", { class: "btn small", text: t("adj.scunet") });
dnBtn.onclick = () => { if (params) { markInflight(); setProgress(stageText("denoise (SCUNet)")); send({ type: "restore", scunet: true, nafnet: false }); } };
const isPhone = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
if (isPhone) dnBtn.style.display = "none"; // SCUNet is too heavy for phone memory
const rsBtn = el("button", { class: "btn small", text: t("adj.nafnet") });
rsBtn.onclick = () => { if (params) { markInflight(); setProgress(stageText("restore (NAFNet)")); send({ type: "restore", scunet: false, nafnet: true }); } };
const resetBtn = el("button", { class: "btn small", text: t("adj.reset") });
resetBtn.onclick = () => { if (autoParams) { params = structuredClone(autoParams); syncControls(); pushParams(); } };
adjustPane.append(el("div", { class: "actions" }, dnBtn, rsBtn), el("p", { class: "muted", text: t("adj.networksHint") }), el("div", { class: "actions" }, resetBtn), el("p", { class: "muted", text: t("adj.amberHint") }));

// Look profiles: browser, palette, reference, editor (src/ui/lookPanel.ts)
const lookPanel = createLookPanel(lookPane, {
  send,
  params: () => params,
  changed: () => { syncControls(); pushParams(); },
  download,
  progress: (t) => setProgress(t),
});
function renderLooks() { lookPanel.sync(); }

// Regions: per-segment controls (src/ui/regionsPanel.ts)
const regionsPanel = createRegionsPanel(regionsPane, {
  params: () => params,
  auto: () => autoParams,
  coverage: () => summary?.coverage,
  changed: () => { lookPanel.invalidate(); pushParams(); },
  highlight: (i) => send(i === undefined ? { type: "view", view: currentView } : { type: "view", view: 4, region: i }),
});

// Depth / DoF
const dofToggle = el("input", { type: "checkbox" });
dofToggle.onchange = () => {
  if (!params) return;
  params.enable.dof = dofToggle.checked;
  if (params.dof.strength <= 0) params.dof.strength = 0.5;
  // With no focus points, focus follows the automatic subject.
  if (dofToggle.checked && !params.dof.points.length && dofInfo) params.dof.focus = dofInfo.focus;
  syncControls();
  pushParams();
};
const autoDofToggle = el("input", { type: "checkbox" });
autoDofToggle.checked = autoDof;
autoDofToggle.onchange = () => {
  autoDof = autoDofToggle.checked;
  try { localStorage.setItem("autoDof", autoDof ? "1" : "0"); } catch { /* private mode */ }
  // Apply to the current photo right away when the scene justifies it.
  if (params && dofInfo) {
    if (autoDof && dofInfo.justified) { params.enable.dof = true; params.dof.focus = dofInfo.focus; if (params.dof.strength <= 0) params.dof.strength = 0.5; }
    else if (!autoDof && !params.dof.points.length) params.enable.dof = false;
    syncControls();
    pushParams();
  }
};
const focusBtn = el("button", { class: "btn small", text: t("dof.pick") });
focusBtn.onclick = () => { focusMode = !focusMode; focusBtn.classList.toggle("primary", focusMode); badge.textContent = focusMode ? t("dof.pickBadge") : ""; badge.classList.toggle("on", focusMode); renderRings(); };
const autoFocusBtn = el("button", { class: "btn small", text: t("dof.automatic") });
autoFocusBtn.onclick = () => {
  if (!params) return;
  // Back to the automatic subject: drop focus points and send the focus with the parameters.
  params.dof.points = [];
  if (dofInfo) params.dof.focus = dofInfo.focus;
  syncControls();
  pushParams();
  renderRings();
};
const dofReason = el("p", { class: "muted" });
depthPane.append(
  el("label", { class: "toggle" }, t("dof.autoToggle"), autoDofToggle),
  el("label", { class: "toggle" }, t("dof.toggle"), dofToggle),
  slider({ path: "dof.strength", label: t("dof.blur"), min: 0, max: 1, step: 0.01, fmt: pct }),
  slider({ path: "dof.focus", label: t("dof.autoFocus"), min: 0, max: 1, step: 0.005 }),
  el("p", { class: "muted", text: t("dof.pointsHint") }),
  el("div", { class: "actions" }, focusBtn, autoFocusBtn),
  dofReason,
  el("div", { class: "group-title", text: t("dof.inspect") }),
);
// ---- Depth zones: blur set by hand for each part of the depth range --------
const ZONE_NAMES = [t("zone.0"), t("zone.1"), t("zone.2"), t("zone.3"), t("zone.4")];
const zoneToggle = el("input", { type: "checkbox" });
const zoneRows = el("div");
let zoneHighlight: number | undefined;
function setZoneHighlight(i: number | undefined) {
  zoneHighlight = i;
  send(i === undefined ? { type: "view", view: currentView } : { type: "view", view: 5, region: i });
  renderZones();
}
zoneToggle.onchange = () => {
  if (!params) return;
  params.dof.mode = zoneToggle.checked ? "zones" : "focus";
  if (zoneToggle.checked) {
    params.enable.dof = true;
    if (params.dof.strength <= 0) params.dof.strength = 0.5;
    if (!params.dof.zones && autoParams?.dof.zones) { params.dof.zones = [...autoParams.dof.zones]; params.dof.zoneBounds = [...(autoParams.dof.zoneBounds ?? [])]; }
  }
  syncControls();
  pushParams();
};
function renderZones() {
  if (!params?.dof.zones) { zoneRows.replaceChildren(el("p", { class: "muted", text: t("dof.zonesEmpty") })); return; }
  zoneToggle.checked = params.dof.mode === "zones";
  const on = params.dof.mode === "zones";
  zoneRows.replaceChildren(...ZONE_NAMES.map((name, i) => {
    const input = el("input", { type: "range", min: "0", max: "1", step: "0.01" });
    input.value = String(params!.dof.zones![i] ?? 0);
    input.disabled = !on;
    const out = el("output", { text: String(Math.round(+input.value * 100)) });
    input.oninput = () => {
      if (!params?.dof.zones) return;
      params.dof.zones[i] = +input.value;
      out.textContent = String(Math.round(+input.value * 100));
      pushParams();
    };
    const eye = el("button", { class: "chip eye" + (zoneHighlight === i ? " on" : ""), text: "◉", title: t("dof.showZone", { zone: name.toLowerCase() }), "aria-label": t("dof.showZone", { zone: name.toLowerCase() }) });
    eye.onclick = () => setZoneHighlight(zoneHighlight === i ? undefined : i);
    const z = dofInfo?.zones?.[i];
    const info = z ? el("span", { class: "zone-info", text: `${Math.round(z.share * 100)}%${z.label ? " · " + tOr(`group.${z.label}`, z.label).toLowerCase() : ""}` }) : "";
    return el("div", { class: "row zone-row" }, el("label", {}, eye, el("span", {}, ` ${name}`, info)), input, out);
  }));
}
const viewChips = el("div", { class: "chips" });
([[t("dof.viewPhoto"), 0], [t("dof.viewRegions"), 1], [t("dof.viewDepth"), 2]] as const).forEach(([name, v]) => {
  const b = el("button", { class: "chip" + (v === 0 ? " on" : ""), text: name });
  b.onclick = () => { currentView = v; for (const c of viewChips.children) c.classList.toggle("on", c === b); send({ type: "view", view: v }); };
  viewChips.append(b);
});
depthPane.append(viewChips, el("p", { class: "muted", text: t("dof.legend") }));
depthPane.append(
  el("div", { class: "group-title", text: t("dof.zones") }),
  el("label", { class: "toggle" }, t("dof.zonesToggle"), zoneToggle),
  el("p", { class: "muted", text: t("dof.zonesHint") }),
  zoneRows,
);

// Export
const fmtSel = el("select", {}, el("option", { value: "jpeg", text: "JPEG" }), el("option", { value: "heic", text: "HEIC" }), el("option", { value: "tiff16", text: t("exp.tiff") }), el("option", { value: "dng", text: t("exp.dng") }));
const spaceSel = el("select", {}, el("option", { value: "p3", text: "Display P3" }), el("option", { value: "srgb", text: "sRGB" }));
const qualitySl = el("input", { type: "range", min: "0.6", max: "1", step: "0.01", value: "0.92" });
const qualityOut = el("output", { text: "92" });
qualitySl.oninput = () => (qualityOut.textContent = String(Math.round(+qualitySl.value * 100)));
const exportBtn = el("button", { class: "btn primary", text: t("exp.button") });
const exportInfo = el("p", { class: "muted" });
exportBtn.onclick = () => {
  if (!params || busy) return;
  busy = true;
  exportBtn.disabled = true;
  setProgress(t("progress.exporting"));
  // ?strip=N overrides the export strip height (memory vs speed; testing).
  const stripRows = Number(new URLSearchParams(location.search).get("strip")) || undefined;
  send({ type: "export", format: fmtSel.value as ExportFormat, quality: +qualitySl.value, space: spaceSel.value as "srgb" | "p3", stripRows });
};
const resSel = el("select", {}, el("option", { value: "auto", text: t("exp.resAuto") }), el("option", { value: "full", text: t("exp.resFull") }), el("option", { value: "half", text: t("exp.resHalf") }));
resSel.onchange = () => (resolution = resSel.value as typeof resolution);
exportPane.append(
  el("div", { class: "row" }, el("label", { text: t("exp.format") }), fmtSel, el("span")),
  el("div", { class: "row" }, el("label", { text: t("exp.colour") }), spaceSel, el("span")),
  el("div", { class: "row" }, el("label", { text: t("exp.quality") }), qualitySl, qualityOut),
  el("div", { class: "actions" }, exportBtn),
  exportInfo,
  el("div", { class: "group-title", text: t("exp.next") }),
  resSel,
  el("p", { class: "muted", text: t("exp.hint") }),
);
fmtSel.onchange = () => {
  const f = fmtSel.value;
  qualitySl.disabled = !(f === "jpeg" || f === "heic");
  spaceSel.disabled = f === "tiff16" || f === "dng";
};

// Debug
const stageToggles = el("div");
const profTable = el("table", { class: "prof" });
const logPre = el("pre", { class: "log" });
const dlReport = el("button", { class: "btn small", text: t("dbg.download") });
debugPane.append(el("div", { class: "group-title", text: t("dbg.stages") }), stageToggles, el("div", { class: "group-title", text: t("dbg.profile") }), profTable, el("div", { class: "group-title", text: t("dbg.log") }), logPre, el("div", { class: "actions" }, dlReport));
const STAGES: Array<[keyof Params["enable"], string]> = [
  ["denoise", t("dbg.denoise")], ["wb", t("dbg.wb")], ["exposure", t("dbg.exposure")], ["localTone", t("dbg.localTone")],
  ["curves", t("dbg.curves")], ["lut", t("dbg.lut")], ["semantic", t("dbg.semantic")], ["dehaze", t("dbg.dehaze")], ["sharpen", t("dbg.sharpen")],
];
function renderStageToggles() {
  stageToggles.replaceChildren(...STAGES.map(([k, name]) => {
    const cb = el("input", { type: "checkbox" });
    cb.checked = !!params?.enable[k];
    cb.onchange = () => { if (!params) return; params.enable[k] = cb.checked; pushParams(); };
    return el("label", { class: "toggle" }, name, cb);
  }));
}
dlReport.onclick = () => {
  const blob = new Blob([JSON.stringify({ summary, decisions, auto: autoParams, params, profile, log: logLines }, null, 2)], { type: "application/json" });
  download(blob, (summary?.file ?? "photo").replace(/\.[^.]+$/, "") + "-analysis.json");
};

function renderProfile() {
  profTable.replaceChildren(
    el("tr", {}, el("th", { text: "stage" }), el("th", { text: "ms" }), el("th", { text: "GPU MB" }), el("th", { text: "peak" })),
    ...profile.flatMap((p) => {
      const rows = [el("tr", {}, el("td", { text: p.stage }), el("td", { text: String(p.ms) }), el("td", { text: String(p.gpuLiveMB) }), el("td", { text: String(p.gpuPeakMB) }))];
      if (p.note) rows.push(el("tr", {}, el("td", { class: "note", colspan: "4", text: p.note })));
      return rows;
    }),
  );
}

function renderAuto() {
  const s = summary;
  const kv = el("dl", { class: "kv" });
  if (s) {
    const add = (k: string, v: string | number) => kv.append(el("dt", { text: k }), el("dd", { text: String(v) }));
    add(t("auto.source"), s.source);
    add(t("auto.size"), `${s.width}×${s.height}` + (s.working.factor > 1 ? ` (${t("auto.working", { w: s.working.width, h: s.working.height })})` : ""));
    for (const [k, v] of Object.entries(s.meta)) add(k, v);
    add(t("auto.regions"), Object.entries(s.coverage).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${tOr(`group.${k}`, k).toLowerCase()} ${v}%`).join(", "));
  }
  const list = el("div", { class: "decisions" }, ...decisions.map((d) => {
    const v = Array.isArray(d.value) ? d.value.join(" / ") : String(d.value);
    const card = el("div", { class: "decision" },
      el("div", { class: "h" }, el("span", { text: d.id }), el("span", { text: v.length > 60 ? "…" : v })),
      el("div", { class: "r", text: d.reason }));
    if (Object.keys(d.inputs).length) card.append(el("details", {}, el("summary", { text: t("auto.inputs") }), el("code", { text: JSON.stringify(d.inputs) })));
    return card;
  }));
  autoPane.replaceChildren(kv, el("div", { class: "group-title", text: t("auto.decisions") }), list);
}

function syncControls() {
  sliders.forEach(refreshSlider);
  renderLooks();
  renderStageToggles();
  if (params) { dofToggle.checked = params.enable.dof; }
  renderRings();
  renderZones();
}

function download(blob: Blob, name: string) {
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
}

async function share(blob: Blob, name: string) {
  // iOS: the share sheet lets the user save to Photos; fall back to a download.
  const file = new File([blob], name, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] }) && /iPhone|iPad/.test(navigator.userAgent)) {
    try { await navigator.share({ files: [file] }); return; } catch { /* cancelled */ }
  }
  download(blob, name);
}

/** Persistent, visible error notice (GPU problems would otherwise just render black). */
const errorBox = el("div", { class: "error-box" });
errorBox.hidden = true;
stage.append(errorBox);
function showError(text: string) {
  errorBox.hidden = false;
  errorBox.replaceChildren(
    el("strong", { text: t("err.gpu") }),
    el("div", { text: text.slice(0, 600) }),
    el("div", { class: "muted", text: t("err.seeLog") }),
  );
  const close = el("button", { class: "btn small", text: t("err.dismiss") });
  close.onclick = () => (errorBox.hidden = true);
  errorBox.append(close);
}

// --------------------------------------------------------------------------- worker messages
worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case "ready":
      caps = m.caps;
      looks = m.looks;
      lookPanel.onLuts(looks);
      capsEl.textContent = `${caps.backend === "webgpu" ? "WebGPU" : "WASM"}${caps.f16 ? " · fp16" : ""}${caps.crossOriginIsolated ? ` · ${t("app.threads", { n: caps.threads })}` : ""}`;
      if (!caps.heicEncode) (fmtSel.querySelector('option[value="heic"]') as HTMLOptionElement).disabled = true;
      renderLooks();
      // After Safari evicted this tab (memory) or the GPU was reset: reopen where we were —
      // unless that very photo was being processed when the page died (would loop forever).
      void restorablePhoto().then((r) => {
        if (!r || params) return;
        if (crashedWhileProcessing()) {
          markCompleted();
          offerSafeReopen(r.file, r.params);
          return;
        }
        logLines.push(`restoring ${r.file.name} after a reload of this tab`);
        openFile(r.file, r.params);
      });
      break;
    case "gpu-lost":
      // A lost GPU device cannot be revived in place; restart the page — the session restores itself.
      setProgress(t("progress.gpuReset"));
      setTimeout(() => location.reload(), 600);
      break;
    case "progress":
      setProgress(stageText(m.stage, m.detail), m.frac);
      noteStage(stageText(m.stage, m.detail));
      break;
    case "preview":
      drawPreview(m);
      if (m.final && !holding) setProgress(undefined);
      if (m.final) markCompleted();
      if (m.final && !panes.look.hidden) lookPanel.requestThumbs();
      busy = false;
      break;
    case "analysis":
      summary = m.summary; decisions = m.decisions; autoParams = m.auto; params = m.params; dofInfo = m.dof;
      exposureSuggestion = m.exposureSuggestion;
      aeNote.textContent = exposureSuggestion ? t("adj.suggests", { ev: `${exposureSuggestion > 0 ? "+" : ""}${exposureSuggestion.toFixed(2)}` }) : t("adj.noCorrection");
      // The reason itself comes from the decision engine and stays in English.
      dofReason.textContent = t("dof.reason", { d: m.dof.focus.toFixed(2) }) + (m.dof.justified ? t("dof.suggested") : t("dof.notSuggested")) + m.dof.reason;
      syncControls();
      renderAuto();
      lookPanel.invalidate();
      regionsPanel.render();
      if (pendingRestore) {
        // Same photo, same analysis: bring back the edits made before the reload.
        params = { ...params!, ...pendingRestore, enable: { ...params!.enable, ...pendingRestore.enable } };
        params.profile = normalizeProfile(params.profile);
        // Zones are recomputed for this photo; keep the user's blur values only if they fit.
        if (!params.dof.zones || params.dof.zones.length !== 5) params.dof = { ...params.dof, zones: autoParams!.dof.zones, mode: params.dof.mode ?? "focus" };
        params.dof.zoneBounds = autoParams!.dof.zoneBounds;
        // Regions saved by older versions lack newer fields: fill from today's automatic values.
        for (const g of Object.keys(params.semantic) as Array<keyof Params["semantic"]>) params.semantic[g] = { ...autoParams!.semantic[g], ...params.semantic[g] };
        pendingRestore = undefined;
        syncControls();
        pushParams();
      }
      break;
    case "params":
      params = m.params;
      syncControls();
      break;
    case "log":
      logLines.push(m.text);
      logPre.textContent = logLines.join("\n");
      if (m.text.startsWith("GPU error")) showError(m.text);
      break;
    case "profile":
      profile = m.stages;
      { const l = m.stages[m.stages.length - 1]; if (l) noteStage(`after “${l.stage}” (GPU ${l.gpuLiveMB} MB, peak ${l.gpuPeakMB} MB)`); }
      renderProfile();
      break;
    case "exported":
      busy = false;
      exportBtn.disabled = false;
      setProgress(undefined);
      exportInfo.textContent = t("exp.done", { file: m.name, mb: (m.blob.size / 1e6).toFixed(1), s: (m.ms / 1000).toFixed(1) });
      void share(m.blob, m.name);
      break;
    case "looks":
      looks = m.looks;
      lookPanel.onLuts(looks);
      break;
    case "thumbs":
      lookPanel.onThumbs(m.items);
      break;
    case "palette":
      lookPanel.onPalette(m.stats);
      break;
    case "lookProfile":
      lookPanel.onProfile(m.profile, m.reference, m.message);
      break;
    case "error":
      showError(m.message);
      busy = false;
      exportBtn.disabled = false;
      setProgress(undefined);
      logLines.push("ERROR: " + m.message);
      logPre.textContent = logLines.join("\n");
      capsEl.innerHTML = "";
      capsEl.append(el("span", { class: "error", text: m.message.slice(0, 140) }));
      if (!params) { empty.style.display = ""; canvas.style.display = "none"; (empty.querySelector("p") as HTMLElement).textContent = m.message; }
      break;
  }
};
worker.onerror = (e) => { capsEl.textContent = t("err.worker", { msg: e.message }); };

const long = Math.max(window.innerWidth, window.innerHeight) * Math.min(2, window.devicePixelRatio || 1);
send({ type: "preview-size", long });
send({ type: "init", base: import.meta.env.BASE_URL });
fmtSel.onchange?.(new Event("change"));
