// UI strings in 8 languages, with a host override: a partial dictionary or a resolver function.
import en from "./locales/en.js";
import fr from "./locales/fr.js";
import de from "./locales/de.js";
import es from "./locales/es.js";
import pt from "./locales/pt.js";
import ru from "./locales/ru.js";
import ja from "./locales/ja.js";
import zh from "./locales/zh.js";
import type { WebFontGroup } from "./catalog.js";

export type FontStringKey =
  | "font" | "cancel" | "close" | "fontsInDocument" | "fontsAll" | "fontsMore" | "fontsShowMine"
  | "fontsGetMore" | "fontMissing" | "fontsFound" | "fontsNoneFound" | "fontsGetTitle" | "fontsConsent"
  | "fontsContinue" | "fontsCatalogNote" | "fontsSearch" | "fontsLoading" | "fontsLoadFailed"
  | `fontGroup_${WebFontGroup}`;

export type FontStrings = Record<FontStringKey, string>;

/** Returns a string for a key, or undefined to fall through to the built-in one. */
export type FontStringResolver = (key: FontStringKey, params?: Record<string, string | number>) => string | undefined;

const LOCALES: Record<string, Partial<FontStrings>> = { en, fr, de, es, pt, ru, ja, zh };

let active: Partial<FontStrings> = en;
let activeCode = "en";
let override: Partial<FontStrings> | FontStringResolver | null = null;

/** The built-in locale codes. */
export const fontLocales = (): string[] => Object.keys(LOCALES);

/** Pick a built-in locale ("fr", "pt-BR", ...); unknown codes fall back to English. Default "en". */
export function setFontLocale(code: string): void {
  const base = code.toLowerCase().split("-")[0]!;
  active = LOCALES[base] ?? en;
  activeCode = LOCALES[base] ? base : "en";
}

export const getFontLocale = (): string => activeCode;

/** Host strings that win over the built-in ones (null clears). */
export function setFontStrings(strings: Partial<FontStrings> | FontStringResolver | null): void {
  override = strings;
}

const fill = (s: string, params?: Record<string, string | number>): string =>
  params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : s;

/** A UI string with {param} substitution. */
export function fontT(key: FontStringKey, params?: Record<string, string | number>): string {
  if (typeof override === "function") {
    const s = override(key, params);
    if (s !== undefined) return s;
  } else if (override?.[key] !== undefined) {
    return fill(override[key]!, params);
  }
  return fill(active[key] ?? en[key], params);
}
