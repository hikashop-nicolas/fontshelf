// Remembered choices, shared by every editor on the origin (localStorage, best effort).

export interface FontPrefs {
  /** The user asked for their installed fonts. */
  local?: boolean;
  /** The user agreed to download fonts from Google Fonts. */
  consent?: boolean;
  /** Web font families they added. */
  added?: string[];
}

export const PREFS_KEY = "fontshelf.prefs";
// richdoc's earlier key: its "local" and "added" carry over, its consent (Google only) does not.
const LEGACY_KEY = "richdoc.fonts";

const parse = (raw: string | null | undefined): FontPrefs | null => {
  if (!raw) return null;
  const p = JSON.parse(raw) as FontPrefs;
  return p && typeof p === "object" ? p : null;
};

export function readFontPrefs(): FontPrefs {
  try {
    const ls = globalThis.localStorage;
    const cur = parse(ls?.getItem(PREFS_KEY));
    if (cur) return cur;
    const old = parse(ls?.getItem(LEGACY_KEY));
    if (!old) return {};
    const out: FontPrefs = {};
    if (old.local) out.local = true;
    if (Array.isArray(old.added) && old.added.length) out.added = old.added;
    return out;
  } catch {
    return {};
  }
}

export function writeFontPrefs(patch: FontPrefs): FontPrefs {
  const next = { ...readFontPrefs(), ...patch };
  try { globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
  return next;
}
