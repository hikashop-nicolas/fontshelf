// A small sfnt reader: container format (TTF / OTF / TTC / WOFF), the OS/2 embedding bits,
// weight and italic, the names, and whether the font is variable. Pure, no DOM.

export type FontFormat = "ttf" | "otf" | "ttc" | "woff" | "woff2";

/** OS/2 fsType usage permission, least restrictive first. */
export type Embedding = "installable" | "editable" | "preview-print" | "restricted";

export interface FontInfo {
  format: FontFormat;
  /** Faces in a collection (1 for a single font). */
  numFonts: number;
  /** OS/2 fsType, or null without an OS/2 table (treated as installable). */
  fsType: number | null;
  embedding: Embedding;
  /** fsType bit 8: the font must be embedded whole. */
  noSubsetting: boolean;
  /** fsType bit 9: only bitmaps may be embedded, no outlines. */
  bitmapOnly: boolean;
  weight: number | null;
  italic: boolean;
  variable: boolean;
  family: string | null;
  fullName: string | null;
  postscriptName: string | null;
}

const tag = (v: DataView, o: number): string =>
  String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

/** The usage permission an fsType grants (several bits set: the least restrictive wins). */
export function embeddingOf(fsType: number | null): Embedding {
  if (fsType === null) return "installable";
  const bits = fsType & 0x000f;
  if (bits === 0) return "installable";
  if (bits & 0x0008) return "editable";
  if (bits & 0x0004) return "preview-print";
  if (bits & 0x0002) return "restricted";
  return "installable"; // only the reserved bit 0 set
}

/** True when the font may be embedded in a document (PDF, subtitles); "restricted" when not. */
export function embeddableOf(info: Pick<FontInfo, "embedding" | "bitmapOnly">): boolean | "restricted" {
  if (info.embedding === "restricted") return "restricted";
  return !info.bitmapOnly;
}

function readName(v: DataView, off: number, len: number): Partial<Record<number, string>> {
  const out: Partial<Record<number, string>> = {};
  const rank: Partial<Record<number, number>> = {};
  if (len < 6) return out;
  const count = v.getUint16(off + 2);
  const strings = off + v.getUint16(off + 4);
  for (let i = 0; i < count; i++) {
    const r = off + 6 + i * 12;
    if (r + 12 > off + len) break;
    const platform = v.getUint16(r);
    const lang = v.getUint16(r + 4);
    const id = v.getUint16(r + 6);
    const n = v.getUint16(r + 8);
    const s = strings + v.getUint16(r + 10);
    if (![1, 4, 6, 16].includes(id) || s + n > v.byteLength) continue;
    // Prefer Windows English, then any Unicode entry, then Mac Roman.
    const score = platform === 3 ? (lang === 0x409 ? 3 : 2) : platform === 0 ? 2 : platform === 1 && lang === 0 ? 1 : 0;
    if (!score || (rank[id] ?? 0) >= score) continue;
    let str = "";
    if (platform === 1) for (let k = 0; k < n; k++) str += String.fromCharCode(v.getUint8(s + k));
    else for (let k = 0; k + 1 < n; k += 2) str += String.fromCharCode(v.getUint16(s + k));
    out[id] = str;
    rank[id] = score;
  }
  return out;
}

/** One fvar axis: tag ("wght", "ital", "slnt", "wdth", "opsz"...) and its range. */
export interface FontAxis {
  tag: string;
  min: number;
  default: number;
  max: number;
}

/** Offset of the `index`-th font's table directory and its tables, or null when not an sfnt. */
export function sfntTables(bytes: Uint8Array, index = 0): { offset: number; tables: Map<string, { o: number; n: number }> } | null {
  if (bytes.byteLength < 12) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  if (tag(v, 0) === "ttcf") {
    if (index >= v.getUint32(8) || 12 + index * 4 + 4 > v.byteLength) return null;
    off = v.getUint32(12 + index * 4);
    if (off + 12 > v.byteLength) return null;
  }
  const ver = v.getUint32(off);
  if (ver !== 0x4f54544f && ver !== 0x00010000 && ver !== 0x74727565) return null;
  const tables = new Map<string, { o: number; n: number }>();
  const numTables = v.getUint16(off + 4);
  for (let i = 0; i < numTables; i++) {
    const r = off + 12 + i * 16;
    if (r + 16 > v.byteLength) return null;
    const o = v.getUint32(r + 8);
    const n = v.getUint32(r + 12);
    if (o + n <= v.byteLength) tables.set(tag(v, r), { o, n });
  }
  return { offset: off, tables };
}

/** The variation axes of a font (empty for a static font). */
export function parseAxes(bytes: Uint8Array, index = 0): FontAxis[] {
  const fvar = sfntTables(bytes, index)?.tables.get("fvar");
  if (!fvar || fvar.n < 16) return [];
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const first = fvar.o + v.getUint16(fvar.o + 4);
  const count = v.getUint16(fvar.o + 8);
  const size = v.getUint16(fvar.o + 10);
  const out: FontAxis[] = [];
  const fixed = (o: number) => v.getInt32(o) / 65536;
  for (let i = 0; i < count; i++) {
    const r = first + i * size;
    if (size < 20 || r + 20 > fvar.o + fvar.n) break;
    out.push({ tag: tag(v, r), min: fixed(r + 4), default: fixed(r + 8), max: fixed(r + 12) });
  }
  return out;
}

/** Parse one font (the `index`-th of a collection). Null when the bytes are not a font. */
export function parseFontInfo(bytes: Uint8Array, index = 0): FontInfo | null {
  if (bytes.byteLength < 12) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = tag(v, 0);
  const base: FontInfo = {
    format: "ttf", numFonts: 1, fsType: null, embedding: "installable", noSubsetting: false, bitmapOnly: false,
    weight: null, italic: false, variable: false, family: null, fullName: null, postscriptName: null,
  };
  if (head === "wOFF" || head === "wOF2") return { ...base, format: head === "wOFF" ? "woff" : "woff2" };
  let off = 0;
  if (head === "ttcf") {
    base.format = "ttc";
    base.numFonts = v.getUint32(8);
    if (index >= base.numFonts || 12 + index * 4 + 4 > v.byteLength) return null;
    off = v.getUint32(12 + index * 4);
    if (off + 12 > v.byteLength) return null;
  }
  const ver = v.getUint32(off);
  if (ver === 0x4f54544f) { if (base.format !== "ttc") base.format = "otf"; }
  else if (ver !== 0x00010000 && ver !== 0x74727565) return null; // 1.0 or 'true'
  const numTables = v.getUint16(off + 4);
  const tables = new Map<string, { o: number; n: number }>();
  for (let i = 0; i < numTables; i++) {
    const r = off + 12 + i * 16;
    if (r + 16 > v.byteLength) return null;
    const o = v.getUint32(r + 8);
    const n = v.getUint32(r + 12);
    if (o + n <= v.byteLength) tables.set(tag(v, r), { o, n });
  }
  base.variable = tables.has("fvar");
  const os2 = tables.get("OS/2");
  if (os2 && os2.n >= 10) {
    base.weight = v.getUint16(os2.o + 4);
    base.fsType = v.getUint16(os2.o + 8);
    base.noSubsetting = (base.fsType & 0x0100) !== 0;
    base.bitmapOnly = (base.fsType & 0x0200) !== 0;
    base.embedding = embeddingOf(base.fsType);
    if (os2.n >= 64) base.italic = (v.getUint16(os2.o + 62) & 0x0001) !== 0;
  }
  const name = tables.get("name");
  if (name) {
    const n = readName(v, name.o, name.n);
    base.family = n[16] ?? n[1] ?? null;
    base.fullName = n[4] ?? null;
    base.postscriptName = n[6] ?? null;
  }
  return base;
}
