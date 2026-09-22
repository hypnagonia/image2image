/**
 * UI translations. Only what the user reads is translated: the decision
 * engine's reasons, the Debug log, profiler internals, file metadata and
 * console messages stay in English.
 *
 * The language is chosen once, at load: a stored choice wins, otherwise the
 * first of navigator.languages whose primary subtag we support (pt-BR → pt),
 * otherwise English. Changing it reloads the page — every panel is built with
 * the strings of the language active at build time.
 */
import { en, type Dict, type Key } from "./locales/en.ts";
import { ru } from "./locales/ru.ts";
import { pt } from "./locales/pt.ts";
import { es } from "./locales/es.ts";

export type { Key };
export const LANGS = ["en", "ru", "pt", "es"] as const;
export type Lang = (typeof LANGS)[number];
/** Native names for the picker. */
export const LANG_NAMES: Record<Lang, string> = { en: "English", ru: "Русский", pt: "Português", es: "Español" };

const DICTS: Record<Lang, Dict> = { en, ru, pt, es };
const STORE = "uiLang";

const isLang = (v: unknown): v is Lang => LANGS.includes(v as Lang);

/** Explicit choice from the picker, if any (undefined = automatic). */
export function storedLang(): Lang | undefined {
  try { const v = localStorage.getItem(STORE); return isLang(v) ? v : undefined; } catch { return undefined; }
}

function detect(): Lang {
  const prefs = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of prefs) {
    const primary = (tag ?? "").toLowerCase().split(/[-_]/)[0];
    if (isLang(primary)) return primary;
  }
  return "en";
}

export const lang: Lang = storedLang() ?? detect();
if (typeof document !== "undefined") document.documentElement.lang = lang === "pt" ? "pt-BR" : lang;

/** Persists the choice (undefined = back to automatic) and reloads to rebuild the UI. */
export function setLang(l: Lang | undefined) {
  try { if (l) localStorage.setItem(STORE, l); else localStorage.removeItem(STORE); } catch { /* private mode */ }
  location.reload();
}

const dict = DICTS[lang];

/** Translated string; `{name}` placeholders are filled from `vars`. */
export function t(key: Key, vars?: Record<string, string | number>): string {
  const s = dict[key] ?? en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** For keys built from data (look ids, stage names): the translation, or `fallback` when there is none. */
export function tOr(key: string, fallback: string, vars?: Record<string, string | number>): string {
  return key in en || key in dict ? t(key as Key, vars) : fallback;
}
