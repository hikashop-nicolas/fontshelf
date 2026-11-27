// Fonts the user loads from a file (.ttf, .otf, .ttc, .woff, .woff2): parsed, drawn in the page
// with FontFace, served to engines through getFontFile, and kept in IndexedDB for later sessions.
import { mergeNames } from "./detect.js";
import { styleOf } from "./files.js";
import { emit, shared } from "./shared.js";
import { embeddableOf, parseFontInfo, type Embedding, type FontFormat, type FontInfo } from "./sfnt.js";
import { extractFace, woff2Tables, woffToSfnt } from "./woff.js";

/** Larger files are refused. */
export const MAX_FONT_FILE_BYTES = 50 * 1024 * 1024;
/** Kept across sessions up to this total; past it a file works for this session only. */
export const MAX_STORED_FONT_BYTES = 200 * 1024 * 1024;

/** One face found in a file, before it is loaded. */
export interface FontFileFace {
  index: number;
  family: string;
  style: string;
  weight: number;
  italic: boolean;
  fullName: string | null;
  postscriptName: string | null;
}

/** A face the user loaded. */
export interface LoadedFont extends FontFileFace {
  /** The stored file it comes from. */
  fileId: string;
  fileName: string;
  /** The format of the file as given (a WOFF is kept converted to its sfnt). */
  format: FontFormat;
  embedding: Embedding;
  embeddable: boolean | "restricted";
  noSubsetting: boolean;
  variable: boolean;
  scripts: string[];
  /** Kept in IndexedDB for later sessions. */
  persisted: boolean;
}

export type LoadFontError = "invalid" | "too-big";

export type LoadFontResult =
  | { ok: true; family: string; fonts: LoadedFont[]; persisted: boolean }
  | { ok: false; error: LoadFontError };

interface StoredFile { id: string; name: string; bytes: Uint8Array; faces: number[]; size: number; added: number }

interface Face extends LoadedFont { bytes: Uint8Array; css?: FontFace }

interface LoadedState { faces: Face[]; restoring: Promise<number> | null }

const KEY = Symbol.for("fontshelf.loaded.v1");
const state = (): LoadedState => {
  const g = globalThis as unknown as Record<symbol, LoadedState | undefined>;
  return (g[KEY] ??= { faces: [], restoring: null });
};

// --- parsing -------------------------------------------------------------------------------------

interface Parsed { bytes: Uint8Array; format: FontFormat; faces: { index: number; info: FontInfo }[] }

const baseName = (name: string): string => name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Font";

// Words a file name adds to the family ("cinzel-latin-900-normal.woff2", "Inter-BoldItalic.woff2").
const FILE_NOISE = /^(\d+|normal|regular|italic|oblique|bold|bolditalic|light|medium|semibold|black|thin|extrabold|extralight|variable|var|vf|webfont|latin|ext|cyrillic|greek|vietnamese|subset|roman|wght)$/i;

/** Family, weight and italic guessed from a file name, for a WOFF2 whose names cannot be read. */
export function nameFromFile(name: string): { family: string; weight: number; italic: boolean } {
  const words = name.replace(/\.[^.]+$/, "").split(/[\s_.-]+/).filter(Boolean);
  const kept = words.filter((w) => !FILE_NOISE.test(w));
  const num = words.find((w) => /^[1-9]00$/.test(w));
  const rest = words.filter((w) => FILE_NOISE.test(w)).join(" ");
  const st = num ? { weight: Number(num), italic: /italic|oblique/i.test(rest) } : styleOf(rest);
  const family = (kept.length ? kept : words).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || "Font";
  return { family, ...st };
}

async function parseFile(raw: Uint8Array, name: string): Promise<Parsed | null> {
  const first = parseFontInfo(raw);
  if (!first) return null;
  if (first.format === "woff") {
    const sfnt = await woffToSfnt(raw);
    const info = sfnt && parseFontInfo(sfnt);
    return sfnt && info ? { bytes: sfnt, format: "woff", faces: [{ index: 0, info }] } : null;
  }
  if (first.format === "woff2") {
    // Names need Brotli; without it the file name stands in.
    const t = await woff2Tables(raw);
    const info = (t && parseFontInfo(t)) || (({ family, weight, italic }) => ({ ...first, family, weight, italic }))(nameFromFile(name));
    return { bytes: raw, format: "woff2", faces: [{ index: 0, info: { ...info, format: "woff2" } }] };
  }
  const faces = [{ index: 0, info: first }];
  for (let i = 1; i < first.numFonts; i++) {
    const info = parseFontInfo(raw, i);
    if (info) faces.push({ index: i, info });
  }
  return { bytes: raw, format: first.format, faces };
}

const toFace = (index: number, info: FontInfo, name: string): FontFileFace => ({
  index,
  family: info.family?.trim() || baseName(name),
  style: info.style ?? (info.italic ? "Italic" : "Regular"),
  weight: info.weight && info.weight >= 1 && info.weight <= 1000 ? info.weight : 400,
  italic: info.italic,
  fullName: info.fullName,
  postscriptName: info.postscriptName,
});

const toBytes = async (src: Blob | Uint8Array): Promise<Uint8Array> =>
  src instanceof Uint8Array ? src : new Uint8Array(await src.arrayBuffer());

/** The faces in a font file (one, or each face of a .ttc), or null when it is not a font. */
export async function readFontFaces(src: Blob | Uint8Array, name = ""): Promise<FontFileFace[] | null> {
  const p = await parseFile(await toBytes(src), name);
  return p && p.faces.map((f) => toFace(f.index, f.info, name));
}

// --- storage -------------------------------------------------------------------------------------

const DB = "fontshelf";
const STORE = "loaded";

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = globalThis.indexedDB?.open(DB, 1);
      if (!req) return resolve(null);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: "id" }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<T | null>((resolve) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

const allStored = async (): Promise<StoredFile[]> => (await withStore("readonly", (s) => s.getAll() as IDBRequest<StoredFile[]>)) ?? [];

// FNV-1a over the bytes plus the size: the same file loaded twice is stored once.
function fileId(b: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193);
  return `${(h >>> 0).toString(16)}-${b.length.toString(16)}`;
}

// --- registration --------------------------------------------------------------------------------

async function drawInPage(f: Face): Promise<void> {
  if (typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts) return;
  try {
    const css = new FontFace(f.family, f.bytes as BufferSource, { weight: String(f.weight), style: f.italic ? "italic" : "normal" });
    await css.load();
    document.fonts.add(css);
    f.css = css;
  } catch { /* the browser refused the file; engines may still read it */ }
}

async function register(p: Parsed, id: string, name: string, indexes: readonly number[], persisted: boolean): Promise<LoadedFont[]> {
  const st = state();
  const out: LoadedFont[] = [];
  for (const { index, info } of p.faces) {
    if (!indexes.includes(index)) continue;
    const known = st.faces.find((f) => f.fileId === id && f.index === index);
    if (known) { known.persisted ||= persisted; out.push(publicOf(known)); continue; }
    const bytes = p.format === "ttc" ? extractFace(p.bytes, index) : p.bytes;
    if (!bytes) continue;
    const face: Face = {
      ...toFace(index, info, name), fileId: id, fileName: name, format: p.format,
      embedding: info.embedding, embeddable: p.format === "woff2" ? false : embeddableOf(info),
      noSubsetting: info.noSubsetting, variable: info.variable, scripts: info.scripts, persisted, bytes,
    };
    await drawInPage(face);
    st.faces.push(face);
    shared().added.set(face.family.toLowerCase(), face.family);
    out.push(publicOf(face));
  }
  if (out.length) emit();
  return out;
}

const publicOf = (f: Face): LoadedFont => {
  const { bytes: _b, css: _c, ...rest } = f;
  return { ...rest, scripts: [...rest.scripts] };
};

/**
 * Load a font file: every face, or only `faces` (indexes in a .ttc). Usable at once in the page
 * (FontFace) and through getFontFile; kept for later sessions unless `persist` is false or the
 * store is full (`persisted: false`).
 */
export async function loadFontFile(
  src: Blob | Uint8Array, opts: { name?: string; faces?: readonly number[]; persist?: boolean } = {},
): Promise<LoadFontResult> {
  const name = opts.name ?? (src instanceof Blob && "name" in src ? String((src as File).name) : "");
  const size = src instanceof Uint8Array ? src.byteLength : src.size;
  if (size > MAX_FONT_FILE_BYTES) return { ok: false, error: "too-big" };
  const raw = await toBytes(src);
  const p = await parseFile(raw, name);
  if (!p) return { ok: false, error: "invalid" };
  const indexes = opts.faces?.length ? opts.faces : p.faces.map((f) => f.index);
  const id = fileId(raw);
  let persisted = false;
  if (opts.persist !== false) {
    const stored = await allStored();
    const same = stored.find((r) => r.id === id);
    const faces = [...new Set([...(same?.faces ?? []), ...indexes])].sort((a, b) => a - b);
    const used = stored.reduce((n, r) => n + (r.id === id ? 0 : r.size), 0);
    if (used + p.bytes.byteLength <= MAX_STORED_FONT_BYTES) {
      const rec: StoredFile = { id, name, bytes: p.bytes, faces, size: p.bytes.byteLength, added: same?.added ?? Date.now() };
      persisted = (await withStore("readwrite", (s) => s.put(rec))) !== null;
    }
  }
  const fonts = await register(p, id, name, indexes, persisted);
  if (!fonts.length) return { ok: false, error: "invalid" };
  return { ok: true, family: fonts[0]!.family, fonts, persisted };
}

/** Bring back the files loaded in earlier sessions (once per page). Resolves with the face count. */
export function restoreLoadedFonts(): Promise<number> {
  const st = state();
  return (st.restoring ??= (async () => {
    let n = 0;
    for (const rec of await allStored()) {
      const p = await parseFile(rec.bytes, rec.name);
      if (p) n += (await register(p, rec.id, rec.name, rec.faces, true)).length;
    }
    return n;
  })());
}

/** The faces loaded from files, in load order. */
export const getLoadedFonts = (): LoadedFont[] => state().faces.map(publicOf);

/** Families loaded from files. */
export const loadedFamilies = (): string[] => mergeNames(state().faces.map((f) => f.family));

/** Forget a loaded family: out of the page, the picker and the store. */
export async function removeLoadedFont(family: string): Promise<void> {
  const st = state();
  const key = family.toLowerCase();
  const gone = st.faces.filter((f) => f.family.toLowerCase() === key);
  if (!gone.length) return;
  st.faces = st.faces.filter((f) => !gone.includes(f));
  for (const f of gone) if (f.css) try { document.fonts.delete(f.css); } catch { /* already gone */ }
  shared().added.delete(key);
  for (const id of new Set(gone.map((f) => f.fileId))) {
    const left = st.faces.filter((f) => f.fileId === id).map((f) => f.index);
    const recs = await allStored();
    const rec = recs.find((r) => r.id === id);
    if (!rec) continue;
    if (left.length) await withStore("readwrite", (s) => s.put({ ...rec, faces: left }));
    else await withStore("readwrite", (s) => s.delete(id));
  }
  emit();
}

/** The loaded face of `family` closest to weight/italic, with sfnt bytes engines can read (WOFF2 excluded). */
export function loadedFace(family: string, weight = 400, italic = false): (LoadedFont & { bytes: Uint8Array }) | null {
  const key = family.trim().toLowerCase();
  let best: Face | undefined;
  let bestScore = Infinity;
  for (const f of state().faces) {
    if (f.format === "woff2") continue;
    if (f.family.toLowerCase() !== key && f.fullName?.toLowerCase() !== key && f.postscriptName?.toLowerCase() !== key) continue;
    const d = f.weight - weight;
    const score = (f.italic === italic ? 0 : 10000) + Math.abs(d) * 2 - (d > 0 ? 1 : 0);
    if (score < bestScore) { best = f; bestScore = score; }
  }
  return best ? { ...publicOf(best), bytes: best.bytes } : null;
}
