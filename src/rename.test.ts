// Renaming static faces into their family, and getFontFile applying it to catalog files only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { faceNames, getFontFile, isNamedAs, parseFontInfo, renameFace, setConsent, setRemoteEnabled } from "./index.js";
import { makeCollection, makeFont, resetFontshelf } from "./test-utils.js";

beforeEach(() => { resetFontshelf(); });
afterEach(() => { vi.restoreAllMocks(); });

const sum = (b: Uint8Array): number => {
  let s = 0;
  for (let i = 0; i < b.length; i += 4) s = (s + (((b[i] << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0)) >>> 0;
  return s;
};
const table = (b: Uint8Array, tag: string): DataView => {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < dv.getUint16(4); i++) {
    const r = 12 + i * 16;
    if (String.fromCharCode(b[r], b[r + 1], b[r + 2], b[r + 3]) === tag) return new DataView(b.buffer, b.byteOffset + dv.getUint32(r + 8), dv.getUint32(r + 12));
  }
  throw new Error(tag);
};
const semiBold = () => makeFont({ weight: 600, head: true, names: [[1, "Klee One SemiBold"], [2, "Regular"], [4, "Klee One SemiBold"], [6, "KleeOne-SemiBold"]] });

describe("renameFace", () => {
  it("names a SemiBold face after its family, with the real style in ID 17", () => {
    const out = renameFace(semiBold(), "Klee One");
    expect(faceNames(out)).toMatchObject({ 1: "Klee One", 2: "Bold", 4: "Klee One SemiBold", 6: "KleeOne-SemiBold", 16: "Klee One", 17: "SemiBold" });
    expect(parseFontInfo(out)).toMatchObject({ family: "Klee One", weight: 600, italic: false, fullName: "Klee One SemiBold" });
    expect(table(out, "OS/2").getUint16(62) & 0x61).toBe(0x20); // BOLD only
    expect(table(out, "head").getUint16(44) & 3).toBe(1);
    expect(isNamedAs(out, "Klee One")).toBe(true);
  });
  it("keeps light and black faces apart from Regular and Bold", () => {
    const light = renameFace(makeFont({ weight: 300, head: true, names: [[1, "Lato Light"], [2, "Italic"]], italic: true }), "Lato");
    expect(faceNames(light)).toMatchObject({ 1: "Lato", 2: "Italic", 16: "Lato", 17: "Light Italic" });
    expect(table(light, "OS/2").getUint16(62) & 0x61).toBe(0x01);
    const black = renameFace(makeFont({ weight: 900, head: true, names: [[1, "Lato Black"], [2, "Regular"]] }), "Lato");
    expect(faceNames(black)).toMatchObject({ 1: "Lato", 2: "Bold", 17: "Black" });
  });
  it("keeps an existing typographic style and fixes ID 1 when only ID 16 had the family", () => {
    const out = renameFace(makeFont({ weight: 500, names: [[1, "Noto Sans JP Medium"], [2, "Regular"], [16, "Noto Sans JP"], [17, "Medium"]] }), "Noto Sans JP");
    expect(faceNames(out)).toMatchObject({ 1: "Noto Sans JP", 2: "Regular", 16: "Noto Sans JP", 17: "Medium" });
  });
  it("writes valid checksums", () => {
    const out = renameFace(semiBold(), "Klee One");
    expect(sum(out)).toBe(0xb1b0afba);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < dv.getUint16(4); i++) {
      const r = 12 + i * 16;
      const data = out.subarray(dv.getUint32(r + 8), dv.getUint32(r + 8) + dv.getUint32(r + 12)).slice();
      if (String.fromCharCode(out[r], out[r + 1], out[r + 2], out[r + 3]) === "head") new DataView(data.buffer).setUint32(8, 0);
      expect(dv.getUint32(r + 4)).toBe(sum(data));
    }
  });
  it("returns the input for a face already named, a collection, or junk; and never renames twice", () => {
    const named = makeFont({ family: "Tinos" });
    expect(renameFace(named, "tinos")).toBe(named);
    const ttc = makeCollection([semiBold()]);
    expect(renameFace(ttc, "Klee One")).toBe(ttc);
    const junk = new Uint8Array([1, 2, 3, 4, 5]);
    expect(renameFace(junk, "X")).toBe(junk);
    const once = renameFace(semiBold(), "Klee One");
    expect(renameFace(once, "Klee One")).toBe(once);
  });
});

describe("getFontFile renaming", () => {
  it("renames a catalog file into the catalog family, caching the file as served", async () => {
    setRemoteEnabled(true);
    setConsent(true);
    const raw = semiBold();
    const fetchBytes = vi.fn(async () => raw);
    const f = (await getFontFile("klee one", { weight: 700, fetchBytes }))!;
    expect(f).toMatchObject({ source: "remote", family: "Klee One", renamed: true, weight: 600 });
    expect(faceNames(f.bytes)[1]).toBe("Klee One");
    const again = (await getFontFile("Klee One", { weight: 700, fetchBytes }))!;
    expect(again.bytes).toBe(f.bytes); // memoised, not renamed twice
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });
  it("leaves a correctly named catalog file and installed fonts alone", async () => {
    setRemoteEnabled(true);
    setConsent(true);
    const ok = makeFont({ family: "Klee One" });
    expect((await getFontFile("Klee One", { local: false, fetchBytes: async () => ok }))!).toMatchObject({ renamed: false, bytes: ok });
    const local = semiBold();
    const q = vi.fn(async () => [{ family: "Klee One", style: "SemiBold", fullName: "Klee One SemiBold", postscriptName: "KleeOne-SemiBold", blob: async () => new Blob([local as BlobPart]) }]);
    (window as unknown as { queryLocalFonts: unknown }).queryLocalFonts = q;
    vi.spyOn(navigator.permissions, "query").mockResolvedValue({ state: "granted" } as PermissionStatus);
    const f = (await getFontFile("Klee One", { weight: 600, remote: false }))!;
    delete (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts;
    expect(f).toMatchObject({ source: "local", renamed: false });
    expect(faceNames(f.bytes)[1]).toBe("Klee One SemiBold");
  });
});
