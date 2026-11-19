// Which families the browser can draw: canvas measureText probing, page font faces, and the
// Local Font Access API (Chromium desktop).

/** Metrics of `text` drawn in a CSS `font`, or null when they cannot be measured. */
export type Measure = (font: string, text: string) => readonly number[] | null;

// Latin plus CJK/Hangul so a font covering only one of them still changes the result.
export const PROBE_TEXT = "mmmmmmmmmmlli WwQq@#&0123 永あア한中";
const FALLBACKS = ["monospace", "serif", "sans-serif"] as const;
const SIZE = "72px";
const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "math", "emoji", "fangsong", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded"]);

/** A quoted CSS family name. */
export const cssFamily = (name: string): string => `"${name.replace(/["\\]/g, "")}"`;
const same = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) < 0.01);

/** A name -> present map; one per measure function. */
export type DetectCache = Map<string, boolean>;

// Baseline metrics of each bare generic, per measure function.
const baselines = new WeakMap<Measure, Map<string, readonly number[] | null>>();
const baseline = (measure: Measure, g: string): readonly number[] | null => {
  let m = baselines.get(measure);
  if (!m) baselines.set(measure, (m = new Map()));
  if (!m.has(g)) m.set(g, measure(`${SIZE} ${g}`, PROBE_TEXT));
  return m.get(g)!;
};

/** True when `name` draws differently from a bare generic family for any of the fallbacks. */
export function fontPresent(name: string, measure: Measure, cache: DetectCache = new Map()): boolean {
  const key = name.toLowerCase();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let found = false;
  if (!GENERIC.has(key)) {
    for (const g of FALLBACKS) {
      const base = baseline(measure, g);
      const m = measure(`${SIZE} ${cssFamily(name)}, ${g}`, PROBE_TEXT);
      if (base && m && !same(base, m)) { found = true; break; }
    }
  }
  cache.set(key, found);
  return found;
}

/** The present names, in their input order. */
export function detectFonts(names: readonly string[], measure: Measure, cache?: DetectCache): string[] {
  return names.filter((n) => fontPresent(n, measure, cache));
}

/** detectFonts, yielding to the page whenever a slice runs past `budgetMs`, so input stays live. */
export async function detectFontsAsync(names: readonly string[], measure: Measure, cache?: DetectCache, budgetMs = 12): Promise<string[]> {
  const out: string[] = [];
  let start = performance.now();
  for (const n of names) {
    if (fontPresent(n, measure, cache)) out.push(n);
    if (performance.now() - start > budgetMs) {
      await yieldTask();
      start = performance.now();
    }
  }
  return out;
}

// Yield one task (input and rendering run in between); idle callbacks starve on a busy page.
const yieldTask = (): Promise<void> => {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return typeof sched?.yield === "function" ? sched.yield() : new Promise((res) => setTimeout(res, 0));
};

let canvasMeasureFn: Measure | null | undefined;
/** A canvas measureText probe (null where there is no real canvas, e.g. jsdom). */
export function canvasMeasure(): Measure | null {
  if (canvasMeasureFn !== undefined) return canvasMeasureFn;
  canvasMeasureFn = null;
  if (typeof document === "undefined" || /jsdom|happydom/i.test(navigator.userAgent)) return null;
  let ctx: CanvasRenderingContext2D | null = null;
  try { ctx = document.createElement("canvas").getContext("2d"); } catch { ctx = null; }
  if (!ctx || typeof ctx.measureText !== "function") return null;
  const c = ctx;
  canvasMeasureFn = (font, text) => {
    c.font = "10px serif";
    c.font = font;
    if (c.font === "10px serif") return null; // the font string was rejected
    const m = c.measureText(text);
    return [m.width, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent, m.actualBoundingBoxLeft, m.actualBoundingBoxRight];
  };
  return canvasMeasureFn;
}

// Session-wide detection cache shared by every editor.
const sessionCache: DetectCache = new Map();

/** Fonts defined by @font-face in this page (embedded document fonts, loaded web fonts). */
export function faceFamilies(): Set<string> {
  const out = new Set<string>();
  const fs = typeof document !== "undefined" ? (document.fonts as unknown as Iterable<FontFace> | undefined) : undefined;
  if (!fs || typeof (fs as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== "function") return out;
  for (const f of fs) out.add(f.family.replace(/^["']|["']$/g, "").toLowerCase());
  return out;
}

/** Whether the browser can draw `name`: a page font face or an installed one. Unknown = true. */
export function canDraw(name: string, measure: Measure | null = canvasMeasure()): boolean {
  if (faceFamilies().has(name.toLowerCase())) return true;
  if (!measure) return true; // cannot tell: do not hide anything
  return fontPresent(name, measure, sessionCache);
}

/** Probe a candidate list (cached for the session). */
let localDetect: Promise<string[]> | null = null;
export function detectInstalled(candidates: readonly string[], measure: Measure | null = canvasMeasure()): Promise<string[]> {
  if (!measure) return Promise.resolve([]);
  if (!localDetect) localDetect = detectFontsAsync([...new Set(candidates)], measure, sessionCache);
  return localDetect;
}

/** One entry of queryLocalFonts(). */
export interface LocalFontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob(): Promise<Blob>;
}

/** The Local Font Access API is present (Chromium desktop). */
export const hasLocalFontAccess = (): boolean =>
  typeof window !== "undefined" && typeof (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts === "function";

/** "granted" | "prompt" | "denied", or null when it cannot be asked. Never prompts. */
export async function localFontsPermission(): Promise<PermissionState | null> {
  try {
    const s = await navigator.permissions.query({ name: "local-fonts" as PermissionName });
    return s.state;
  } catch {
    return null;
  }
}

/** queryLocalFonts() (prompts unless granted: call it from a user gesture); null when refused. */
export async function queryLocalFonts(): Promise<LocalFontData[] | null> {
  if (!hasLocalFontAccess()) return null;
  try {
    return await (window as unknown as { queryLocalFonts: () => Promise<LocalFontData[]> }).queryLocalFonts();
  } catch {
    return null;
  }
}

/** Installed family names via queryLocalFonts (prompts unless already granted); null when refused. */
export async function queryLocalFamilies(): Promise<string[] | null> {
  const list = await queryLocalFonts();
  return list ? mergeNames(list.map((f) => f.family).filter((f) => f && !f.startsWith("."))) : null;
}

/** De-duplicated (case-insensitive, first spelling kept) and sorted. */
export function mergeNames(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Map<string, string>();
  for (const l of lists) for (const n of l) {
    const name = n.trim();
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export interface FontGroups {
  /** Fonts the document uses, with whether the browser can draw them. */
  doc: { name: string; missing: boolean }[];
  /** Every other usable font. */
  fonts: string[];
}

/** Split a picker into the document's fonts and the rest; base fonts are kept only if drawable. */
export function buildFontGroups(input: {
  docFonts: readonly string[];
  base: readonly string[];
  extra: readonly string[]; // already known to be usable (local, added web fonts)
  canDraw: (name: string) => boolean;
}): FontGroups {
  const doc = mergeNames(input.docFonts).map((name) => ({ name, missing: !input.canDraw(name) }));
  const inDoc = new Set(doc.map((d) => d.name.toLowerCase()));
  const fonts = mergeNames(input.base.filter((f) => input.canDraw(f)), input.extra).filter((f) => !inDoc.has(f.toLowerCase()));
  return { doc, fonts };
}
