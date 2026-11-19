// @vitest-environment node
// The real Klee One SemiBold from fonts.gstatic.com (skipped offline).
import { describe, expect, it } from "vitest";
import { catalogFiles, faceNames, parseFontInfo, renameFace } from "./index.js";

const file = catalogFiles("Klee One")?.files.find((f) => f.weight === 600);
const raw = file
  ? await fetch(file.url, { signal: AbortSignal.timeout(15000) })
      .then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : null))
      .catch(() => null)
  : null;

describe("Klee One SemiBold from Google Fonts", () => {
  it.skipIf(!raw)("is named only in ID 1 as served, and reads as Klee One once renamed", () => {
    expect(faceNames(raw!)[1]).toBe("Klee One SemiBold");
    expect(faceNames(raw!)[16]).toBeUndefined();
    const out = renameFace(raw!, "Klee One");
    expect(faceNames(out)).toMatchObject({ 1: "Klee One", 2: "Bold", 16: "Klee One", 17: "SemiBold" });
    expect(parseFontInfo(out)).toMatchObject({ family: "Klee One", weight: 600, italic: false });
  });
});
