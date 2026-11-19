// Static instances of variable fonts, for engines that cannot apply variations (libass, PDF
// writers, wasm slide engines). HarfBuzz's subsetter pins the axes; its wasm loads lazily.
import { parseAxes, parseFontInfo, sfntTables, type FontAxis } from "./sfnt.js";

/** Axis location to pin: wght clamped to the requested weight, ital/slnt for italic. */
export function instanceLocation(axes: readonly FontAxis[], weight = 400, italic = false): Record<string, number> {
  const clamp = (a: FontAxis, x: number) => Math.min(a.max, Math.max(a.min, x));
  const out: Record<string, number> = {};
  const ital = axes.find((a) => a.tag === "ital");
  for (const a of axes) {
    if (a.tag === "wght") out.wght = clamp(a, weight);
    else if (a.tag === "ital") out.ital = clamp(a, italic ? 1 : 0);
    // slnt is negative for a right lean; use its full lean only when there is no ital axis.
    else if (a.tag === "slnt") out.slnt = italic && !ital ? clamp(a, Math.min(a.min, 0)) : clamp(a, 0);
  }
  return out;
}

const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium",
  600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black", 1000: "ExtraBlack",
};

/** Style name of an instance: "SemiBold Italic", "Weight450", "Italic". */
export function instanceStyleName(weight: number, italic: boolean): string {
  const w = WEIGHT_NAMES[weight] ?? `Weight${Math.round(weight)}`;
  if (!italic) return w;
  return w === "Regular" ? "Italic" : `${w} Italic`;
}

// --- sfnt rewriting -----------------------------------------------------------------------------

const u16 = (n: number) => [(n >> 8) & 255, n & 255];
const utf16 = (s: string) => { const b: number[] = []; for (let i = 0; i < s.length; i++) b.push(...u16(s.charCodeAt(i))); return b; };

function checksum(b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < b.length; i += 4) sum = (sum + (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0))) >>> 0;
  return sum;
}

/** A single-font sfnt with some tables replaced, checksums and head.checkSumAdjustment redone. */
function rebuildSfnt(bytes: Uint8Array, replace: Map<string, Uint8Array>): Uint8Array {
  const dir = sfntTables(bytes)!;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tags = [...dir.tables.keys()].sort();
  const data = tags.map((t) => replace.get(t) ?? bytes.subarray(dir.tables.get(t)!.o, dir.tables.get(t)!.o + dir.tables.get(t)!.n).slice());
  const head = 12 + tags.length * 16;
  const total = data.reduce((n, d) => n + ((d.length + 3) & ~3), head);
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  const pow = 2 ** Math.floor(Math.log2(tags.length));
  ov.setUint32(0, v.getUint32(dir.offset));
  ov.setUint16(4, tags.length);
  ov.setUint16(6, pow * 16);
  ov.setUint16(8, Math.log2(pow));
  ov.setUint16(10, tags.length * 16 - pow * 16);
  let off = head;
  let headAt = -1;
  tags.forEach((t, i) => {
    const d = data[i]!;
    if (t === "head" && d.length >= 12) { headAt = off; d.fill(0, 8, 12); }
    const r = 12 + i * 16;
    for (let k = 0; k < 4; k++) ov.setUint8(r + k, t.charCodeAt(k));
    ov.setUint32(r + 4, checksum(d));
    ov.setUint32(r + 8, off);
    ov.setUint32(r + 12, d.length);
    out.set(d, off);
    off += (d.length + 3) & ~3;
  });
  if (headAt >= 0) ov.setUint32(headAt + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}

/** A name table with family/style records (IDs 1-4, 6, 16, 17) replaced; others are kept. */
function rewriteNames(table: Uint8Array, names: Record<number, string>): Uint8Array {
  const v = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const drop = new Set([1, 2, 3, 4, 6, 16, 17, 25]);
  const format = v.getUint16(0);
  const count = v.getUint16(2);
  const storage = v.getUint16(4);
  const recs: { p: number; e: number; l: number; id: number; s: number[] }[] = [];
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (r + 12 > table.length) break;
    const id = v.getUint16(r + 6);
    const n = v.getUint16(r + 8);
    const o = storage + v.getUint16(r + 10);
    if (drop.has(id) || o + n > table.length) continue;
    recs.push({ p: v.getUint16(r), e: v.getUint16(r + 2), l: v.getUint16(r + 4), id, s: [...table.subarray(o, o + n)] });
  }
  for (const [id, s] of Object.entries(names)) recs.push({ p: 3, e: 1, l: 0x409, id: Number(id), s: utf16(s) });
  recs.sort((a, b) => a.p - b.p || a.e - b.e || a.l - b.l || a.id - b.id);
  // Format 1 language-tag records reference storage too; carry them over.
  const langTags: number[][] = [];
  let at = 6 + count * 12;
  if (format === 1 && at + 2 <= table.length) {
    const n = v.getUint16(at);
    for (let i = 0; i < n; i++) {
      const r = at + 2 + i * 4;
      const len = v.getUint16(r);
      const o = storage + v.getUint16(r + 2);
      langTags.push([...table.subarray(o, o + len)]);
    }
  }
  const hdr = 6 + recs.length * 12 + (format === 1 ? 2 + langTags.length * 4 : 0);
  const out: number[] = [...u16(format), ...u16(recs.length), ...u16(hdr)];
  const pool: number[] = [];
  const put = (s: number[]) => { const o = pool.length; pool.push(...s); return o; };
  for (const r of recs) out.push(...u16(r.p), ...u16(r.e), ...u16(r.l), ...u16(r.id), ...u16(r.s.length), ...u16(put(r.s)));
  if (format === 1) {
    out.push(...u16(langTags.length));
    for (const s of langTags) out.push(...u16(s.length), ...u16(put(s)));
  }
  return new Uint8Array([...out, ...pool]);
}

/**
 * Name and style bits of an instance so engines match it by the catalog family (libass reads
 * name ID 1) and tell instances apart (distinct full and PostScript names).
 */
export function restyleInstance(bytes: Uint8Array, family: string, weight: number, italic: boolean): Uint8Array {
  const dir = sfntTables(bytes);
  if (!dir) return bytes;
  const get = (t: string) => { const e = dir.tables.get(t); return e ? bytes.slice(e.o, e.o + e.n) : null; };
  const name = get("name");
  const os2 = get("OS/2");
  const head = get("head");
  const bold = weight >= 700;
  const style = instanceStyleName(weight, italic);
  const ribbi = (bold ? "Bold" : "Regular") + (italic ? " Italic" : "");
  const info = parseFontInfo(bytes);
  const prefix = (readNameId(bytes, 25) ?? info?.postscriptName?.split("-")[0] ?? family).replace(/[^\x21-\x7e]|[[\](){}<>/%]/g, "");
  const ps = `${prefix}-${style.replace(/ /g, "")}`.slice(0, 63);
  const version = (readNameId(bytes, 5) ?? "").replace(/^Version\s*/i, "").split(";")[0] || "1.0";
  const replace = new Map<string, Uint8Array>();
  if (name) {
    replace.set("name", rewriteNames(name, {
      1: family, 2: ribbi.replace("Regular Italic", "Italic"), 3: `${version};${ps}`,
      4: `${family} ${style}`, 6: ps, 16: family, 17: style,
    }));
  }
  if (os2 && os2.length >= 64) {
    const ov = new DataView(os2.buffer);
    let sel = ov.getUint16(62) & ~(0x0001 | 0x0020 | 0x0040);
    if (italic) sel |= 0x0001;
    if (bold) sel |= 0x0020;
    if (!italic && !bold) sel |= 0x0040;
    ov.setUint16(62, sel);
    replace.set("OS/2", os2);
  }
  if (head && head.length >= 46) {
    const hv = new DataView(head.buffer);
    hv.setUint16(44, (hv.getUint16(44) & ~3) | (bold ? 1 : 0) | (italic ? 2 : 0));
    replace.set("head", head);
  }
  return rebuildSfnt(bytes, replace);
}

function readNameId(bytes: Uint8Array, id: number): string | null {
  const t = sfntTables(bytes)?.tables.get("name");
  if (!t) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = v.getUint16(t.o + 2);
  const storage = t.o + v.getUint16(t.o + 4);
  for (let i = 0; i < count; i++) {
    const r = t.o + 6 + i * 12;
    if (v.getUint16(r) !== 3 || v.getUint16(r + 6) !== id) continue;
    const n = v.getUint16(r + 8);
    const o = storage + v.getUint16(r + 10);
    let s = "";
    for (let k = 0; k + 1 < n && o + k + 1 < bytes.length; k += 2) s += String.fromCharCode(v.getUint16(o + k));
    return s;
  }
  return null;
}

// --- HarfBuzz -----------------------------------------------------------------------------------

interface HbExports {
  memory: WebAssembly.Memory;
  malloc(n: number): number;
  free(p: number): void;
  _initialize?(): void;
  hb_blob_create(data: number, len: number, mode: number, user: number, destroy: number): number;
  hb_blob_destroy(b: number): void;
  hb_blob_get_length(b: number): number;
  hb_blob_get_data(b: number, len: number): number;
  hb_face_create(b: number, index: number): number;
  hb_face_destroy(f: number): void;
  hb_face_reference_blob(f: number): number;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(i: number): void;
  hb_subset_input_keep_everything(i: number): void;
  hb_subset_input_pin_all_axes_to_default(i: number, f: number): number;
  hb_subset_input_pin_axis_location(i: number, f: number, tag: number, value: number): number;
  hb_subset_or_fail(f: number, i: number): number;
}

type WasmSource = string | URL | ArrayBuffer | Uint8Array;
let wasmSource: WasmSource | null = null;
let hb: Promise<HbExports | null> | null = null;

/**
 * Where to load harfbuzz-subset.wasm from: a URL, or the bytes themselves (Node, tests).
 * Null restores the default, the file beside this module in dist/.
 */
export function setHarfbuzzWasm(source: WasmSource | null): void {
  wasmSource = source;
  hb = null;
}

const defaultWasmUrl = () => new URL("./harfbuzz-subset.wasm", import.meta.url);

function loadHarfbuzz(): Promise<HbExports | null> {
  hb ??= (async () => {
    try {
      const src = wasmSource ?? defaultWasmUrl();
      const bytes = typeof src === "string" || src instanceof URL
        ? await (await fetch(src)).arrayBuffer()
        : src;
      const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
      const e = instance.exports as unknown as HbExports;
      e._initialize?.();
      return e;
    } catch {
      hb = null; // let a later call retry (offline, wrong URL)
      return null;
    }
  })();
  return hb;
}

const hbTag = (t: string) => ((t.charCodeAt(0) << 24) | (t.charCodeAt(1) << 16) | (t.charCodeAt(2) << 8) | t.charCodeAt(3)) >>> 0;

function pinWithHarfbuzz(e: HbExports, bytes: Uint8Array, index: number, location: Record<string, number>): Uint8Array | null {
  const p = e.malloc(bytes.byteLength);
  if (!p) return null;
  new Uint8Array(e.memory.buffer).set(bytes, p);
  const blob = e.hb_blob_create(p, bytes.byteLength, 1, 0, 0);
  const face = e.hb_face_create(blob, index);
  const input = e.hb_subset_input_create_or_fail();
  let out: Uint8Array | null = null;
  try {
    if (!input) return null;
    e.hb_subset_input_keep_everything(input);
    e.hb_subset_input_pin_all_axes_to_default(input, face);
    for (const [t, x] of Object.entries(location)) e.hb_subset_input_pin_axis_location(input, face, hbTag(t), x);
    const res = e.hb_subset_or_fail(face, input);
    if (!res) return null;
    const rb = e.hb_face_reference_blob(res);
    const len = e.hb_blob_get_length(rb);
    const data = e.hb_blob_get_data(rb, 0);
    if (len) out = new Uint8Array(e.memory.buffer, data, len).slice();
    e.hb_blob_destroy(rb);
    e.hb_face_destroy(res);
  } finally {
    if (input) e.hb_subset_input_destroy(input);
    e.hb_face_destroy(face);
    e.hb_blob_destroy(blob);
    e.free(p);
  }
  return out;
}

export interface InstanceOptions {
  weight?: number;
  italic?: boolean;
  /** Face index in a .ttc. */
  index?: number;
  /** Family name to write into the instance (default: the font's own typographic family). */
  family?: string;
}

export interface FontInstance {
  bytes: Uint8Array;
  /** The pinned axis location (wght, ital, slnt; other axes sit at their defaults). */
  location: Record<string, number>;
  /** Pinned weight, or the font's OS/2 weight without a wght axis. */
  weight: number | null;
  italic: boolean;
}

/** A static instance of a variable font. Null for a static font, or when HarfBuzz cannot load or fails. */
export async function instanceFont(bytes: Uint8Array, opts: InstanceOptions = {}): Promise<FontInstance | null> {
  const index = opts.index ?? 0;
  const axes = parseAxes(bytes, index);
  const info = parseFontInfo(bytes, index);
  if (!axes.length || !info) return null;
  const location = instanceLocation(axes, opts.weight ?? 400, opts.italic ?? false);
  const e = await loadHarfbuzz();
  if (!e) return null;
  let pinned: Uint8Array | null = null;
  try { pinned = pinWithHarfbuzz(e, bytes, index, location); } catch { pinned = null; }
  if (!pinned) return null;
  const italic = info.italic || (location.ital ?? 0) >= 0.5 || (location.slnt ?? 0) < 0;
  const weight = location.wght ?? parseFontInfo(pinned)?.weight ?? info.weight;
  const family = opts.family ?? info.family ?? "Font";
  return { bytes: restyleInstance(pinned, family, weight ?? 400, italic), location, weight, italic };
}

/** Cache key part for a location: "ital=1,wght=700". */
export const locationKey = (loc: Record<string, number>): string =>
  Object.keys(loc).sort().map((k) => `${k}=${loc[k]}`).join(",");
