// Fonts loaded from files: parsing, registration, getFontFile, persistence, the picker entry.
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOAD_FILE_VALUE, MAX_FONT_FILE_BYTES, MAX_STORED_FONT_BYTES, createFontSelect, extractFace, getFontFile, getFontState,
  getLoadedFonts, loadFontFile, parseFontInfo, readFontFaces, removeLoadedFont, requestFontFile, restoreLoadedFonts,
  setFontLocale, woff2Tables,
} from "./index.js";
import { nameFromFile } from "./loaded.js";
import { makeCollection, makeFont, makeWoff, makeWoff2, resetFontshelf } from "./test-utils.js";

const font = (family: string, o: Parameters<typeof makeFont>[0] = {}): Uint8Array =>
  makeFont({ ...o, names: [[1, family], [2, o.italic ? "Italic" : "Regular"], [4, `${family} ${o.weight ?? 400}`], [6, `${family.replace(/ /g, "")}-${o.weight ?? 400}`]] });

const fresh = (): void => {
  resetFontshelf();
  vi.stubGlobal("indexedDB", new IDBFactory());
};

beforeEach(() => { fresh(); setFontLocale("en"); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("parsing", () => {
  it("reads style names and the scripts the Unicode ranges claim", () => {
    const info = parseFontInfo(makeFont({ ranges: [1 | (1 << 9), (1 << 17) | (1 << 18), 0, 0], names: [[1, "A"], [2, "Bold"], [17, "SemiBold"]] }))!;
    expect(info.style).toBe("SemiBold");
    expect(info.scripts).toEqual(["latin", "cyrillic", "kana"]);
  });
  it("lists the faces of a file, each face of a collection", async () => {
    const ttc = makeCollection([font("Coll", { weight: 400 }), font("Coll", { weight: 700 })]);
    const faces = await readFontFaces(ttc, "coll.ttc");
    expect(faces!.map((f) => [f.index, f.family, f.weight])).toEqual([[0, "Coll", 400], [1, "Coll", 700]]);
    expect(await readFontFaces(new TextEncoder().encode("nope, not a font"))).toBeNull();
  });
  it("extracts a collection face into a standalone font", () => {
    const ttc = makeCollection([font("Coll", { weight: 400 }), font("Coll", { weight: 700, fsType: 4 })]);
    const one = extractFace(ttc, 1)!;
    expect(parseFontInfo(one)).toMatchObject({ format: "ttf", numFonts: 1, weight: 700, embedding: "preview-print", postscriptName: "Coll-700" });
    expect(extractFace(ttc, 2)).toBeNull();
  });
  it("unwraps WOFF and reads WOFF2 names", async () => {
    const sfnt = font("Woffy", { weight: 600 });
    const faces = await readFontFaces(await makeWoff(sfnt), "x.woff");
    expect(faces).toMatchObject([{ family: "Woffy", weight: 600 }]);
    const w2 = await makeWoff2(font("Woffy Two", { weight: 300, fvar: true }));
    expect(parseFontInfo((await woff2Tables(w2))!)).toMatchObject({ family: "Woffy Two", weight: 300, variable: true });
    expect(await readFontFaces(w2, "w.woff2")).toMatchObject([{ family: "Woffy Two", weight: 300 }]);
  });
});

describe("file names", () => {
  it("guesses a WOFF2 family from its file name when Brotli is missing", () => {
    expect(nameFromFile("cinzel-latin-900-normal.woff2")).toEqual({ family: "Cinzel", weight: 900, italic: false });
    expect(nameFromFile("Inter-BoldItalic.woff2")).toEqual({ family: "Inter", weight: 700, italic: true });
    expect(nameFromFile("My_Brand Sans.woff2")).toEqual({ family: "My Brand Sans", weight: 400, italic: false });
  });
});

describe("loadFontFile", () => {
  it("registers the family for pickers and engines, and keeps it", async () => {
    const r = await loadFontFile(font("My Hand", { weight: 400, ranges: [1, 0, 0, 0] }), { name: "MyHand.ttf" });
    expect(r).toMatchObject({ ok: true, family: "My Hand", persisted: true });
    expect(getFontState().loaded).toEqual(["My Hand"]);
    expect(getFontState().added).toContain("My Hand");
    expect(getLoadedFonts()[0]).toMatchObject({ family: "My Hand", fileName: "MyHand.ttf", format: "ttf", embeddable: true, scripts: ["latin"] });
    const file = await getFontFile("my hand", { weight: 700 });
    expect(file).toMatchObject({ source: "loaded", family: "My Hand", format: "ttf", weight: 400 });
    expect(await getFontFile("My Hand", { loaded: false, remote: false })).toBeNull();
    // Next session: the state is gone, the store brings it back.
    resetFontshelf();
    expect(getFontState().loaded).toEqual([]);
    expect(await restoreLoadedFonts()).toBe(1);
    expect(getFontState().loaded).toEqual(["My Hand"]);
    expect((await getFontFile("My Hand"))?.source).toBe("loaded");
  });
  it("picks the nearest loaded face and serves WOFF as sfnt bytes", async () => {
    await loadFontFile(await makeWoff(font("Fam", { weight: 400 })), { name: "fam.woff" });
    await loadFontFile(font("Fam", { weight: 700 }), { name: "fam-bold.ttf" });
    await loadFontFile(font("Fam", { weight: 400, italic: true }), { name: "fam-it.ttf" });
    expect((await getFontFile("Fam", { weight: 600 }))!.weight).toBe(700);
    expect((await getFontFile("Fam", { italic: true }))!.italic).toBe(true);
    const reg = await getFontFile("Fam");
    expect(reg).toMatchObject({ weight: 400, format: "ttf" });
    expect(String.fromCharCode(...reg!.bytes.subarray(0, 4))).not.toBe("wOFF");
  });
  it("loads chosen collection faces only, as standalone fonts", async () => {
    const ttc = makeCollection([font("Coll", { weight: 400 }), font("Coll", { weight: 700 })]);
    const r = await loadFontFile(ttc, { name: "c.ttc", faces: [1] });
    expect(r.ok && r.fonts.map((f) => [f.index, f.weight])).toEqual([[1, 700]]);
    const f = (await getFontFile("Coll"))!;
    expect(f).toMatchObject({ weight: 700, format: "ttf", index: 0 });
    // Loading the other face later adds it to the same stored file.
    await loadFontFile(ttc, { name: "c.ttc", faces: [0] });
    resetFontshelf();
    expect(await restoreLoadedFonts()).toBe(2);
  });
  it("does not offer a WOFF2 to engines (page only)", async () => {
    await loadFontFile(await makeWoff2(font("Page Only")), { name: "p.woff2" });
    expect(getFontState().loaded).toEqual(["Page Only"]);
    expect(getLoadedFonts()[0]).toMatchObject({ format: "woff2", embeddable: false });
    expect(await getFontFile("Page Only", { local: false, remote: false })).toBeNull();
  });
  it("refuses junk and oversized files", async () => {
    expect(await loadFontFile(new TextEncoder().encode("garbage garbage"), { name: "a.ttf" })).toEqual({ ok: false, error: "invalid" });
    const big = { size: MAX_FONT_FILE_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Blob;
    expect(await loadFontFile(big)).toEqual({ ok: false, error: "too-big" });
  });
  it("works for the session only when the store is full", async () => {
    await loadFontFile(font("Filler"), { name: "f.ttf" });
    const db = await new Promise<IDBDatabase>((res) => { const q = indexedDB.open("fontshelf", 1); q.onsuccess = () => res(q.result); });
    await new Promise<void>((res) => {
      const tx = db.transaction("loaded", "readwrite");
      const st = tx.objectStore("loaded");
      st.getAll().onsuccess = (e) => {
        const rec = (e.target as IDBRequest<{ size: number }[]>).result[0]!;
        st.put({ ...rec, size: MAX_STORED_FONT_BYTES });
      };
      tx.oncomplete = () => res();
    });
    db.close();
    const r = await loadFontFile(font("Too Many"), { name: "t.ttf" });
    expect(r).toMatchObject({ ok: true, persisted: false });
    expect(getFontState().loaded).toEqual(["Filler", "Too Many"]);
  });
  it("forgets a removed family, in the page and the store", async () => {
    await loadFontFile(font("Gone Soon"), { name: "g.ttf" });
    await removeLoadedFont("gone soon");
    expect(getFontState().loaded).toEqual([]);
    expect(getFontState().added).not.toContain("Gone Soon");
    resetFontshelf();
    expect(await restoreLoadedFonts()).toBe(0);
  });
  it("is session only without IndexedDB", async () => {
    vi.stubGlobal("indexedDB", undefined);
    expect(await loadFontFile(font("No Store"))).toMatchObject({ ok: true, persisted: false });
  });
});

describe("picker", () => {
  it("offers Load a font file, opens a file input, then applies the family", async () => {
    const apply = vi.fn();
    const sel = createFontSelect({ apply });
    const entry = [...sel.select.options].find((o) => o.value === LOAD_FILE_VALUE)!;
    expect(entry.textContent).toBe("Load a font file…");
    let input: HTMLInputElement | null = null;
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) { input = this; });
    sel.select.value = LOAD_FILE_VALUE;
    sel.select.dispatchEvent(new Event("change"));
    expect(input!.type).toBe("file");
    expect(input!.accept).toContain(".ttf");
    expect(input!.isConnected).toBe(true);
    const file = new File([font("Picked Face") as BlobPart], "picked.otf");
    Object.defineProperty(input!, "files", { value: [file] });
    input!.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith("Picked Face"));
    expect(sel.select.value).toBe("Picked Face");
    expect(input!.isConnected).toBe(false);
    sel.teardown();
    const off = createFontSelect({ apply, file: false });
    expect([...off.select.options].some((o) => o.value === LOAD_FILE_VALUE)).toBe(false);
    off.teardown();
  });
  it("asks which face of a collection, or takes all", async () => {
    const ttc = makeCollection([font("Coll", { weight: 400 }), font("Coll", { weight: 700 })]);
    const p = requestFontFile({ file: new File([ttc as BlobPart], "c.ttc") });
    await vi.waitFor(() => expect(document.querySelector(".fontshelf-face")).not.toBeNull());
    expect([...document.querySelectorAll(".fontshelf-face")].map((b) => b.textContent)).toEqual(["Coll 400", "Coll 700"]);
    (document.querySelector(".fontshelf-dialog .fontshelf-primary") as HTMLButtonElement).click();
    expect(await p).toBe("Coll");
    expect(getLoadedFonts().map((f) => f.weight)).toEqual([400, 700]);
  });
  it("says why a file was refused", async () => {
    const notify = vi.fn();
    expect(await requestFontFile({ file: new File(["not a font"], "readme.ttf"), notify })).toBeNull();
    expect(notify).toHaveBeenCalledWith("Could not read readme.ttf as a font.");
    setFontLocale("fr");
    const big = new File(["x"], "huge.ttf");
    Object.defineProperty(big, "size", { value: MAX_FONT_FILE_BYTES + 1 });
    expect(await requestFontFile({ file: big, notify })).toBeNull();
    expect(notify).toHaveBeenLastCalledWith("huge.ttf est trop volumineux (plus de 50 Mo).");
  });
});
