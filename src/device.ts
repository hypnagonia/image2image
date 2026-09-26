/**
 * Phone or not, in one place (every worker asks here). A phone: iPhone / iPad /
 * Android, or a touch Mac (an iPad asking for the desktop site). The local autotest
 * (?autotest&phone) forces phone behaviour on a desktop browser, so the memory guard
 * (scripts/memcheck.mjs) measures exactly what an iPhone runs.
 */
let forced: boolean | undefined;
export function forcePhone(v: boolean | undefined) { forced = v; }
export function phoneForced(): boolean { return forced === true; }

const ua = () => globalThis.navigator?.userAgent ?? "";
const touches = () => (globalThis.navigator as Navigator & { maxTouchPoints?: number } | undefined)?.maxTouchPoints ?? 0;

export function isPhone(): boolean {
  if (forced !== undefined) return forced;
  return /iPhone|iPad|iPod|Android/i.test(ua()) || touches() > 1;
}
/** iOS / iPadOS WebKit (threaded wasm memory never shrinks there). */
export function isIOS(): boolean {
  if (forced !== undefined) return forced;
  return /iPhone|iPad|iPod/i.test(ua()) || (/Macintosh/.test(ua()) && touches() > 1);
}
