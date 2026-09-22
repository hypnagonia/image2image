/**
 * Session persistence across tab reloads.
 *
 * iOS Safari reloads a tab it evicted for memory, and a lost GPU device can
 * only be recovered by starting over. Both used to lose the photo and every
 * edit. The open photo is kept in the Origin Private File System (on-device,
 * per-site storage — nothing is uploaded) and the current parameters in
 * localStorage; a same-tab reload (sessionStorage survives it) restores both.
 */
import type { Params } from "../decision/params.ts";

const FILE = "last-photo";
const META = "lastPhoto.v1";
const PARAMS = "lastParams.v1";
const ACTIVE = "photoActive";
/** Set while a photo is being processed; cleared when processing completes. If it is
 * still set after a reload, that photo crashed the tab — never auto-restore it again. */
const INFLIGHT = "photoInflight";

interface Meta { name: string; type: string; savedAt: number }

async function dir(): Promise<FileSystemDirectoryHandle | undefined> {
  try { return await navigator.storage.getDirectory(); } catch { return undefined; }
}

export function markInflight() { try { sessionStorage.setItem(INFLIGHT, String(Date.now())); } catch { /* ignore */ } }
export function markCompleted() { try { sessionStorage.removeItem(INFLIGHT); } catch { /* ignore */ } }
/** True when the previous page load died while processing a photo (crash / memory eviction). */
export function crashedWhileProcessing(): boolean {
  try { return sessionStorage.getItem(INFLIGHT) !== null; } catch { return false; }
}

export async function rememberPhoto(file: File) {
  try {
    sessionStorage.setItem(ACTIVE, "1");
    localStorage.setItem(META, JSON.stringify({ name: file.name, type: file.type, savedAt: Date.now() } satisfies Meta));
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
export function rememberParams(p: Params | undefined) {
  if (!p) return;
  clearTimeout(timer);
  timer = window.setTimeout(() => { try { localStorage.setItem(PARAMS, JSON.stringify(p)); } catch { /* quota */ } }, 400);
}

/** The photo to restore after an unexpected reload of this tab, if any. */
export async function restorablePhoto(): Promise<{ file: File; params?: Params } | undefined> {
  try {
    if (sessionStorage.getItem(ACTIVE) !== "1") return undefined;
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
export function noteStage(text: string) { try { sessionStorage.setItem(STAGE, text.slice(0, 200)); } catch { /* ignore */ } }
export function lastStage(): string | undefined { try { return sessionStorage.getItem(STAGE) ?? undefined; } catch { return undefined; } }
