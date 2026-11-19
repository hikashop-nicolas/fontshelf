// Page-wide state shared by every editor, kept on globalThis so two bundled copies of
// fontshelf still agree. Also the single network gate: host switch + user consent.
import { readFontPrefs, writeFontPrefs } from "./prefs.js";

export interface SharedState {
  remoteEnabled: boolean;
  /** Session consent; undefined = use the stored one. */
  consent: boolean | undefined;
  installed: string[];
  /** installed came from queryLocalFonts (the full list), not only probing. */
  installedFull: boolean;
  /** Lower-case name -> spelling, for web families loaded in this page. */
  added: Map<string, string>;
  docFonts: Map<number, string[]>;
  docSeq: number;
  listeners: Set<() => void>;
}

const KEY = Symbol.for("fontshelf.state.v1");

export function shared(): SharedState {
  const g = globalThis as unknown as Record<symbol, SharedState | undefined>;
  return (g[KEY] ??= {
    remoteEnabled: false, consent: undefined, installed: [], installedFull: false,
    added: new Map(), docFonts: new Map(), docSeq: 0, listeners: new Set(),
  });
}

/** Let fontshelf reach Google Fonts and GitHub (still only after the user's consent). */
export function setRemoteEnabled(on: boolean): void {
  const s = shared();
  if (s.remoteEnabled === on) return;
  s.remoteEnabled = on;
  emit();
}

export const isRemoteEnabled = (): boolean => shared().remoteEnabled;

/** The user agreed to downloads from Google Fonts and GitHub (stored, or given this session). */
export function hasConsent(): boolean {
  const c = shared().consent;
  return c ?? !!readFontPrefs().consent;
}

/** Record (or withdraw) the user's consent; it is remembered on this origin. */
export function setConsent(on: boolean): void {
  shared().consent = on;
  writeFontPrefs({ consent: on });
  emit();
}

/** The host enabled remote fonts and the user consented: only then does anything hit the network. */
export const remoteAllowed = (): boolean => isRemoteEnabled() && hasConsent();

export function emit(): void {
  for (const fn of [...shared().listeners]) {
    try { fn(); } catch { /* a listener's bug must not stop the others */ }
  }
}
