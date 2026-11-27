// Test helpers (excluded from the build by tsconfig): synthetic fonts and a reset shared state.
import { vi } from "vitest";

/** A minimal sfnt with OS/2 (fsType, weight, italic), name (family, full, PostScript) and optional fvar. */
export function makeFont(o: { fsType?: number; weight?: number; italic?: boolean; family?: string; full?: string; ps?: string; fvar?: boolean; cff?: boolean; noOs2?: boolean; names?: [number, string][]; head?: boolean; ranges?: number[] } = {}): Uint8Array {
  const tables: [string, Uint8Array][] = [];
  if (!o.noOs2) {
    const os2 = new Uint8Array(96);
    const v = new DataView(os2.buffer);
    v.setUint16(0, 4);
    v.setUint16(4, o.weight ?? 400);
    v.setUint16(8, o.fsType ?? 0);
    v.setUint16(62, o.italic ? 1 : 0x40);
    (o.ranges ?? []).forEach((r, i) => v.setUint32(42 + i * 4, r >>> 0));
    tables.push(["OS/2", os2]);
  }
  if (o.head) {
    const head = new Uint8Array(54);
    const hv = new DataView(head.buffer);
    hv.setUint32(0, 0x00010000);
    hv.setUint32(12, 0x5f0f3cf5);
    hv.setUint16(44, o.italic ? 2 : 0);
    tables.push(["head", head]);
  }
  const names: [number, string][] = o.names ?? [[1, o.family ?? "Test Sans"], [4, o.full ?? "Test Sans Regular"], [6, o.ps ?? "TestSans-Regular"]];
  const strs = names.map(([, s]) => s);
  const strBytes = strs.reduce((n, s) => n + s.length * 2, 0);
  const name = new Uint8Array(6 + names.length * 12 + strBytes);
  const nv = new DataView(name.buffer);
  nv.setUint16(2, names.length);
  nv.setUint16(4, 6 + names.length * 12);
  let so = 0;
  names.forEach(([id, s], i) => {
    const r = 6 + i * 12;
    nv.setUint16(r, 3);
    nv.setUint16(r + 2, 1);
    nv.setUint16(r + 4, 0x409);
    nv.setUint16(r + 6, id);
    nv.setUint16(r + 8, s.length * 2);
    nv.setUint16(r + 10, so);
    for (let k = 0; k < s.length; k++) nv.setUint16(6 + names.length * 12 + so + k * 2, s.charCodeAt(k));
    so += s.length * 2;
  });
  tables.push(["name", name]);
  if (o.fvar) tables.push(["fvar", new Uint8Array(16)]);
  const headLen = 12 + tables.length * 16;
  const total = headLen + tables.reduce((n, [, t]) => n + t.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, o.cff ? 0x4f54544f : 0x00010000);
  dv.setUint16(4, tables.length);
  let off = headLen;
  tables.forEach(([tag, t], i) => {
    const r = 12 + i * 16;
    for (let k = 0; k < 4; k++) dv.setUint8(r + k, tag.charCodeAt(k));
    dv.setUint32(r + 8, off);
    dv.setUint32(r + 12, t.length);
    out.set(t, off);
    off += t.length;
  });
  return out;
}

/** A .ttc holding the given fonts (table offsets rebased onto the collection). */
export function makeCollection(fonts: Uint8Array[]): Uint8Array {
  const head = 12 + fonts.length * 4;
  const out = new Uint8Array(head + fonts.reduce((n, f) => n + f.length, 0));
  const dv = new DataView(out.buffer);
  for (let k = 0; k < 4; k++) dv.setUint8(k, "ttcf".charCodeAt(k));
  dv.setUint32(4, 0x00010000);
  dv.setUint32(8, fonts.length);
  let off = head;
  fonts.forEach((f, i) => {
    dv.setUint32(12 + i * 4, off);
    out.set(f, off);
    const fv = new DataView(out.buffer, off);
    const n = fv.getUint16(4);
    for (let t = 0; t < n; t++) fv.setUint32(12 + t * 16 + 8, fv.getUint32(12 + t * 16 + 8) + off);
    off += f.length;
  });
  return out;
}

/** Fresh shared state and an in-memory localStorage. */
export function resetFontshelf(): Map<string, string> {
  (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("fontshelf.state.v1")] = undefined;
  (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("fontshelf.loaded.v1")] = undefined;
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
  return mem;
}

/** WOFF 1.0 around an sfnt, each table zlib-compressed. */
export async function makeWoff(sfnt: Uint8Array): Promise<Uint8Array> {
  const v = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const n = v.getUint16(4);
  const parts: { tag: number; orig: Uint8Array; comp: Uint8Array }[] = [];
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    const orig = sfnt.subarray(v.getUint32(r + 8), v.getUint32(r + 8) + v.getUint32(r + 12));
    const cs = new Response(new Blob([orig as BlobPart]).stream().pipeThrough(new CompressionStream("deflate")));
    const comp = new Uint8Array(await cs.arrayBuffer());
    parts.push({ tag: v.getUint32(r), orig, comp: comp.length < orig.length ? comp : orig });
  }
  const head = 44 + n * 20;
  const out = new Uint8Array(head + parts.reduce((s, p) => s + ((p.comp.length + 3) & ~3), 0));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x774f4646);
  dv.setUint32(4, v.getUint32(0));
  dv.setUint32(8, out.length);
  dv.setUint16(12, n);
  let off = head;
  parts.forEach((p, i) => {
    const r = 44 + i * 20;
    dv.setUint32(r, p.tag);
    dv.setUint32(r + 4, off);
    dv.setUint32(r + 8, p.comp.length);
    dv.setUint32(r + 12, p.orig.length);
    out.set(p.comp, off);
    off += (p.comp.length + 3) & ~3;
  });
  return out;
}

/** WOFF2 around an sfnt's tables (null transforms only; enough for name/OS2 reading). */
export async function makeWoff2(sfnt: Uint8Array): Promise<Uint8Array> {
  const { brotliCompressSync } = await import("node:zlib");
  const KNOWN: Record<string, number> = { "OS/2": 6, name: 5, fvar: 47 };
  const v = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const n = v.getUint16(4);
  const dir: number[] = [];
  const data: Uint8Array[] = [];
  const b128 = (x: number): number[] => { const o = [x & 0x7f]; x = Math.floor(x / 128); while (x) { o.unshift((x & 0x7f) | 0x80); x = Math.floor(x / 128); } return o; };
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    const tag = String.fromCharCode(...sfnt.subarray(r, r + 4));
    const t = sfnt.subarray(v.getUint32(r + 8), v.getUint32(r + 8) + v.getUint32(r + 12));
    if (tag in KNOWN) dir.push(KNOWN[tag]!);
    else dir.push(63, ...sfnt.subarray(r, r + 4));
    dir.push(...b128(t.length));
    data.push(t);
  }
  const joined = new Uint8Array(data.reduce((s, d) => s + d.length, 0));
  let p = 0;
  for (const d of data) { joined.set(d, p); p += d.length; }
  const comp = new Uint8Array(brotliCompressSync(joined));
  const out = new Uint8Array(48 + dir.length + comp.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x774f4632);
  dv.setUint32(4, v.getUint32(0));
  dv.setUint32(8, out.length);
  dv.setUint16(12, n);
  dv.setUint32(20, comp.length);
  out.set(dir, 48);
  out.set(comp, 48 + dir.length);
  return out;
}
