// The shared font registry: what every editor on the page can offer, and change events.
import { BASE_FONTS, LOCAL_CANDIDATES, findWebFont } from "./catalog.js";
import { canDraw, detectInstalled, hasLocalFontAccess, localFontsPermission, mergeNames, queryLocalFamilies } from "./detect.js";
import { loadWebFont, type Fetcher } from "./google.js";
import { loadedFamilies, restoreLoadedFonts } from "./loaded.js";
import { readFontPrefs, writeFontPrefs } from "./prefs.js";
import { emit, hasConsent, isRemoteEnabled, shared } from "./shared.js";

export interface FontState {
  /** Fonts the open documents use (every registered document). */
  document: string[];
  /** Installed fonts found so far (detected or listed). */
  installed: string[];
  /** installed is the full queryLocalFonts list, not only probed names. */
  installedFull: boolean;
  /** Families usable in this page beyond the installed ones: web families and fonts loaded from files. */
  added: string[];
  /** Families the user loaded from font files (also in `added`). */
  loaded: string[];
  /** Base fonts the browser can draw. */
  base: string[];
  remoteEnabled: boolean;
  consent: boolean;
}

export function getFontState(): FontState {
  const s = shared();
  return {
    document: mergeNames(...s.docFonts.values()),
    installed: [...s.installed],
    installedFull: s.installedFull,
    added: mergeNames([...s.added.values()]),
    loaded: loadedFamilies(),
    base: BASE_FONTS.filter((f) => canDraw(f)),
    remoteEnabled: isRemoteEnabled(),
    consent: hasConsent(),
  };
}

/** Call `listener` on every change (fonts found, family added, consent, remote switch). */
export function onFontsChange(listener: () => void): () => void {
  const s = shared();
  s.listeners.add(listener);
  return () => void s.listeners.delete(listener);
}

/** Register a document's fonts; the returned function unregisters them. */
export function addDocumentFonts(names: readonly string[]): () => void {
  const s = shared();
  const id = ++s.docSeq;
  s.docFonts.set(id, [...names]);
  emit();
  return () => {
    if (s.docFonts.delete(id)) emit();
  };
}

/** A web family or a font file was loaded in this page (or its font is otherwise usable). */
export const isAdded = (family: string): boolean => shared().added.has(family.toLowerCase());

let showing: Promise<{ found: number; full: boolean }> | null = null;

/**
 * "Show my fonts": list installed fonts with queryLocalFonts when allowed, else probe the
 * candidate names. `gesture` = the user asked just now, so the permission prompt may show.
 */
export function showInstalledFonts(opts: { gesture?: boolean; candidates?: readonly string[] } = {}): Promise<{ found: number; full: boolean }> {
  if (showing && !opts.gesture) return showing;
  const run = (async () => {
    const s = shared();
    const before = s.installed.length;
    let names: string[] | null = null;
    if (hasLocalFontAccess() && (opts.gesture || (await localFontsPermission()) === "granted")) names = await queryLocalFamilies();
    const full = !!names;
    if (!names) names = await detectInstalled(opts.candidates ?? LOCAL_CANDIDATES);
    s.installed = mergeNames(s.installed, names);
    s.installedFull = s.installedFull || full;
    if (opts.gesture) writeFontPrefs({ local: true });
    emit();
    return { found: s.installed.length - before, full: s.installedFull };
  })();
  showing = run;
  run.finally(() => { if (showing === run) showing = null; });
  return run;
}

/** Load a catalog family for drawing (Google CSS2) and remember it. False when refused or offline. */
export async function addRemoteFamily(family: string, fetcher?: Fetcher): Promise<boolean> {
  const wf = findWebFont(family);
  if (!wf) return false;
  const ok = await loadWebFont(wf.family, fetcher);
  if (!ok) return false;
  shared().added.set(wf.family.toLowerCase(), wf.family);
  const prefs = readFontPrefs();
  writeFontPrefs({ added: mergeNames(prefs.added ?? [], [wf.family]) });
  emit();
  return true;
}

/**
 * Start-up: bring back what the user opted into before. Fonts loaded from files (unless `loaded`
 * is false), installed fonts when they asked for them (and `local` is on); with remote allowed (and `remote` not false), their added families plus the catalog
 * families `docFonts` use that the browser cannot draw.
 */
export function restoreFonts(opts: { local?: boolean; remote?: boolean; loaded?: boolean; docFonts?: readonly string[] } = {}): void {
  const prefs = readFontPrefs();
  const s = shared();
  if (opts.loaded !== false) void restoreLoadedFonts();
  if (opts.local !== false && (prefs.local || s.installed.length)) void showInstalledFonts();
  if (opts.remote === false || !isRemoteEnabled() || !hasConsent()) return;
  const want = mergeNames(prefs.added ?? [], (opts.docFonts ?? []).filter((f) => findWebFont(f) && !canDraw(f)));
  for (const f of want) if (!isAdded(f)) void addRemoteFamily(f);
}
