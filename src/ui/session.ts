/**
 * Session persistence across tab reloads.
 *
 * iOS Safari reloads a tab it evicted for memory, and a lost GPU device can
 * only be recovered by starting over. Both used to lose the photo and every
 * edit. The open photo is kept in the Origin Private File System (on-device,
 * per-site storage — nothing is uploaded) and the current parameters in
 * localStorage; a same-tab reload (sessionStorage survives it) restores both.
 *
 * Whether the page died while processing is kept in localStorage, not
 * sessionStorage: an iPhone Home Screen app that iOS killed starts a fresh
 * session when it is opened again, and would otherwise never learn that it
 * crashed (and crash the same way on every launch).
 */
import type { Params } from "../decision/params.ts";

const FILE = "last-photo";
const META = "lastPhoto.v1";
const PARAMS = "lastParams.v1";
const ACTIVE = "photoActive";
/** Set while a photo is being processed; cleared when processing completes. If it is
 * still set after a reload, that photo crashed the tab — never auto-restore it again.
 * A heartbeat tells a dead page's marker from another open tab's live one. */
const INFLIGHT = "photoInflight.v2";
interface Inflight { owner: string; beat: number; stage?: string; analysis?: string }
const BEAT_MS = 1000, DEAD_MS = 3000;
/** This page load's id (a same-tab reload keeps it: sessionStorage survives that). */
const PAGE = (() => {
  try { const v = sessionStorage.getItem("pageId") ?? Math.random().toString(36).slice(2); sessionStorage.setItem("pageId", v); return v; } catch { return Math.random().toString(36).slice(2); }
})();
function readInflight(): Inflight | undefined {
  try { const v = localStorage.getItem(INFLIGHT); return v ? (JSON.parse(v) as Inflight) : undefined; } catch { return undefined; }
}
function writeInflight(f: Inflight | undefined) {
  try { if (f) localStorage.setItem(INFLIGHT, JSON.stringify(f)); else localStorage.removeItem(INFLIGHT); } catch { /* private mode */ }
}
/** What the previous load was doing when it died (read once, before this page marks anything). */
const crashed: Inflight | undefined = (() => {
  const f = readInflight();
  return f && (f.owner === PAGE || Date.now() - f.beat > DEAD_MS) ? f : undefined;
})();
let heart = 0;

interface Meta { name: string; type: string; savedAt: number }

async function dir(): Promise<FileSystemDirectoryHandle | undefined> {
  try { return await navigator.storage.getDirectory(); } catch { return undefined; }
}

export function markInflight() {
  writeInflight({ owner: PAGE, beat: Date.now() });
  clearInterval(heart);
  heart = window.setInterval(() => { const f = readInflight(); if (f?.owner === PAGE) writeInflight({ ...f, beat: Date.now() }); }, BEAT_MS);
}
export function markCompleted() {
  clearInterval(heart);
  if (readInflight()?.owner === PAGE) writeInflight(undefined);
}
/** True when the previous page load died while processing a photo (crash / memory eviction). */
export function crashedWhileProcessing(): boolean { return !!crashed; }
/** The analysis stage (segmentation / depth) the previous load died in, if it did. */
export function crashedInAnalysis(): string | undefined { return crashed?.analysis; }
/** This load is in (or out of) segmentation / depth: remembered in case it dies there. */
export function noteAnalysis(stage: string | undefined) {
  const f = readInflight();
  if (f?.owner === PAGE) writeInflight({ ...f, analysis: stage === "segmentation" || stage === "depth" ? stage : undefined });
}

export async function rememberPhoto(file: File) {
  try {
    sessionStorage.setItem(ACTIVE, "1");
    localStorage.setItem(META, JSON.stringify({ name: file.name, type: file.type, savedAt: Date.now() } satisfies Meta));
    forgetPendingParams();
    localStorage.removeItem(PARAMS);
    const d = await dir();
    if (!d) return;
    const h = await d.getFileHandle(FILE, { create: true });
    const w = await (h as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
    await w.write(file);
    await w.close();
  } catch (e) {
    console.warn("could not persist photo", e);
  }
}

let timer = 0;
/** A save still waiting belongs to the previous photo: drop it. */
export function forgetPendingParams() { clearTimeout(timer); }
export function rememberParams(p: Params | undefined) {
  if (!p) return;
  clearTimeout(timer);
  timer = window.setTimeout(() => { try { localStorage.setItem(PARAMS, JSON.stringify(p)); } catch { /* quota */ } }, 400);
}

/** The photo to restore after an unexpected reload of this tab (or a crash of the app), if any. */
export async function restorablePhoto(): Promise<{ file: File; params?: Params } | undefined> {
  try {
    if (!crashed && sessionStorage.getItem(ACTIVE) !== "1") return undefined;
    const meta = JSON.parse(localStorage.getItem(META) ?? "null") as Meta | null;
    const d = await dir();
    if (!meta || !d) return undefined;
    const h = await d.getFileHandle(FILE);
    const blob = await h.getFile();
    if (!blob.size) return undefined;
    const file = new File([blob], meta.name, { type: meta.type });
    const raw = localStorage.getItem(PARAMS);
    return { file, params: raw ? (JSON.parse(raw) as Params) : undefined };
  } catch {
    return undefined;
  }
}

export function forgetSession() {
  try { sessionStorage.removeItem(ACTIVE); } catch { /* ignore */ }
}

const STAGE = "lastStage";
/** Breadcrumb for crash reports: the last stage the engine reported before the page died. */
export function noteStage(text: string) {
  try { sessionStorage.setItem(STAGE, text.slice(0, 200)); } catch { /* ignore */ }
  const f = readInflight();
  if (f?.owner === PAGE) writeInflight({ ...f, stage: text.slice(0, 200) });
}
export function lastStage(): string | undefined {
  if (crashed?.stage) return crashed.stage;
  try { return sessionStorage.getItem(STAGE) ?? undefined; } catch { return undefined; }
}
