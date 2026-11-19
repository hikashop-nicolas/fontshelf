// Font files as bytes, for engines that shape or embed fonts themselves (WebGL slides, PDF,
// libass). Local: queryLocalFonts() blobs. Remote: plain TTF/OTF from the google/fonts repo.
import { findWebFont } from "./catalog.js";
import { FONT_FILES, type CatalogFileTuple } from "./catalog-files.js";
import { hasLocalFontAccess, localFontsPermission, queryLocalFonts, type LocalFontData } from "./detect.js";
import { instanceFont, instanceLocation, locationKey } from "./instance.js";
import { embeddableOf, parseAxes, parseFontInfo, type Embedding, type FontFormat } from "./sfnt.js";
import { remoteAllowed } from "./shared.js";

// The google/fonts commit gen-catalog read (see catalog-files.ts); move both together.
export const GOOGLE_FONTS_RAW = "https://raw.githubusercontent.com/google/fonts/cc5661d43cd4f9aad5567033a8e15ca28dc35c86";

/** One file of a catalog family in the google/fonts repository. */
export interface CatalogFile {
  file: string;
  url: string;
  /** Weight range; equal ends for a static face. */
  weight: [number, number];
  italic: boolean;
  /** Variable font (covers the weight range in one file). */
  variable: boolean;
  /** Download size, so a UI can warn before fetching a large CJK file. */
  bytes: number;
}

export interface CatalogFamilyFiles {
  family: string;
  license: "ofl" | "apache" | "ufl";
  /** "ofl/notosansjp" */
  dir: string;
  files: CatalogFile[];
}

const toFile = (path: string, t: CatalogFileTuple): CatalogFile => ({
  file: t[0],
  url: `${GOOGLE_FONTS_RAW}/${path}/${encodeURIComponent(t[0])}`,
  weight: [t[1], t[2]],
  italic: t[3] === 1,
  variable: t[0].includes("["),
  bytes: t[4],
});

/** The repository files of a catalog family, or undefined outside the catalog. */
export function catalogFiles(family: string): CatalogFamilyFiles | undefined {
  const wf = findWebFont(family);
  const entry = wf && FONT_FILES[wf.family];
  if (!wf || !entry) return undefined;
  const [path, files] = entry;
  return { family: wf.family, license: path.split("/")[0] as CatalogFamilyFiles["license"], dir: path, files: files.map((t) => toFile(path, t)) };
}

/** The file to download for a weight/style: right italic first, then the nearest weight. */
export function pickCatalogFile(files: readonly CatalogFile[], weight = 400, italic = false): CatalogFile | undefined {
  let best: CatalogFile | undefined;
  let bestScore = Infinity;
  for (const f of files) {
    const dist = weight < f.weight[0] ? f.weight[0] - weight : weight > f.weight[1] ? weight - f.weight[1] : 0;
    const score = (f.italic === italic ? 0 : 10000) + dist;
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
  /** Weight of the file returned: a [min, max] range for a remote variable file, else OS/2 usWeightClass. */
  weight: number | [number, number] | null;
  italic: boolean;
  variable: boolean;
  postscriptName: string | null;
  fullName: string | null;
  /** Index in a .ttc collection. */
  index: number;
  /** Remote only: the URL and the license directory. */
  url?: string;
  license?: CatalogFamilyFiles["license"];
  /** Set on a static instance made with `instance: true`: the source URL ("local:<PostScript name>" for a local font). */
  instancedFrom?: string;
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
  /** Variable file: return a static instance pinned at weight/italic (loads HarfBuzz once). */
  instance?: boolean;
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

const CACHE_NAME = "fontshelf-files-v1";
const memory = new Map<string, Uint8Array>();
const inflight = new Map<string, Promise<Uint8Array | null>>();

async function cacheGet(url: string): Promise<Uint8Array | null> {
  const hit = memory.get(url);
  if (hit) return hit;
  try {
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
  // A variable file's OS/2 weight is its default instance (Noto Sans JP: 100), so give the range.
  if (file.variable) out.weight = file.weight;
  else if (out.weight === null) out.weight = file.weight[0];
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
 * permission), then the catalog file from the google/fonts repository when remote is allowed.
 * Null when neither is available (a family found only by canvas probing has no bytes).
 */
export async function getFontFile(family: string, opts: GetFontFileOptions = {}): Promise<FontFile | null> {
  const o = { weight: 400, italic: false, ...opts };
  let f: FontFile | null = null;
  if (o.local !== false) f = await localFile(family, o);
  if (!f && o.remote !== false) f = await remoteFile(family, o);
  return f && o.instance && f.variable ? instanceFile(f, o.weight, o.italic) : f;
}

// --- static instances ---------------------------------------------------------------------------

const instances = new Map<string, Promise<FontFile | null>>();

/** A synthetic Cache Storage key for an instance; never fetched. */
const instanceCacheUrl = (key: string) => `https://fontshelf.invalid/instance?k=${encodeURIComponent(key)}`;

/** The static instance of a variable FontFile, cached by source and axis location; the source itself when instancing fails. */
async function instanceFile(f: FontFile, weight: number, italic: boolean): Promise<FontFile> {
  const from = f.url ?? `local:${f.postscriptName ?? f.fullName ?? f.family}:${f.bytes.byteLength}`;
  const loc = instanceLocation(parseAxes(f.bytes, f.index), weight, italic);
  const key = `${from}#${locationKey(loc)}`;
  let run = instances.get(key);
  if (!run) {
    run = (async () => {
      // Only catalog instances go to Cache Storage; installed fonts stay in memory.
      let bytes = f.url ? await cacheGet(instanceCacheUrl(key)) : null;
      if (!bytes) {
        const inst = await instanceFont(f.bytes, { weight, italic, index: f.index, family: f.family });
        if (!inst) return null;
        bytes = inst.bytes;
        if (f.url) await cachePut(instanceCacheUrl(key), bytes);
      }
      const out = describe(bytes, f.family, f.source);
      if (!out) return null;
      out.weight = loc.wght ?? out.weight;
      if (f.url) out.url = f.url;
      if (f.license) out.license = f.license;
      out.instancedFrom = f.url ?? `local:${f.postscriptName ?? f.family}`;
      return out;
    })();
    instances.set(key, run);
    run.then((r) => { if (!r) instances.delete(key); }, () => instances.delete(key));
  }
  return (await run.catch(() => null)) ?? f;
}
