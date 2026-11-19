// Rename a static face into its family, so engines that look a face up by family find it.
// Static Google Fonts files may name a weight only in ID 1 ("Klee One SemiBold", "Lato Black").
// libass matches ID 1 (or the full name, ID 4); DeckCraft reads ID 16, else ID 1, and keys faces
// by family + ID 17 (else ID 2) style. So: ID 1 = ID 16 = family, ID 2 = the RIBBI style
// (Bold from 600 up), ID 17 = the real style ("SemiBold", "Black Italic"). OS/2 usWeightClass is
// kept, fsSelection and head.macStyle follow ID 2, checksums are recomputed. Pure, no DOM.

const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium",
  600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black",
};

interface NameRecord { pid: number; eid: number; lid: number; nid: number; str: Uint8Array }

interface Table { tag: number; data: Uint8Array }

const tagOf = (s: string): number => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
const NAME = tagOf("name");
const OS2 = tagOf("OS/2");
const HEAD = tagOf("head");

const isUnicode = (pid: number): boolean => pid === 0 || pid === 3;
const encode = (pid: number, s: string): Uint8Array => {
  if (isUnicode(pid)) {
    const b = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) { b[i * 2] = s.charCodeAt(i) >> 8; b[i * 2 + 1] = s.charCodeAt(i) & 0xff; }
    return b;
  }
  return Uint8Array.from(s, (c) => (c.charCodeAt(0) < 128 ? c.charCodeAt(0) : 63));
};
const decode = (pid: number, b: Uint8Array): string => {
  let s = "";
  if (isUnicode(pid)) for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  else for (const c of b) s += String.fromCharCode(c);
  return s;
};

function checksum(b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < b.length; i += 4) sum = (sum + (((b[i] << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0)) >>> 0;
  return sum;
}

function readTables(bytes: Uint8Array): Table[] | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ver = dv.getUint32(0);
  if (ver !== 0x00010000 && ver !== 0x4f54544f && ver !== 0x74727565) return null; // TTF, OTTO, true; not TTC/WOFF
  const n = dv.getUint16(4);
  const out: Table[] = [];
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    const o = dv.getUint32(r + 8);
    const len = dv.getUint32(r + 12);
    if (o + len > bytes.length) return null;
    out.push({ tag: dv.getUint32(r), data: bytes.subarray(o, o + len) });
  }
  return out;
}

function readNames(name: Uint8Array): { records: NameRecord[]; langTags: Uint8Array[] } | null {
  const dv = new DataView(name.buffer, name.byteOffset, name.byteLength);
  const version = dv.getUint16(0);
  const count = dv.getUint16(2);
  const storage = dv.getUint16(4);
  const str = (len: number, off: number): Uint8Array => {
    if (storage + off + len > name.length) throw new RangeError("name string");
    return name.subarray(storage + off, storage + off + len);
  };
  const records: NameRecord[] = [];
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    records.push({ pid: dv.getUint16(r), eid: dv.getUint16(r + 2), lid: dv.getUint16(r + 4), nid: dv.getUint16(r + 6), str: str(dv.getUint16(r + 8), dv.getUint16(r + 10)) });
  }
  const langTags: Uint8Array[] = [];
  if (version === 1) {
    const at = 6 + count * 12;
    const n = dv.getUint16(at);
    for (let i = 0; i < n; i++) langTags.push(str(dv.getUint16(at + 2 + i * 4), dv.getUint16(at + 4 + i * 4)));
  }
  return { records, langTags };
}

function writeNames(records: NameRecord[], langTags: Uint8Array[]): Uint8Array {
  const head = 6 + records.length * 12 + (langTags.length ? 2 + langTags.length * 4 : 0);
  const size = head + [...records.map((r) => r.str), ...langTags].reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, langTags.length ? 1 : 0);
  dv.setUint16(2, records.length);
  dv.setUint16(4, head);
  let at = 0;
  const put = (s: Uint8Array): number => { out.set(s, head + at); at += s.length; return at - s.length; };
  records.forEach((r, i) => {
    const o = 6 + i * 12;
    [r.pid, r.eid, r.lid, r.nid, r.str.length, put(r.str)].forEach((v, k) => dv.setUint16(o + k * 2, v));
  });
  if (langTags.length) {
    const o = 6 + records.length * 12;
    dv.setUint16(o, langTags.length);
    langTags.forEach((s, i) => { dv.setUint16(o + 2 + i * 4, s.length); dv.setUint16(o + 4 + i * 4, put(s)); });
  }
  return out;
}

/** Best English string per name ID (Windows English, then any Unicode, then Mac Roman). */
function pickNames(records: NameRecord[]): Map<number, string> {
  const out = new Map<number, string>();
  const rank = new Map<number, number>();
  for (const r of records) {
    const score = r.pid === 3 ? (r.lid === 0x409 ? 3 : 2) : r.pid === 0 ? 2 : r.pid === 1 && r.lid === 0 ? 1 : 0;
    if (!score || (rank.get(r.nid) ?? 0) >= score) continue;
    out.set(r.nid, decode(r.pid, r.str));
    rank.set(r.nid, score);
  }
  return out;
}

/** A single font's name strings by ID (English preferred); empty for a collection or junk. */
export function faceNames(bytes: Uint8Array): Partial<Record<number, string>> {
  try {
    const name = readTables(bytes)?.find((t) => t.tag === NAME);
    const n = name && readNames(name.data);
    return n ? Object.fromEntries(pickNames(n.records)) : {};
  } catch {
    return {};
  }
}

const same = (a: string | undefined, b: string): boolean => a !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();

/** True when a single-font file already says `family` in name IDs 1 and (if present) 16. */
export function isNamedAs(bytes: Uint8Array, family: string): boolean {
  try {
    const tables = readTables(bytes);
    const name = tables?.find((t) => t.tag === NAME);
    const n = name && readNames(name.data);
    if (!n) return true; // nothing we could rename
    const names = pickNames(n.records);
    return same(names.get(1), family) && (!names.has(16) || same(names.get(16), family));
  } catch {
    return true;
  }
}

/** The typographic style for ID 17: kept if present, else the old ID 1 after the family, else the weight's name. */
function styleName(names: Map<number, string>, family: string, weight: number, italic: boolean): string {
  const kept = names.get(17);
  if (kept) return kept;
  const id1 = names.get(1) ?? "";
  let base = id1.toLowerCase().startsWith(family.toLowerCase() + " ") ? id1.slice(family.length + 1).trim() : "";
  if (!base) base = WEIGHT_NAMES[Math.min(900, Math.max(100, Math.round(weight / 100) * 100))] ?? "Regular";
  if (italic && !/italic|oblique/i.test(base)) base = base === "Regular" ? "Italic" : `${base} Italic`;
  return base;
}

/**
 * Rename a static face into `family` (see the file comment). Returns the input itself when it
 * already reads as `family`, or for a collection, WOFF or unreadable bytes.
 */
export function renameFace(bytes: Uint8Array, family: string): Uint8Array {
  try {
    if (isNamedAs(bytes, family)) return bytes;
    const tables = readTables(bytes)!;
    const nameT = tables.find((t) => t.tag === NAME)!;
    const { records, langTags } = readNames(nameT.data)!;
    const names = pickNames(records);
    const os2 = tables.find((t) => t.tag === OS2);
    const head = tables.find((t) => t.tag === HEAD);
    const ov = os2 && os2.data.length >= 64 ? new DataView(os2.data.buffer, os2.data.byteOffset, os2.data.byteLength) : null;
    const weight = ov ? ov.getUint16(4) : 400;
    const italic = ov ? (ov.getUint16(62) & 0x0201) !== 0 : /italic|oblique/i.test(names.get(2) ?? "");
    const bold = weight >= 600;
    const ribbi = bold ? (italic ? "Bold Italic" : "Bold") : italic ? "Italic" : "Regular";
    const typo = styleName(names, family, weight, italic);

    // IDs 1 and 2 rewritten in place; 16 and 17 rebuilt for every locale ID 1 has.
    const kept = records.filter((r) => r.nid !== 16 && r.nid !== 17).map((r) =>
      r.nid === 1 ? { ...r, str: encode(r.pid, family) } : r.nid === 2 ? { ...r, str: encode(r.pid, ribbi) } : r);
    const typoRecs = records.filter((r) => r.nid === 1).flatMap((r) => [
      { ...r, nid: 16, str: encode(r.pid, family) },
      { ...r, nid: 17, str: encode(r.pid, typo) },
    ]);
    const all = [...kept, ...typoRecs].sort((a, b) => a.pid - b.pid || a.eid - b.eid || a.lid - b.lid || a.nid - b.nid);
    const replaced = new Map<number, Uint8Array>([[NAME, writeNames(all, langTags)]]);

    if (ov) {
      const o = os2!.data.slice();
      const v = new DataView(o.buffer);
      // fsSelection: ITALIC (0), BOLD (5), REGULAR (6); OBLIQUE (9) and the rest kept.
      let fs = v.getUint16(62) & ~0x0061;
      if (italic) fs |= 0x0001;
      if (bold) fs |= 0x0020;
      if (!bold && !italic) fs |= 0x0040;
      v.setUint16(62, fs);
      replaced.set(OS2, o);
    }
    if (head && head.data.length >= 46) {
      const h = head.data.slice();
      const v = new DataView(h.buffer);
      v.setUint16(44, (v.getUint16(44) & ~0x0003) | (bold ? 1 : 0) | (italic ? 2 : 0));
      v.setUint32(8, 0); // checkSumAdjustment, set below
      replaced.set(HEAD, h);
    }
    return assemble(bytes, tables.map((t) => ({ tag: t.tag, data: replaced.get(t.tag) ?? t.data })));
  } catch {
    return bytes;
  }
}

/** A fresh sfnt from the original header and these tables (same order), 4-byte aligned, checksummed. */
function assemble(orig: Uint8Array, tables: Table[]): Uint8Array {
  const dirLen = 12 + tables.length * 16;
  let size = dirLen;
  for (const t of tables) size += (t.data.length + 3) & ~3;
  const out = new Uint8Array(size);
  out.set(orig.subarray(0, 12));
  const dv = new DataView(out.buffer);
  let at = dirLen;
  let headAt = -1;
  tables.forEach((t, i) => {
    const r = 12 + i * 16;
    dv.setUint32(r, t.tag);
    dv.setUint32(r + 4, checksum(t.data));
    dv.setUint32(r + 8, at);
    dv.setUint32(r + 12, t.data.length);
    out.set(t.data, at);
    if (t.tag === HEAD) headAt = at;
    at += (t.data.length + 3) & ~3;
  });
  if (headAt >= 0) {
    dv.setUint32(headAt + 8, 0);
    dv.setUint32(headAt + 8, (0xb1b0afba - checksum(out)) >>> 0);
  }
  return out;
}
