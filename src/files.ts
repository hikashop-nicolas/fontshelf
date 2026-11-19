// Font files as bytes, for engines that shape or embed fonts themselves (WebGL slides, PDF,
// libass). Local: queryLocalFonts() blobs. Remote: Google Fonts' static TTFs on fonts.gstatic.com.
import { findWebFont } from "./catalog.js";
import { FONT_FILES, type CatalogFileTuple } from "./catalog-files.js";
import { hasLocalFontAccess, localFontsPermission, queryLocalFonts, type LocalFontData } from "./detect.js";
import { embeddableOf, parseFontInfo, type Embedding, type FontFormat } from "./sfnt.js";
import { remoteAllowed } from "./shared.js";

/** Where the catalog's static TTF files live (paths in catalog-files.ts are relative to it). */
export const GSTATIC_FONTS = "https://fonts.gstatic.com/s/";

/** One static TTF of a catalog family, as served by Google Fonts. */
export interface CatalogFile {
  url: string;
  weight: number;
  italic: boolean;
  /** File size, so a UI can warn before fetching a large CJK file. */
  bytes: number;
}

export interface CatalogFamilyFiles {
  family: string;
  license: "ofl" | "apache" | "ufl";
  files: CatalogFile[];
}

const toFile = (t: CatalogFileTuple): CatalogFile => ({ url: GSTATIC_FONTS + t[0], weight: t[1], italic: t[2] === 1, bytes: t[3] });

/** The static files of a catalog family, or undefined outside the catalog. */
export function catalogFiles(family: string): CatalogFamilyFiles | undefined {
  const wf = findWebFont(family);
  const entry = wf && FONT_FILES[wf.family];
  if (!wf || !entry) return undefined;
  return { family: wf.family, license: entry[0] as CatalogFamilyFiles["license"], files: entry[1].map(toFile) };
}

/** The file to download for a weight/style: right italic first, then the nearest weight (heavier on a tie). */
export function pickCatalogFile(files: readonly CatalogFile[], weight = 400, italic = false): CatalogFile | undefined {
  let best: CatalogFile | undefined;
  let bestScore = Infinity;
  for (const f of files) {
    const d = f.weight - weight;
    const score = (f.italic === italic ? 0 : 10000) + Math.abs(d) * 2 - (d > 0 ? 1 : 0);
    if (score < bestScore) { best = f; bestScore = score; }
  }
  return best;
}

export interface FontFile {
  bytes: Uint8Array;
  /** The family asked for, in its canonical spelling when known. */
  family: string;
  source: "local" | "remote";
  format: FontFormat;
  /** true: may be embedded; "restricted": the font forbids embedding; false: not usable (bitmap only, unreadable). */
  embeddable: boolean | "restricted";
  embedding: Embedding;
  /** The font must be embedded whole, not subset (fsType bit 8). */
  noSubsetting: boolean;
  /** OS/2 usWeightClass (the catalog weight for a remote file). */
  weight: number | null;
  italic: boolean;
  /** An installed variable font comes back as is. */
  variable: boolean;
  postscriptName: string | null;
  fullName: string | null;
  /** Index in a .ttc collection. */
  index: number;
  /** Remote only: the URL and the license. */
  url?: string;
  license?: CatalogFamilyFiles["license"];
}

export interface GetFontFileOptions {
  weight?: number;
  italic?: boolean;
  /** Try the installed font (default true). */
  local?: boolean;
  /** Try the catalog download (default true; still needs remoteAllowed()). */
  remote?: boolean;
  /** Called from a user gesture: queryLocalFonts may show its permission prompt. */
  gesture?: boolean;
  /** Byte fetcher for tests or a host proxy. */
  fetchBytes?: (url: string) => Promise<Uint8Array | null>;
}

// --- local --------------------------------------------------------------------------------------

/** Weight and italic from a style name such as "Bold Italic", "W6", "SemiBold". */
export function styleOf(style: string): { weight: number; italic: boolean } {
  const s = style.toLowerCase().replace(/[\s_-]+/g, "");
  const italic = /italic|oblique|kursiv/.test(s);
  const w = s.match(/w(\d)\b|w(\d)$/);
  if (w) return { weight: Number(w[1] ?? w[2]) * 100, italic };
  const table: [RegExp, number][] = [
    [/hairline|thin/, 100], [/extralight|ultralight/, 200], [/semilight|demilight/, 350], [/light/, 300],
    [/semibold|demibold|demi/, 600], [/extrabold|ultrabold|heavy/, 800], [/black|ultra/, 900],
    [/bold/, 700], [/medium/, 500], [/book/, 400],
  ];
  for (const [re, n] of table) if (re.test(s)) return { weight: n, italic };
  return { weight: 400, italic };
}

/** The local face of `family` closest to weight/italic; also matches a full or PostScript name. */
export function pickLocalFace<T extends Pick<LocalFontData, "family" | "fullName" | "postscriptName" | "style">>(
  fonts: readonly T[], family: string, weight = 400, italic = false,
): T | undefined {
  const key = family.trim().toLowerCase();
  const exact = fonts.filter((f) => f.fullName.toLowerCase() === key || f.postscriptName.toLowerCase() === key);
  const cands = fonts.filter((f) => f.family.toLowerCase() === key);
  if (!cands.length) return exact[0];
  let best: T | undefined;
  let bestScore = Infinity;
  for (const f of cands) {
    const st = styleOf(f.style);
    const score = (st.italic === italic ? 0 : 10000) + Math.abs(st.weight - weight) + (/condensed|narrow|expanded|wide/i.test(f.style) ? 50 : 0);
    if (score < bestScore) { best = f; bestScore = score; }
  }
  return best;
}

async function localFile(family: string, o: GetFontFileOptions): Promise<FontFile | null> {
  if (!hasLocalFontAccess()) return null;
  if (!o.gesture && (await localFontsPermission()) !== "granted") return null; // never prompt silently
  const list = await queryLocalFonts();
  const face = list && pickLocalFace(list, family, o.weight, o.italic);
  if (!face) return null;
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await (await face.blob()).arrayBuffer()); } catch { return null; }
  return describe(bytes, face.family, "local", face.postscriptName);
}

// --- remote -------------------------------------------------------------------------------------

const CACHE_NAME = "fontshelf-files-v2";
// v1 held google/fonts GitHub files and HarfBuzz instances: dropped once.
const OLD_CACHES = ["fontshelf-files-v1"];
let pruned: Promise<void> | null = null;
const pruneOld = (): Promise<void> => (pruned ??= (async () => {
  try { for (const n of OLD_CACHES) await caches.delete(n); } catch { /* no Cache Storage */ }
})());

const memory = new Map<string, Uint8Array>();
const inflight = new Map<string, Promise<Uint8Array | null>>();

async function cacheGet(url: string): Promise<Uint8Array | null> {
  const hit = memory.get(url);
  if (hit) return hit;
  try {
    void pruneOld();
    const c = await caches.open(CACHE_NAME);
    const res = await c.match(url);
    if (res) {
      const b = new Uint8Array(await res.arrayBuffer());
      memory.set(url, b);
      return b;
    }
  } catch { /* no Cache Storage (insecure origin, private mode, tests) */ }
  return null;
}

async function cachePut(url: string, bytes: Uint8Array): Promise<void> {
  memory.set(url, bytes);
  try {
    const c = await caches.open(CACHE_NAME);
    await c.put(url, new Response(bytes as BlobPart, { headers: { "content-type": "font/ttf" } }));
  } catch { /* the memory copy still serves this session */ }
}

const defaultFetchBytes = async (url: string): Promise<Uint8Array | null> => {
  const res = await fetch(url, { mode: "cors", credentials: "omit" });
  return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
};

/** Download (or reuse from cache) a URL's bytes. Null without consent, offline, or on HTTP errors. */
export function fetchFontBytes(url: string, fetchBytes = defaultFetchBytes): Promise<Uint8Array | null> {
  const run = inflight.get(url);
  if (run) return run;
  const p = (async () => {
    const cached = await cacheGet(url);
    if (cached) return cached;
    if (!remoteAllowed()) return null;
    try {
      const b = await fetchBytes(url);
      if (b && b.byteLength) await cachePut(url, b);
      return b && b.byteLength ? b : null;
    } catch {
      return null;
    }
  })();
  inflight.set(url, p);
  p.finally(() => inflight.delete(url));
  return p;
}

/** Whether this file is already downloaded (memory or Cache Storage); never hits the network. */
export async function isFontFileCached(url: string): Promise<boolean> {
  return !!(await cacheGet(url));
}

async function remoteFile(family: string, o: GetFontFileOptions): Promise<FontFile | null> {
  const cat = catalogFiles(family);
  const file = cat && pickCatalogFile(cat.files, o.weight, o.italic);
  if (!cat || !file) return null;
  const bytes = await fetchFontBytes(file.url, o.fetchBytes);
  if (!bytes) return null;
  const out = describe(bytes, cat.family, "remote");
  if (!out) return null;
  out.url = file.url;
  out.license = cat.license;
  out.weight = file.weight;
  return out;
}

function describe(bytes: Uint8Array, family: string, source: FontFile["source"], postscriptName?: string): FontFile | null {
  let index = 0;
  let info = parseFontInfo(bytes);
  if (!info) return null;
  // A collection: point at the face that was asked for.
  for (let i = 1; postscriptName && info.format === "ttc" && info.postscriptName !== postscriptName && i < info.numFonts; i++) {
    const next = parseFontInfo(bytes, i);
    if (next?.postscriptName === postscriptName) { info = next; index = i; }
  }
  const usable = info.format !== "woff" && info.format !== "woff2";
  return {
    bytes, family, source, format: info.format,
    embeddable: usable ? embeddableOf(info) : false,
    embedding: info.embedding, noSubsetting: info.noSubsetting,
    weight: info.weight, italic: info.italic, variable: info.variable,
    postscriptName: info.postscriptName, fullName: info.fullName, index,
  };
}

/**
 * The bytes of a font file for `family`: the installed font first (Chromium with local-fonts
 * permission), then the catalog's static TTF from Google Fonts when remote is allowed.
 * Null when neither is available (a family found only by canvas probing has no bytes).
 */
export async function getFontFile(family: string, opts: GetFontFileOptions = {}): Promise<FontFile | null> {
  const o = { weight: 400, italic: false, ...opts };
  let f: FontFile | null = null;
  if (o.local !== false) f = await localFile(family, o);
  if (!f && o.remote !== false) f = await remoteFile(family, o);
  return f;
}
