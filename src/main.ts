/**
 * UI thread. Deliberately thin: it owns the DOM and a canvas, and forwards
 * everything else to the engine worker. No pixel processing happens here.
 */
import "./styles.css";
import type { Capabilities, ExportFormat, FromWorker, StageProfile, Summary, ToWorker, UpscaleInfo, UpscaleMode } from "./engine/protocol.ts";
import { DEPTH_BANDS, type Decision, type DepthBand, type Params } from "./decision/params.ts";
import { createLookPanel } from "./ui/lookPanel.ts";
import { createRegionsPanel } from "./ui/regionsPanel.ts";
import { createLlmPanel } from "./ui/llmPanel.ts";
import { normalizeProfile } from "./looks/profile.ts";
import { createToneCurves } from "./ui/toneCurves.ts";
import { histogramOf } from "./analysis/previewHist.ts";
import { applyAutoCurves, type AutoCurveBands } from "./decision/autoCurves.ts";
import { isFlat } from "./render/curves.ts";
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
  if (id === "llm") setTimeout(() => llmPanel.refresh(), 0);
  // Deferred: the first call happens while the page is still being built.
  setTimeout(() => {
    regionsPanel.setVisible(id === "regions");
    if (id !== "depth" && zoneHighlight !== undefined) setZoneHighlight(undefined);
    if (id !== "depth" && bandShown) setBandShown(false);
    // Picking focus points belongs to the Depth tab: leaving it ends the mode
    // (taps on the photo go back to hold-to-compare and double-tap zoom).
    if (id !== "depth" && focusMode) setFocusMode(false);
  }, 0);
  for (const [k, p] of Object.entries(panes)) p.hidden = k !== id;
  for (const b of tabs.querySelectorAll("button")) b.classList.toggle("on", (b as HTMLElement).dataset.id === id);
}
const adjustPane = addPane("adjust", t("tab.adjust"));
// Hidden for now (not in the tab bar): the Look and Ask AI panels still exist, off-screen.
const lookPane = el("div");
const regionsPane = addPane("regions", t("tab.regions"));
const depthPane = addPane("depth", t("tab.depth"));
const upscalePane = addPane("upscale", t("tab.upscale"));
const llmPane = el("div");
const exportPane = addPane("export", t("tab.export"));
const debugPane = addPane("debug", t("tab.debug"));
// Info (what was measured and decided) comes last; editing starts in Adjust.
const autoPane = addPane("auto", t("tab.auto"));
showPane("adjust");
autoPane.append(el("p", { class: "muted", text: t("auto.hint") }));

// --------------------------------------------------------------------------- state
let caps: Capabilities | undefined;
let params: Params | undefined;
let autoParams: Params | undefined;
let decisions: Decision[] = [];
let summary: Summary | undefined;
/** The automatic 2× stage of the open photo. */
let upscale: UpscaleInfo | undefined;
let profile: StageProfile[] = [];
const logLines: string[] = [];
let looks: Array<{ id: string; name: string; description: string }> = [];
let dofInfo: { justified: boolean; focus: number; strength: number; reason: string; x?: number; y?: number; zones?: Array<{ share: number; label: string; lo: number; hi: number }>; bands?: Array<{ share: number; label: string; lo: number; hi: number }> } | undefined;
let focusMode = false;
/** A ring being dragged: which one, where it started, where it is now. */
let drag: { index: number; x0: number; y0: number; x: number; y: number; moved: boolean; ox: number; oy: number } | undefined;
/** Where the lone automatic ring was dropped, until the engine's reply makes it a point. */
let pendingAuto: { x: number; y: number } | undefined;
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
// Export in one tap, with the Export tab's current settings (format, colour, quality).
const exportTop = el("button", { class: "btn small primary", text: t("app.export") });
exportTop.onclick = () => exportBtn.click();
exportTop.disabled = true; // until a photo is open
header.insertBefore(exportTop, fsBtn);
stage.append(fsExit);

let resolution: "auto" | "full" | "half" = "auto";
let exposureSuggestion = 0;
// On unless the user turned it off (a damped, measured correction; see the decision engine).
let autoExposure = (() => { try { return localStorage.getItem("autoExposure") !== "0"; } catch { return true; } })();
let autoDof = (() => { try { return localStorage.getItem("autoDof") === "1"; } catch { return false; } })();
let upscaleMode: UpscaleMode = (() => { try { const v = localStorage.getItem("upscaleMode"); return v === "always" || v === "off" ? v : "auto"; } catch { return "auto"; } })();
/** The open photo (for "back to original size", which reopens it at 1×). */
let currentFile: File | undefined;
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

function openFile(f: File, restore?: Params, upscaleOverride?: UpscaleMode) {
  pendingRestore = restore;
  upscale = undefined;
  currentFile = f;
  // A new photo starts unzoomed, with the normal preview resolution.
  zoom = 1; panX = 0; panY = 0;
  canvas.style.transform = "";
  clearTimeout(zoomTimer);
  pendingAuto = undefined;
  // Through the engine's queue, ahead of the open: a zoom resize still queued
  // there must not leave the new photo at the zoomed size.
  if (sentPreviewLong) { sentPreviewLong = 0; send({ type: "preview-zoom", long: basePreviewLong() }); }
  renderUpscale();
  if (!restore) void rememberPhoto(f);
  markInflight();
  empty.style.display = "none";
  canvas.style.display = "block";
  logLines.length = 0;
  setProgress(t("progress.opening", { file: f.name }));
  busy = true;
  send({ type: "open", file: f, resolution, autoExposure, autoDof, upscale: upscaleOverride ?? upscaleMode });
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

/**
 * The rings shown while picking focus: the focus points, or — before any are
 * added — the automatic subject, which is kept (and editable) as the first
 * point once manual points are added.
 */
function shownFocusPoints(): Array<{ x: number; y: number; auto?: boolean }> {
  if (!focusMode || !params?.enable.dof) return [];
  // The ring being dragged is drawn where the finger is; params stay untouched
  // until the engine has measured the new place (a reply may arrive mid-drag).
  const d = drag?.moved ? drag : undefined;
  if (params.dof.points.length) {
    return params.dof.points.map((q, i) => (d && i === d.index ? { x: d.x, y: d.y } : q));
  }
  if (d) return [{ x: d.x, y: d.y, auto: true }];
  if (pendingAuto) return [{ ...pendingAuto, auto: true }];
  return dofInfo?.x !== undefined && dofInfo.y !== undefined ? [{ x: dofInfo.x, y: dofInfo.y, auto: true }] : [];
}

/** One ring per focus point; numbered so several subjects can be told apart. */
function renderRings() {
  // Rings are an editing aid: only shown while picking focus points.
  const pts = shownFocusPoints();
  const r = imageRect(), st = stage.getBoundingClientRect();
  rings.replaceChildren(...pts.map((p, i) => {
    const d = el("div", { class: "focus-ring" + (p.auto ? " auto" : "") + (drag?.index === i ? " drag" : ""), text: p.auto ? t("view.ringAuto") : String(i + 1) });
    d.style.left = `${r.left - st.left + p.x * r.width}px`;
    d.style.top = `${r.top - st.top + p.y * r.height}px`;
    return d;
  }));
}
window.addEventListener("resize", () => applyZoom());

// Zoom and pan: pinch (or wheel / trackpad) zooms around the fingers, one finger
// pans a zoomed photo, double-tap zooms in and back out. The canvas is only
// transformed with CSS; once the gesture settles the preview is re-rendered at
// a higher resolution so the zoomed view is real detail, not enlarged pixels.
let zoom = 1, panX = 0, panY = 0;
const MAX_ZOOM = 8;
const pointers = new Map<number, { x: number; y: number }>();
let pinch: { d0: number; z0: number; cx0: number; cy0: number; px0: number; py0: number } | undefined;
/** The current one-finger gesture: where it started, whether it became a pan. */
let press: { x0: number; y0: number; px0: number; py0: number; moved: boolean; tap?: { x: number; y: number } } | undefined;
let lastTap = { t: 0, x: 0, y: 0 };
let zoomTimer = 0;
let sentPreviewLong = 0;
const basePreviewLong = () => Math.max(window.innerWidth, window.innerHeight) * Math.min(2, window.devicePixelRatio || 1);

function applyZoom() {
  const st = stage.getBoundingClientRect();
  // Photo size on screen at zoom 1 (object-fit: contain).
  const k = Math.min(st.width / (canvas.width || 1), st.height / (canvas.height || 1));
  const maxX = Math.max(0, (canvas.width * k * zoom - st.width) / 2), maxY = Math.max(0, (canvas.height * k * zoom - st.height) / 2);
  panX = Math.min(maxX, Math.max(-maxX, panX));
  panY = Math.min(maxY, Math.max(-maxY, panY));
  canvas.style.transform = zoom === 1 ? "" : `translate(${panX}px, ${panY}px) scale(${zoom})`;
  renderRings();
  clearTimeout(zoomTimer);
  zoomTimer = window.setTimeout(() => {
    const cap = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1 ? 2560 : 4096;
    // Two steps only (not one size per zoom level): every size is a new proxy and render targets.
    const want = Math.round(zoom > 2.2 ? cap : zoom > 1.2 ? Math.min(cap, basePreviewLong() * 1.8) : basePreviewLong());
    if (params && Math.abs(want - sentPreviewLong) > 64) { sentPreviewLong = want; send({ type: "preview-zoom", long: want }); }
  }, 300);
}
/** Zooms to `z` keeping the stage point (clientX, clientY) where it is. */
function zoomAt(z: number, clientX: number, clientY: number) {
  const st = stage.getBoundingClientRect();
  const fx = clientX - (st.left + st.width / 2), fy = clientY - (st.top + st.height / 2);
  const z1 = Math.min(MAX_ZOOM, Math.max(1, z));
  panX = fx - (fx - panX) * (z1 / zoom);
  panY = fy - (fy - panY) * (z1 / zoom);
  zoom = z1;
  if (zoom === 1) { panX = 0; panY = 0; }
  applyZoom();
}
function resetZoom() { zoom = 1; panX = 0; panY = 0; applyZoom(); }
stage.addEventListener("wheel", (e) => {
  if (!params) return;
  e.preventDefault();
  // Trackpad pinch arrives as ctrl+wheel; a mouse wheel moves in coarse steps (or by lines);
  // anything else is a two-finger trackpad scroll, which pans a zoomed photo.
  const mouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
  if (e.ctrlKey || mouseWheel) zoomAt(zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY);
  else { panX -= e.deltaX; panY -= e.deltaY; applyZoom(); }
}, { passive: false });

// Press and hold: before (camera rendering). Tap in focus mode: add/remove a focus point.
let holdTimer = 0;
let holding = false;
stage.addEventListener("pointerdown", (e) => {
  if (!params || (e.target !== canvas && !pointers.size) || (e.pointerType === "mouse" && e.button !== 0)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  stage.setPointerCapture(e.pointerId);
  if (pointers.size === 2) {
    // Second finger: a pinch. Whatever the first finger started is abandoned.
    clearTimeout(holdTimer);
    endHold();
    if (drag?.moved) endDragRing(); else drag = undefined;
    press = undefined;
    const [p1, p2] = [...pointers.values()];
    pinch = { d0: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1, z0: zoom, cx0: (p1.x + p2.x) / 2, cy0: (p1.y + p2.y) / 2, px0: panX, py0: panY };
    renderRings();
    return;
  }
  if (pointers.size > 2) return;
  press = { x0: e.clientX, y0: e.clientY, px0: panX, py0: panY, moved: false };
  if (focusMode) {
    const r = imageRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    if (x < 0 || y < 0 || x > 1 || y > 1) return;
    // On a ring: drag moves it, a tap removes it. Elsewhere: a new point, on release
    // (so a pan or a pinch does not add one).
    const hit = shownFocusPoints().findIndex((q) => Math.hypot(q.x - x, q.y - y) < 0.045);
    if (hit >= 0) {
      const q = shownFocusPoints()[hit];
      drag = { index: hit, x0: x, y0: y, x, y, moved: false, ox: q.x, oy: q.y };
      renderRings();
      return;
    }
    press.tap = { x, y };
    return;
  }
  holdTimer = window.setTimeout(() => { holding = true; badge.textContent = t("view.before"); badge.classList.add("on"); send({ type: "view", view: currentView, before: true }); }, 180);
});
stage.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size >= 2) {
    const [p1, p2] = [...pointers.values()];
    const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    const st = stage.getBoundingClientRect();
    const scx = st.left + st.width / 2, scy = st.top + st.height / 2;
    const z1 = Math.min(MAX_ZOOM, Math.max(1, pinch.z0 * d / pinch.d0));
    // The photo point under the fingers' first midpoint follows their current midpoint.
    const c0x = pinch.cx0 - scx, c0y = pinch.cy0 - scy;
    panX = ((p1.x + p2.x) / 2 - scx) - (c0x - pinch.px0) * (z1 / pinch.z0);
    panY = ((p1.y + p2.y) / 2 - scy) - (c0y - pinch.py0) * (z1 / pinch.z0);
    zoom = z1;
    if (zoom === 1) { panX = 0; panY = 0; }
    applyZoom();
    return;
  }
  if (drag && params) {
    const r = imageRect();
    drag.x = clamp01((e.clientX - r.left) / r.width);
    drag.y = clamp01((e.clientY - r.top) / r.height);
    if (Math.hypot(drag.x - drag.x0, drag.y - drag.y0) > 0.01) drag.moved = true;
    if (drag.moved) renderRings();
    return;
  }
  if (!press) return;
  const dx = e.clientX - press.x0, dy = e.clientY - press.y0;
  if (!press.moved && Math.hypot(dx, dy) > 8) {
    press.moved = true;
    press.tap = undefined;
    if (!holding) clearTimeout(holdTimer);
  }
  if (press.moved && zoom > 1) { panX = press.px0 + dx; panY = press.py0 + dy; applyZoom(); }
});
function endDragRing(cancelled = false) {
  if (!drag) return;
  const d = drag;
  drag = undefined;
  const pts = params?.dof.points ?? [];
  if (d.moved) {
    // The point is found again by where it was (the list may have changed meanwhile).
    let index = -1;
    if (pts.length) {
      index = pts.findIndex((q) => Math.hypot(q.x - d.ox, q.y - d.oy) < 1e-3);
      if (index < 0) { renderRings(); return; } // it is gone: nothing to move
    } else pendingAuto = { x: d.x, y: d.y };
    send({ type: "focus", action: "move", index, x: d.x, y: d.y });
  }
  // A tap on a point removes it; a tap on the lone automatic ring changes nothing;
  // a touch the system cancelled changes nothing either.
  else if (!cancelled && pts.length) send({ type: "focus", action: "toggle", x: d.x0, y: d.y0 });
  renderRings();
}
function clamp01(v: number) { return Math.min(1, Math.max(0, v)); }
const endHold = () => {
  clearTimeout(holdTimer);
  if (holding) { holding = false; badge.classList.remove("on"); send({ type: "view", view: currentView, before: false }); }
};
function pointerEnd(e: PointerEvent) {
  if (!pointers.delete(e.pointerId)) return;
  if (pinch) {
    // The pinch ends with its first lifted finger; the other one may keep panning.
    if (pointers.size < 2) pinch = undefined;
    const rest = [...pointers.values()][0];
    press = rest ? { x0: rest.x, y0: rest.y, px0: panX, py0: panY, moved: true } : undefined;
    return;
  }
  endDragRing(e.type !== "pointerup");
  endHold();
  const p = press;
  press = undefined;
  if (!p || p.moved || e.type === "pointercancel") return;
  if (p.tap) { send({ type: "focus", action: "toggle", x: p.tap.x, y: p.tap.y }); return; }
  if (focusMode) return;
  // Double-tap: zoom in to 2.5× there, or back out.
  const now = performance.now();
  if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
    lastTap.t = 0;
    if (zoom > 1) resetZoom(); else zoomAt(2.5, e.clientX, e.clientY);
  } else lastTap = { t: now, x: e.clientX, y: e.clientY };
}
stage.addEventListener("pointerup", pointerEnd);
stage.addEventListener("pointercancel", pointerEnd);
// Capture lost without an up/cancel (e.g. a context menu): treat it as a cancel.
stage.addEventListener("lostpointercapture", (e) => { if (pointers.has(e.pointerId)) pointerEnd(new PointerEvent("pointercancel", { pointerId: e.pointerId })); });
// Leaving the page mid-gesture: forget every finger, so the next touch starts clean.
function resetGestures() {
  pointers.clear();
  pinch = undefined;
  press = undefined;
  if (drag) endDragRing(true);
  endHold();
}
window.addEventListener("blur", resetGestures);
document.addEventListener("visibilitychange", () => { if (document.hidden) resetGestures(); });
let currentView: 0 | 1 | 2 = 0;

// --------------------------------------------------------------------------- params plumbing
let pushTimer = 0;
// While a slider is held, previews render at a quarter of the pixels (drafts);
// releasing it renders the full preview once.
let dragging = false;
/** Something was changed during this drag (a draft went out): the release renders the final preview. */
let draftSent = false;
document.addEventListener("pointerdown", (e) => { if ((e.target as HTMLElement).matches?.('input[type="range"], .curve-editor')) { dragging = true; draftSent = false; } }, true);
// A touch on a curve box that turned into a page scroll changed nothing: no render.
const endDrag = () => { if (!dragging) return; dragging = false; if (draftSent) pushParams(); };
document.addEventListener("pointerup", endDrag, true);
document.addEventListener("pointercancel", endDrag, true);

function pushParams() {
  if (!params) return;
  clearTimeout(pushTimer);
  const draft = dragging;
  if (draft) draftSent = true;
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
  slider({ path: "hdr.headroom", label: t("adj.hdrHeadroom"), min: 0, max: 3, step: 0.25, fmt: (v) => (v ? `+${v.toFixed(2)} EV` : t("adj.hdrOff")) }),
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
  el("div", { class: "group-title", text: t("adj.vignette") }),
  slider({ path: "vignette.amount", label: t("adj.vigAmount"), min: -1, max: 1, step: 0.01, fmt: pct }),
  slider({ path: "vignette.midpoint", label: t("adj.vigMidpoint"), min: 0, max: 1, step: 0.01, fmt: pct }),
  slider({ path: "vignette.feather", label: t("adj.vigFeather"), min: 0, max: 1, step: 0.01, fmt: pct }),
  slider({ path: "vignette.roundness", label: t("adj.vigRoundness"), min: 0, max: 1, step: 0.01, fmt: pct }),
  slider({ path: "vignette.highlights", label: t("adj.vigHighlights"), min: 0, max: 1, step: 0.01, fmt: pct }),
  el("div", { class: "group-title", text: t("adj.grain") }),
  slider({ path: "grain.amount", label: t("adj.grainAmount"), min: 0, max: 1, step: 0.01, fmt: pct }),
  slider({ path: "grain.size", label: t("adj.grainSize"), min: 0, max: 1, step: 0.01, fmt: pct }),
  slider({ path: "grain.roughness", label: t("adj.grainRoughness"), min: 0, max: 1, step: 0.01, fmt: pct }),
  slider({ path: "grain.color", label: t("adj.grainColour"), min: 0, max: 1, step: 0.01, fmt: pct }),
  el("p", { class: "muted", text: t("adj.grainHint") }),
);
// Curves for this photo (L, R, G, B), independent of the look's own curves and of
// the per-region curves (Regions tab): tone-range sliders (src/ui/toneCurves.ts).
let histograms: Float32Array | undefined;
/** Dev builds only: a read-only view of the state for the automated photo checks (scripts, not the UI). */
let finalPreviews = 0;
if (import.meta.env.DEV) (globalThis as unknown as { __shk: unknown }).__shk = () => ({ summary, decisions, params, autoParams, finalPreviews, busy, log: logLines });
/** Share of the frame (%) of each region at each distance. */
let cellCov: Record<string, number> | undefined;
const photoCurves = createToneCurves({
  histogram: (c) => histogramOf(histograms, "photo", c),
  get: () => params?.curves,
  set: (c) => { if (params) params.curves = c; },
  changed: () => { lookPanel.invalidate(); pushParams(); },
  enabled: () => !!params,
});
// Strength of the automatic curves (photo, regions, skin, distance): rescales
// every curve that is still the automatic one; curves edited by hand are kept.
let autoCurveBands: AutoCurveBands | undefined;
const acInput = el("input", { type: "range", min: "0", max: "1.5", step: "0.05" });
const acOut = el("output");
const acRow = el("div", { class: "row" }, el("label", { text: t("adj.autoCurves") }), acInput, acOut);
function renderAutoCurves() {
  const k = params?.autoCurves ?? 1;
  acInput.value = String(k);
  acOut.textContent = `${Math.round(k * 100)}%`;
  acOut.classList.toggle("auto", Math.abs(k - 1) < 1e-6);
  acRow.hidden = !autoCurveBands || (!autoCurveBands.photo && !Object.keys(autoCurveBands.regions).length && !Object.keys(autoCurveBands.depth).length);
}
function setAutoCurves(k: number) {
  if (!params || !autoCurveBands) return;
  applyAutoCurves(params, autoCurveBands, k, params.autoCurves ?? 1);
  lookPanel.invalidate();
  syncControls();
  regionsPanel.render();
  pushParams();
}
acInput.oninput = () => setAutoCurves(parseFloat(acInput.value));
acRow.querySelector("label")!.addEventListener("dblclick", () => setAutoCurves(1));
adjustPane.append(
  el("div", { class: "group-title", text: t("adj.curves") }),
  acRow,
  photoCurves.el,
  el("p", { class: "muted", text: t("adj.curvesHint") }),
);

const resetBtn = el("button", { class: "btn small", text: t("adj.reset") });
resetBtn.onclick = () => { if (autoParams) { params = structuredClone(autoParams); syncControls(); pushParams(); } };
adjustPane.append(el("div", { class: "actions" }, resetBtn), el("p", { class: "muted", text: t("adj.amberHint") }));

// Look profiles: browser, palette, reference, editor (src/ui/lookPanel.ts)
const lookPanel = createLookPanel(lookPane, {
  send,
  params: () => params,
  changed: () => { syncControls(); pushParams(); },
  download,
  progress: (t) => setProgress(t),
});
function renderLooks() { lookPanel.sync(); }

// Ask an LLM: a prompt to copy out, an answer to paste back (src/ui/llmPanel.ts)
const llmPanel = createLlmPanel(llmPane, {
  params: () => params,
  auto: () => autoParams,
  summary: () => summary,
  decisions: () => decisions,
  looks: () => lookPanel.list(),
  cellCoverage: () => cellCov,
  selectLook: (id) => lookPanel.select(id),
  changed: () => { lookPanel.invalidate(); regionsPanel.render(); syncControls(); pushParams(); },
  canvas,
});

// Regions: per-segment controls (src/ui/regionsPanel.ts)
const regionsPanel = createRegionsPanel(regionsPane, {
  params: () => params,
  auto: () => autoParams,
  coverage: () => summary?.coverage,
  cellCoverage: () => cellCov,
  bandShare: () => dofInfo?.bands?.map((b) => b.share),
  histogram: (target, c) => histogramOf(histograms, target, c),
  changed: () => { lookPanel.invalidate(); pushParams(); },
  // A region (view 4, optionally only at a depth range: a region at a distance) or only a depth range (view 5).
  highlight: (h) => send(h === undefined ? { type: "view", view: currentView }
    : h.region === undefined ? { type: "view", view: 5, range: h.range } : { type: "view", view: 4, region: h.region, range: h.range }),
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
function setFocusMode(on: boolean) {
  focusMode = on;
  focusBtn.classList.toggle("primary", on);
  badge.textContent = on ? t("dof.pickBadge") : "";
  badge.classList.toggle("on", on);
  renderRings();
}
focusBtn.onclick = () => setFocusMode(!focusMode);
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
  if (i !== undefined && bandShown) { bandShown = false; renderBands(); }
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

// ---- Curves by distance: near / middle / far, soft thirds of this photo's depth layers
let curveBand: DepthBand = "near";
let bandShown = false;
const bandChips = el("div", { class: "chips" });
/** Depth range of a band for the highlight view (open-ended at the ends). */
function bandRange(b: DepthBand): [number, number] {
  const [b1, b2] = params?.depthBands ?? [0.33, 0.66];
  return b === "near" ? [-1, b1] : b === "middle" ? [b1, b2] : [b2, 2];
}
function setBandShown(on: boolean) {
  bandShown = on;
  if (on && zoneHighlight !== undefined) { zoneHighlight = undefined; renderZones(); }
  send(on ? { type: "view", view: 5, range: bandRange(curveBand) } : { type: "view", view: currentView });
  renderBands();
}
const depthCurves = createToneCurves({
  histogram: (c) => histogramOf(histograms, curveBand, c),
  get: () => params?.depthCurves[curveBand],
  set: (c) => { if (params) params.depthCurves[curveBand] = c; },
  changed: () => { lookPanel.invalidate(); pushParams(); },
  enabled: () => !!params,
});
function renderBands() {
  const eye = el("button", { class: "chip eye" + (bandShown ? " on" : ""), text: "◉", title: t("dof.showBand"), "aria-label": t("dof.showBand") });
  eye.onclick = () => setBandShown(!bandShown);
  bandChips.replaceChildren(eye, ...DEPTH_BANDS.map((b, i) => {
    const z = dofInfo?.bands?.[i];
    const edited = params?.depthCurves[b] && !(["l", "r", "g", "b"] as const).every((k) => isFlat(params!.depthCurves[b]![k] ?? [{ x: 0, y: 0 }, { x: 1, y: 1 }]));
    const info = z ? ` ${Math.round(z.share * 100)}%${z.label ? " · " + tOr(`group.${z.label}`, z.label).toLowerCase() : ""}` : "";
    const c = el("button", { class: "chip" + (b === curveBand ? " on" : ""), text: t(`band.${b}`) + info + (edited ? " •" : "") });
    c.onclick = () => { curveBand = b; depthCurves.render(); if (bandShown) setBandShown(true); else renderBands(); };
    return c;
  }));
  depthCurves.render();
}
depthPane.append(
  el("div", { class: "group-title", text: t("dof.curves") }),
  el("p", { class: "muted", text: t("dof.curvesHint") }),
  bandChips,
  depthCurves.el,
);
renderBands();

// Export
const fmtSel = el("select", {}, el("option", { value: "jpeg", text: "JPEG" }), el("option", { value: "jpeg-hdr", text: t("exp.jpegHdr") }), el("option", { value: "heic", text: "HEIC" }), el("option", { value: "tiff16", text: t("exp.tiff") }), el("option", { value: "dng", text: t("exp.dng") }));
const spaceSel = el("select", {}, el("option", { value: "p3", text: "Display P3" }), el("option", { value: "srgb", text: "sRGB" }));
const qualitySl = el("input", { type: "range", min: "0.6", max: "1", step: "0.01", value: "0.92" });
const qualityOut = el("output", { text: "92" });
qualitySl.oninput = () => (qualityOut.textContent = String(Math.round(+qualitySl.value * 100)));
const exportBtn = el("button", { class: "btn primary", text: t("exp.button") });
const exportInfo = el("p", { class: "muted" });
/** The Export tab's button and the header's one are busy together. */
function setExportEnabled(on: boolean) { exportBtn.disabled = !on; exportTop.disabled = !on || !params; }
exportBtn.onclick = () => {
  if (!params || busy) return;
  busy = true;
  setExportEnabled(false);
  setProgress(t("progress.exporting"));
  // ?strip=N overrides the export strip height (memory vs speed; testing).
  const stripRows = Number(new URLSearchParams(location.search).get("strip")) || undefined;
  send({ type: "export", format: fmtSel.value as ExportFormat, quality: +qualitySl.value, space: spaceSel.value as "srgb" | "p3", stripRows });
};
const resSel = el("select", {}, el("option", { value: "auto", text: t("exp.resAuto") }), el("option", { value: "full", text: t("exp.resFull") }), el("option", { value: "half", text: t("exp.resHalf") }));
resSel.onchange = () => (resolution = resSel.value as typeof resolution);
const hdrHint = el("p", { class: "muted", text: t("exp.jpegHdrHint") });
hdrHint.hidden = true;
exportPane.append(
  el("div", { class: "row" }, el("label", { text: t("exp.format") }), fmtSel, el("span")),
  el("div", { class: "row" }, el("label", { text: t("exp.colour") }), spaceSel, el("span")),
  el("div", { class: "row" }, el("label", { text: t("exp.quality") }), qualitySl, qualityOut),
  hdrHint,
  el("div", { class: "actions" }, exportBtn),
  exportInfo,
  el("div", { class: "group-title", text: t("exp.next") }),
  resSel,
  el("p", { class: "muted", text: t("exp.hint") }),
);
fmtSel.onchange = () => {
  const f = fmtSel.value;
  qualitySl.disabled = !(f === "jpeg" || f === "jpeg-hdr" || f === "heic");
  hdrHint.hidden = f !== "jpeg-hdr";
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
  const blob = new Blob([JSON.stringify({ summary, decisions, auto: autoParams, params, profile, log: logLines }, null, 2)], { type: "application/json;charset=utf-8" });
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

/** One line on the automatic 2× stage: what happened, and one short reason. */
function upscaleText(u: UpscaleInfo): string {
  const reason = tOr(`up.r.${u.code}`, u.upscaleReason, u.vars);
  switch (u.state) {
    case "applied": return `${t("up.applied")} — ${reason}` + (u.width ? ` (${t("up.size", { w: u.width, h: u.height ?? 0 })})` : "");
    case "running": return `${t("up.running")} ${reason}`;
    case "pending": return t("up.pending");
    case "failed": return t("up.failed");
    case "cancelled": return t("up.cancelled");
    default:
      if (u.code === "off") return t("up.offSkip");
      if (u.code === "forced") return t("up.pending");
      return ["sufficient", "sharp-12", "adequate"].includes(u.code) ? `${t("up.skipSufficient")} (${reason})` : `${t("up.skipped")} — ${reason}`;
  }
}

// --------------------------------------------------------------------------- upscale tab
const upMode = el("select", {},
  el("option", { value: "auto", text: t("upt.modeAuto") }),
  el("option", { value: "always", text: t("upt.modeAlways") }),
  el("option", { value: "off", text: t("upt.modeOff") }));
upMode.value = upscaleMode;
upMode.onchange = () => {
  upscaleMode = upMode.value as UpscaleMode;
  try { localStorage.setItem("upscaleMode", upscaleMode); } catch { /* private mode */ }
  renderUpscale();
};
const upStatus = el("p", { class: "up-status" });
const upFacts = el("dl", { class: "kv" });
const upNow = el("button", { class: "btn primary", text: t("upt.runNow") });
upNow.onclick = () => { if (upscale) { markInflight(); send({ type: "upscale-now" }); } };
const upRevert = el("button", { class: "btn", text: t("upt.revert") });
upRevert.onclick = () => { if (currentFile && params) openFile(currentFile, structuredClone(params), "off"); };
const upModeNote = el("p", { class: "muted" });
upscalePane.append(
  upStatus,
  el("div", { class: "actions" }, upNow, upRevert),
  upFacts,
  el("div", { class: "group-title", text: t("upt.mode") }),
  el("div", { class: "row" }, el("label", { text: t("upt.forNext") }), upMode, el("span")),
  upModeNote,
  el("p", { class: "muted", text: t("upt.about") }),
);

function renderUpscale() {
  const u = upscale;
  upStatus.textContent = u ? upscaleText(u) : currentFile ? t("up.pending") : t("upt.none");
  upModeNote.textContent = t(upscaleMode === "auto" ? "upt.noteAuto" : upscaleMode === "always" ? "upt.noteAlways" : "upt.noteOff");
  const idle = !!u && (u.state === "skipped" || u.state === "failed" || u.state === "cancelled");
  upNow.hidden = !idle || u!.code === "memory";
  upRevert.hidden = u?.state !== "applied";
  upFacts.replaceChildren();
  if (!u) return;
  const r = u.report, m = r.metrics;
  const add = (k: string, v: string) => upFacts.append(el("dt", { text: k }), el("dd", { text: v }));
  add(t("upt.source"), `${r.width}×${r.height} · ${r.megapixels.toFixed(1)} MP`);
  if (u.state === "applied" && u.width) add(t("upt.result"), `${u.width}×${u.height} · ${((u.width * (u.height ?? 0)) / 1e6).toFixed(1)} MP`);
  add(t("upt.sharpness"), `${Math.round(r.sharpnessScore * 100)}% · ${t("upt.edge", { px: Number.isFinite(m.edgeSigma) ? m.edgeSigma.toFixed(2) : "—" })}`);
  add(t("upt.noise"), `${(m.noiseSigma * 255).toFixed(2)} / 255`);
  add(t("upt.detail"), `${(m.detailDensity * 100).toFixed(1)}%`);
  add(t("upt.blur"), r.severeBlur ? t("upt.yes") : t("upt.no"));
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
    if (upscale) add(t("auto.detail"), upscaleText(upscale));
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
  photoCurves.render();
  renderLooks();
  renderStageToggles();
  if (params) { dofToggle.checked = params.enable.dof; }
  renderRings();
  renderZones();
  renderBands();
  renderAutoCurves();
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
  // No WebGPU at all: not a failure of this photo — say what to do, in the UI language.
  const noGpu = text.startsWith("WebGPU is not available");
  if (noGpu) text = t("err.noWebgpuHow");
  errorBox.hidden = false;
  errorBox.replaceChildren(
    el("strong", { text: noGpu ? t("err.noWebgpu") : t("err.gpu") }),
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
    case "upscale":
      upscale = m.info;
      // While the 2× stage runs the tab holds its largest buffers: keep the crash
      // guard armed so a memory kill leads to the safe reopen, not a loop.
      if (m.info.state === "running") markInflight();
      else if (!busy) markCompleted();
      if (m.info.state !== "running" && m.info.state !== "pending" && !busy) setProgress(undefined);
      renderAuto();
      renderUpscale();
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
      if (m.final) finalPreviews++;
      drawPreview(m);
      if (m.final && !holding) setProgress(undefined);
      if (m.final) markCompleted();
      if (m.final && !panes.look.hidden) lookPanel.requestThumbs();
      busy = false;
      break;
    case "analysis":
      summary = m.summary; decisions = m.decisions; autoParams = m.auto; params = m.params; dofInfo = m.dof;
      autoCurveBands = m.autoCurves;
      exportTop.disabled = busy;
      cellCov = m.cellCoverage;
      histograms = undefined; // the previous photo's; the first final preview brings new ones
      exposureSuggestion = m.exposureSuggestion;
      aeNote.textContent = exposureSuggestion ? t("adj.suggests", { ev: `${exposureSuggestion > 0 ? "+" : ""}${exposureSuggestion.toFixed(2)}` }) : t("adj.noCorrection");
      // The reason itself comes from the decision engine and stays in English.
      dofReason.textContent = t("dof.reason", { d: m.dof.focus.toFixed(2) }) + (m.dof.justified ? t("dof.suggested") : t("dof.notSuggested")) + m.dof.reason;
      syncControls();
      renderAuto();
      llmPanel.reset();
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
    case "histograms":
      histograms = m.data;
      photoCurves.refreshHistogram();
      regionsPanel.refreshCurves();
      depthCurves.refreshHistogram();
      break;
    case "params":
      params = m.params;
      pendingAuto = undefined;
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
      setExportEnabled(true);
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
      setExportEnabled(true);
      setProgress(undefined);
      logLines.push("ERROR: " + m.message);
      logPre.textContent = logLines.join("\n");
      capsEl.innerHTML = "";
      {
        const shown = m.message.startsWith("WebGPU is not available") ? t("err.noWebgpuHow") : m.message;
        capsEl.append(el("span", { class: "error", text: m.message.startsWith("WebGPU is not available") ? t("err.noWebgpu") : shown.slice(0, 140) }));
        if (!params) { empty.style.display = ""; canvas.style.display = "none"; (empty.querySelector("p") as HTMLElement).textContent = shown; }
      }
      break;
  }
};
worker.onerror = (e) => { capsEl.textContent = t("err.worker", { msg: e.message }); };

const long = Math.max(window.innerWidth, window.innerHeight) * Math.min(2, window.devicePixelRatio || 1);
send({ type: "preview-size", long });
send({ type: "init", base: import.meta.env.BASE_URL });
fmtSel.onchange?.(new Event("change"));
