// The font-file layer: sfnt parsing, catalog files, local and remote bytes, gating, caching.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WEB_FONTS, catalogFiles, embeddableOf, embeddingOf, getFontFile, parseFontInfo, pickCatalogFile, pickLocalFace,
  setConsent, setRemoteEnabled, styleOf, isFontFileCached,
} from "./index.js";
import { makeCollection, makeFont, resetFontshelf } from "./test-utils.js";

beforeEach(() => { resetFontshelf(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("sfnt parsing", () => {
  it("reads format, OS/2 bits and names", () => {
    const info = parseFontInfo(makeFont({ weight: 700, italic: true, family: "Fam", full: "Fam Bold Italic", ps: "Fam-BoldItalic" }))!;
    expect(info).toMatchObject({ format: "ttf", numFonts: 1, fsType: 0, embedding: "installable", weight: 700, italic: true, variable: false, family: "Fam", fullName: "Fam Bold Italic", postscriptName: "Fam-BoldItalic" });
    expect(parseFontInfo(makeFont({ cff: true }))!.format).toBe("otf");
    expect(parseFontInfo(makeFont({ fvar: true }))!.variable).toBe(true);
  });
  it("maps fsType to the embedding permission, least restrictive wins", () => {
    expect(embeddingOf(0)).toBe("installable");
    expect(embeddingOf(0x0002)).toBe("restricted");
    expect(embeddingOf(0x0004)).toBe("preview-print");
    expect(embeddingOf(0x0008)).toBe("editable");
    expect(embeddingOf(0x0006)).toBe("preview-print");
    expect(embeddingOf(0x000a)).toBe("editable");
    expect(embeddingOf(null)).toBe("installable");
    const r = parseFontInfo(makeFont({ fsType: 0x0302 }))!;
    expect(r).toMatchObject({ embedding: "restricted", noSubsetting: true, bitmapOnly: true });
    expect(embeddableOf(r)).toBe("restricted");
    expect(embeddableOf(parseFontInfo(makeFont({ fsType: 0x0200 }))!)).toBe(false);
    expect(embeddableOf(parseFontInfo(makeFont({ fsType: 0x0004 }))!)).toBe(true);
  });
  it("treats a font without OS/2 as installable", () => {
    expect(parseFontInfo(makeFont({ noOs2: true }))).toMatchObject({ fsType: null, embedding: "installable", weight: null });
  });
  it("reads each face of a collection", () => {
    const ttc = makeCollection([makeFont({ ps: "A-Regular" }), makeFont({ ps: "A-Bold", weight: 700, fsType: 2 })]);
    expect(parseFontInfo(ttc)).toMatchObject({ format: "ttc", numFonts: 2, postscriptName: "A-Regular" });
    expect(parseFontInfo(ttc, 1)).toMatchObject({ postscriptName: "A-Bold", weight: 700, embedding: "restricted" });
    expect(parseFontInfo(ttc, 2)).toBeNull();
  });
  it("recognises WOFF and rejects garbage", () => {
    expect(parseFontInfo(new TextEncoder().encode("wOF2xxxxxxxxxxxx"))!.format).toBe("woff2");
    expect(parseFontInfo(new TextEncoder().encode("not a font at all"))).toBeNull();
    expect(parseFontInfo(new Uint8Array(4))).toBeNull();
  });
});

describe("catalog files", () => {
  it("covers every catalog family with plain TTF/OTF files and sizes", () => {
    for (const wf of WEB_FONTS) {
      const c = catalogFiles(wf.family);
      expect(c, wf.family).toBeDefined();
      expect(c!.files.length, wf.family).toBeGreaterThan(0);
      for (const f of c!.files) {
        expect(f.file).toMatch(/\.(ttf|otf)$/);
        expect(f.bytes).toBeGreaterThan(1000);
      }
      expect(["ofl", "apache", "ufl"]).toContain(c!.license);
    }
  });
  it("builds raw GitHub URLs, escaping variable-font brackets", () => {
    const c = catalogFiles("noto sans jp")!;
    expect(c.family).toBe("Noto Sans JP");
    expect(c.files[0]).toMatchObject({ file: "NotoSansJP[wght].ttf", variable: true, weight: [100, 900] });
    expect(c.files[0]!.url).toBe("https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf");
    expect(catalogFiles("Nope")).toBeUndefined();
  });
  it("picks the right italic first, then the nearest weight", () => {
    const files = catalogFiles("Tinos")!.files;
    expect(pickCatalogFile(files, 700, true)!.file).toBe("Tinos-BoldItalic.ttf");
    expect(pickCatalogFile(files, 600, false)!.file).toBe("Tinos-Bold.ttf");
    expect(pickCatalogFile(files)!.file).toBe("Tinos-Regular.ttf");
    expect(pickCatalogFile(catalogFiles("Klee One")!.files, 400, true)!.file).toBe("KleeOne-Regular.ttf"); // no italic: synthesise
  });
});

describe("local faces", () => {
  it("reads weight and italic from style names", () => {
    expect(styleOf("Bold Italic")).toEqual({ weight: 700, italic: true });
    expect(styleOf("SemiBold")).toEqual({ weight: 600, italic: false });
    expect(styleOf("ExtraLight Oblique")).toEqual({ weight: 200, italic: true });
    expect(styleOf("W6")).toEqual({ weight: 600, italic: false });
    expect(styleOf("Regular")).toEqual({ weight: 400, italic: false });
  });
  const face = (family: string, style: string, ps = `${family}-${style}`) => ({ family, style, fullName: `${family} ${style}`, postscriptName: ps });
  it("picks the closest face, or a full-name match", () => {
    const fonts = [face("Arial", "Regular"), face("Arial", "Bold"), face("Arial", "Italic"), face("Arial", "Bold Italic"), face("Arial Black", "Regular")];
    expect(pickLocalFace(fonts, "arial", 700, true)!.style).toBe("Bold Italic");
    expect(pickLocalFace(fonts, "Arial", 500)!.style).toBe("Regular");
    expect(pickLocalFace(fonts, "Arial Bold")!.style).toBe("Bold");
    expect(pickLocalFace(fonts, "Helvetica")).toBeUndefined();
  });
});

describe("getFontFile", () => {
  const stubLocal = (permission: PermissionState, fonts: { family: string; style: string; fullName: string; postscriptName: string; bytes: Uint8Array }[]) => {
    const q = vi.fn(async () => fonts.map((f) => ({ ...f, blob: async () => new Blob([f.bytes as BlobPart]) })));
    vi.stubGlobal("queryLocalFonts", q);
    (window as unknown as { queryLocalFonts: unknown }).queryLocalFonts = q;
    vi.spyOn(navigator.permissions, "query").mockResolvedValue({ state: permission } as PermissionStatus);
    return q;
  };
  afterEach(() => { delete (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts; });

  it("returns installed bytes once local fonts are granted, and points at the TTC face", async () => {
    const ttc = makeCollection([makeFont({ ps: "Hira-W3" }), makeFont({ ps: "Hira-W6", weight: 600, fsType: 8 })]);
    stubLocal("granted", [
      { family: "Hira", style: "W3", fullName: "Hira W3", postscriptName: "Hira-W3", bytes: ttc },
      { family: "Hira", style: "W6", fullName: "Hira W6", postscriptName: "Hira-W6", bytes: ttc },
    ]);
    const f = (await getFontFile("Hira", { weight: 700 }))!;
    expect(f).toMatchObject({ source: "local", family: "Hira", format: "ttc", index: 1, postscriptName: "Hira-W6", embedding: "editable", embeddable: true });
  });
  it("never prompts silently: without permission or a gesture there are no local bytes", async () => {
    const q = stubLocal("prompt", [{ family: "Arial", style: "Regular", fullName: "Arial", postscriptName: "ArialMT", bytes: makeFont() }]);
    expect(await getFontFile("Arial", { remote: false })).toBeNull();
    expect(q).not.toHaveBeenCalled();
    expect((await getFontFile("Arial", { remote: false, gesture: true }))!.source).toBe("local");
  });
  it("reports a restricted local font", async () => {
    stubLocal("granted", [{ family: "Corp", style: "Regular", fullName: "Corp", postscriptName: "Corp", bytes: makeFont({ fsType: 2 }) }]);
    expect((await getFontFile("Corp"))!.embeddable).toBe("restricted");
  });
  it("downloads the catalog file only with the host switch and consent, then serves it from cache", async () => {
    const bytes = makeFont({ family: "Tinos", weight: 700 });
    const fetchBytes = vi.fn(async () => bytes);
    expect(await getFontFile("Tinos", { weight: 700, fetchBytes })).toBeNull();
    setRemoteEnabled(true);
    expect(await getFontFile("Tinos", { weight: 700, fetchBytes })).toBeNull();
    expect(fetchBytes).not.toHaveBeenCalled();
    setConsent(true);
    const f = (await getFontFile("tinos", { weight: 700, fetchBytes }))!;
    expect(fetchBytes).toHaveBeenCalledWith("https://raw.githubusercontent.com/google/fonts/main/ofl/tinos/Tinos-Bold.ttf");
    expect(f).toMatchObject({ source: "remote", family: "Tinos", license: "ofl", embeddable: true, weight: 700 });
    expect(await isFontFileCached(f.url!)).toBe(true);
    setRemoteEnabled(false); // offline reuse needs no network permission
    expect((await getFontFile("Tinos", { weight: 700, fetchBytes }))!.bytes).toBe(bytes);
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });
  it("returns null for a family outside the catalog or a failed download", async () => {
    setRemoteEnabled(true);
    setConsent(true);
    expect(await getFontFile("Not A Font", { fetchBytes: async () => makeFont() })).toBeNull();
    expect(await getFontFile("Lobster", { fetchBytes: async () => { throw new TypeError("offline"); } })).toBeNull();
    expect(await getFontFile("Lobster", { fetchBytes: async () => null })).toBeNull();
  });
});
