// Container conversions for user-loaded files: WOFF to a plain sfnt, the name and OS/2 tables
// of a WOFF2 (when the browser can decompress Brotli), one face out of a .ttc. No DOM.

const u32 = (v: DataView, o: number): number => v.getUint32(o);
const tagAt = (b: Uint8Array, o: number): string => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

async function inflate(data: Uint8Array, format: "deflate" | "brotli"): Promise<Uint8Array | null> {
  try {
    const ds = new DecompressionStream(format as CompressionFormat);
    const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  } catch {
    return null;
  }
}

/** A single sfnt from a table list (tag + data), with a valid directory and 4-byte aligned tables. */
export function buildSfnt(flavor: number, tables: readonly { tag: string; data: Uint8Array; checksum?: number }[]): Uint8Array {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const n = sorted.length;
  const head = 12 + n * 16;
  const total = sorted.reduce((s, t) => s + ((t.data.length + 3) & ~3), head);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, flavor);
  dv.setUint16(4, n);
  let p = 1;
  let e = 0;
  while (p * 2 <= n) { p *= 2; e++; }
  dv.setUint16(6, p * 16);
  dv.setUint16(8, e);
  dv.setUint16(10, n * 16 - p * 16);
  let off = head;
  sorted.forEach((t, i) => {
    const r = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[r + k] = t.tag.charCodeAt(k);
    dv.setUint32(r + 4, t.checksum ?? 0);
    dv.setUint32(r + 8, off);
    dv.setUint32(r + 12, t.data.length);
    out.set(t.data, off);
    off += (t.data.length + 3) & ~3;
  });
  return out;
}

/** WOFF 1.0 to the sfnt it wraps (zlib tables inflated). Null when the file is broken. */
export async function woffToSfnt(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (bytes.length < 44 || tagAt(bytes, 0) !== "wOFF") return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flavor = u32(v, 4);
  const num = v.getUint16(12);
  const tables: { tag: string; data: Uint8Array; checksum: number }[] = [];
  for (let i = 0; i < num; i++) {
    const r = 44 + i * 20;
    if (r + 20 > bytes.length) return null;
    const off = u32(v, r + 4), comp = u32(v, r + 8), orig = u32(v, r + 12);
    if (off + comp > bytes.length) return null;
    let data: Uint8Array | null = bytes.subarray(off, off + comp);
    if (comp < orig) data = await inflate(data, "deflate");
    if (!data || data.length !== orig) return null;
    tables.push({ tag: tagAt(bytes, r), data, checksum: u32(v, r + 16) });
  }
  return buildSfnt(flavor, tables);
}

// WOFF2 known-table tags, by index (WOFF2 spec, table 3).
const WOFF2_TAGS = (
  "cmap head hhea hmtx maxp name OS/2 post cvt  fpgm glyf loca prep CFF  VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX " +
  "vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG  sbix acnt avar bdat bloc bsln cvar fdsc feat " +
  "fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill"
).match(/.{4}\s?/g)!.map((t) => t.slice(0, 4));

function base128(b: Uint8Array, at: { p: number }): number | null {
  let n = 0;
  for (let i = 0; i < 5; i++) {
    const c = b[at.p++];
    if (c === undefined || (i === 0 && c === 0x80)) return null;
    n = n * 128 + (c & 0x7f);
    if (!(c & 0x80)) return n;
  }
  return null;
}

/**
 * A WOFF2 font's name and OS/2 tables (plus an empty fvar marker for a variable font) as a
 * small sfnt, enough for parseFontInfo. Null for a collection, a broken file, or no Brotli.
 */
export async function woff2Tables(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (bytes.length < 48 || tagAt(bytes, 0) !== "wOF2") return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flavor = u32(v, 4);
  if (flavor === 0x74746366) return null; // ttcf
  const num = v.getUint16(12);
  const compSize = u32(v, 20);
  const at = { p: 48 };
  const dir: { tag: string; len: number }[] = [];
  for (let i = 0; i < num; i++) {
    const flags = bytes[at.p++];
    if (flags === undefined) return null;
    let tag: string;
    if ((flags & 0x3f) === 63) { tag = tagAt(bytes, at.p); at.p += 4; } else tag = WOFF2_TAGS[flags & 0x3f]!;
    const orig = base128(bytes, at);
    if (orig === null) return null;
    const ver = flags >> 6;
    const transformed = tag === "glyf" || tag === "loca" ? ver === 0 : ver !== 0;
    let len = orig;
    if (transformed) {
      const t = base128(bytes, at);
      if (t === null) return null;
      len = t;
    }
    dir.push({ tag, len });
  }
  if (at.p + compSize > bytes.length) return null;
  const data = await inflate(bytes.subarray(at.p, at.p + compSize), "brotli");
  if (!data) return null;
  const tables: { tag: string; data: Uint8Array }[] = [];
  let off = 0;
  for (const t of dir) {
    if (t.tag === "name" || t.tag === "OS/2") {
      if (off + t.len > data.length) return null;
      tables.push({ tag: t.tag, data: data.subarray(off, off + t.len) });
    } else if (t.tag === "fvar") tables.push({ tag: "fvar", data: new Uint8Array(0) });
    off += t.len;
  }
  return buildSfnt(flavor, tables);
}

/** One face of a .ttc as a standalone font (tables copied; shared tables are duplicated). */
export function extractFace(ttc: Uint8Array, index: number): Uint8Array | null {
  if (ttc.length < 16 || tagAt(ttc, 0) !== "ttcf") return null;
  const v = new DataView(ttc.buffer, ttc.byteOffset, ttc.byteLength);
  if (index >= u32(v, 8) || 12 + index * 4 + 4 > ttc.length) return null;
  const off = u32(v, 12 + index * 4);
  if (off + 12 > ttc.length) return null;
  const n = v.getUint16(off + 4);
  const tables: { tag: string; data: Uint8Array; checksum: number }[] = [];
  for (let i = 0; i < n; i++) {
    const r = off + 12 + i * 16;
    if (r + 16 > ttc.length) return null;
    const o = u32(v, r + 8), len = u32(v, r + 12);
    if (o + len > ttc.length) return null;
    tables.push({ tag: tagAt(ttc, r), data: ttc.subarray(o, o + len), checksum: u32(v, r + 4) });
  }
  return buildSfnt(u32(v, off), tables);
}
