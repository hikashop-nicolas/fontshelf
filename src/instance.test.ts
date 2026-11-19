// Static instancing: axis selection (pure) and a real HarfBuzz run on a small OFL variable font.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFontFile, instanceFont, instanceLocation, instanceStyleName, parseAxes, parseFontInfo, setConsent, setHarfbuzzWasm,
  setRemoteEnabled, type FontAxis,
} from "./index.js";
import { makeFont, resetFontshelf } from "./test-utils.js";

const ax = (tag: string, min: number, def: number, max: number): FontAxis => ({ tag, min, default: def, max });

describe("instanceLocation", () => {
  it("clamps wght to the axis range", () => {
    expect(instanceLocation([ax("wght", 300, 300, 900)], 400)).toEqual({ wght: 400 });
    expect(instanceLocation([ax("wght", 300, 300, 900)], 100)).toEqual({ wght: 300 });
    expect(instanceLocation([ax("wght", 100, 100, 900)], 1000)).toEqual({ wght: 900 });
  });
  it("leaves wdth, opsz and others to their defaults", () => {
    expect(instanceLocation([ax("wdth", 75, 100, 100), ax("wght", 100, 400, 900), ax("opsz", 14, 14, 32)], 700)).toEqual({ wght: 700 });
  });
  it("uses ital=1 for italic, else 0", () => {
    const axes = [ax("wght", 100, 400, 900), ax("ital", 0, 0, 1), ax("slnt", -10, 0, 0)];
    expect(instanceLocation(axes, 400, true)).toEqual({ wght: 400, ital: 1, slnt: 0 });
    expect(instanceLocation(axes, 400, false)).toEqual({ wght: 400, ital: 0, slnt: 0 });
  });
  it("leans slnt to its minimum for italic only without an ital axis", () => {
    expect(instanceLocation([ax("slnt", -10, 0, 0)], 400, true)).toEqual({ slnt: -10 });
    expect(instanceLocation([ax("slnt", -10, 0, 0)], 400, false)).toEqual({ slnt: 0 });
    expect(instanceLocation([ax("slnt", 0, 0, 12)], 400, true)).toEqual({ slnt: 0 });
  });
  it("is empty for a static font", () => {
    expect(instanceLocation([], 700, true)).toEqual({});
  });
  it("names styles", () => {
    expect(instanceStyleName(400, false)).toBe("Regular");
    expect(instanceStyleName(400, true)).toBe("Italic");
    expect(instanceStyleName(600, true)).toBe("SemiBold Italic");
    expect(instanceStyleName(450, false)).toBe("Weight450");
  });
});

// happy-dom gives import.meta.url an http scheme, so resolve from the package root.
const hbWasm = createRequire(join(process.cwd(), "package.json")).resolve("harfbuzzjs/dist/harfbuzz-subset.wasm");
const fixture = new Uint8Array(readFileSync(join(process.cwd(), "test/fixtures/Figtree[wght].ttf")));

describe("instanceFont (HarfBuzz)", () => {
  beforeAll(() => {
    // vitest has no bundler asset for the default URL: hand over the bytes from node_modules.
    setHarfbuzzWasm(new Uint8Array(readFileSync(hbWasm)));
  });

  it("reads the fixture's axes", () => {
    expect(parseAxes(fixture)).toEqual([{ tag: "wght", min: 300, default: 300, max: 900 }]);
    expect(parseAxes(makeFont())).toEqual([]);
  });
  it("pins wght and renames for the catalog family", async () => {
    const inst = (await instanceFont(fixture, { weight: 700, family: "Figtree" }))!;
    expect(inst).toMatchObject({ location: { wght: 700 }, weight: 700, italic: false });
    const info = parseFontInfo(inst.bytes)!;
    expect(info).toMatchObject({ variable: false, weight: 700, italic: false, family: "Figtree", fullName: "Figtree Bold", postscriptName: "Figtree-Bold" });
    expect(parseAxes(inst.bytes)).toEqual([]);
    expect(inst.bytes.byteLength).toBeLessThan(fixture.byteLength);
  });
  it("clamps below the axis and keeps a valid checksum", async () => {
    const inst = (await instanceFont(fixture, { weight: 100 }))!;
    expect(parseFontInfo(inst.bytes)).toMatchObject({ variable: false, weight: 300, postscriptName: "Figtree-Light" });
    let sum = 0;
    const v = new DataView(inst.bytes.buffer, inst.bytes.byteOffset, inst.bytes.byteLength);
    for (let i = 0; i < inst.bytes.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
    expect(sum).toBe(0xb1b0afba);
  });
  it("returns null for a static font", async () => {
    expect(await instanceFont(makeFont())).toBeNull();
  });
});

describe("getFontFile({ instance: true })", () => {
  beforeEach(() => {
    resetFontshelf();
    setHarfbuzzWasm(new Uint8Array(readFileSync(hbWasm)));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("instances a variable catalog file once per location", async () => {
    setRemoteEnabled(true);
    setConsent(true);
    const fetchBytes = vi.fn(async () => fixture);
    const raw = (await getFontFile("Figtree", { weight: 600, fetchBytes }))!;
    expect(raw).toMatchObject({ variable: true, weight: [300, 900] });
    const f = (await getFontFile("Figtree", { weight: 600, instance: true, fetchBytes }))!;
    expect(f).toMatchObject({ source: "remote", family: "Figtree", variable: false, weight: 600, license: "ofl", instancedFrom: raw.url, url: raw.url });
    expect(parseFontInfo(f.bytes)).toMatchObject({ variable: false, weight: 600, family: "Figtree" });
    const again = (await getFontFile("Figtree", { weight: 600, instance: true, fetchBytes }))!;
    expect(again.bytes).toBe(f.bytes);
    const bold = (await getFontFile("Figtree", { weight: 700, instance: true, fetchBytes }))!;
    expect(bold.weight).toBe(700);
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });
  it("instances a variable local font too", async () => {
    const q = vi.fn(async () => [{ family: "Figtree", style: "Light", fullName: "Figtree Light", postscriptName: "Figtree-Light", blob: async () => new Blob([fixture as BlobPart]) }]);
    (window as unknown as { queryLocalFonts: unknown }).queryLocalFonts = q;
    vi.spyOn(navigator.permissions, "query").mockResolvedValue({ state: "granted" } as PermissionStatus);
    try {
      const f = (await getFontFile("Figtree", { weight: 500, instance: true, remote: false }))!;
      expect(f).toMatchObject({ source: "local", variable: false, weight: 500, instancedFrom: "local:Figtree-Light" });
      expect(f.url).toBeUndefined();
    } finally {
      delete (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts;
    }
  });
  it("leaves a static file alone and falls back to the variable file when HarfBuzz cannot load", async () => {
    setRemoteEnabled(true);
    setConsent(true);
    const tinos = makeFont({ family: "Tinos", weight: 700 });
    expect((await getFontFile("Tinos", { weight: 700, instance: true, fetchBytes: async () => tinos }))!.bytes).toBe(tinos);
    setHarfbuzzWasm(new Uint8Array([0, 1, 2, 3]));
    const f = (await getFontFile("Figtree", { weight: 800, instance: true, fetchBytes: async () => fixture }))!;
    expect(f).toMatchObject({ variable: true, weight: [300, 900] });
    expect(f.instancedFrom).toBeUndefined();
  });
});
