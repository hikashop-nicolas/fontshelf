// Shared state across editors, strings, and the consent/catalog dialog flow.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addDocumentFonts, createFontSelect, fontT, getFontLocale, getFontState, hasConsent, onFontsChange, openConsentDialog,
  readFontPrefs, requestRemoteFont, setConsent, setFontLocale, setFontStrings, setRemoteEnabled, showInstalledFonts,
} from "./index.js";
import en from "./locales/en.js";
import fr from "./locales/fr.js";
import de from "./locales/de.js";
import es from "./locales/es.js";
import pt from "./locales/pt.js";
import ru from "./locales/ru.js";
import ja from "./locales/ja.js";
import zh from "./locales/zh.js";
import { resetFontshelf } from "./test-utils.js";

beforeEach(() => { resetFontshelf(); setFontLocale("en"); setFontStrings(null); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("registry", () => {
  it("aggregates document fonts and notifies subscribers", () => {
    const fn = vi.fn();
    const off = onFontsChange(fn);
    const a = addDocumentFonts(["Calibri", "Arial"]);
    addDocumentFonts(["calibri", "Cambria"]);
    expect(getFontState().document).toEqual(["Arial", "Calibri", "Cambria"]);
    a();
    expect(getFontState().document).toEqual(["calibri", "Cambria"]);
    expect(fn).toHaveBeenCalledTimes(3);
    off();
    setRemoteEnabled(true);
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it("shares installed fonts found by one editor with every picker", async () => {
    const one = createFontSelect({ apply: () => {} });
    const two = createFontSelect({ apply: () => {} });
    vi.spyOn(navigator.permissions, "query").mockResolvedValue({ state: "granted" } as PermissionStatus);
    (window as unknown as { queryLocalFonts: unknown }).queryLocalFonts = async () => [{ family: "Shared Face", style: "Regular" }];
    const r = await showInstalledFonts({ gesture: true });
    delete (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts;
    expect(r).toEqual({ found: 1, full: true });
    expect(one.has("Shared Face")).toBe(true);
    expect(two.has("Shared Face")).toBe(true);
    // The full list is known: "Show my fonts" disappears.
    expect(Array.from(two.select.options).some((o) => o.value.endsWith("local"))).toBe(false);
    expect(readFontPrefs().local).toBe(true);
  });
  it("keeps one consent flag, remembered", () => {
    expect(hasConsent()).toBe(false);
    setConsent(true);
    expect(readFontPrefs().consent).toBe(true);
    resetFontshelf();
    expect(hasConsent()).toBe(false);
  });
});

describe("strings", () => {
  const LOCALES = { en, fr, de, es, pt, ru, ja, zh };
  it("has every key in all 8 languages, without em-dashes", () => {
    for (const [code, dict] of Object.entries(LOCALES)) {
      expect(Object.keys(dict).sort(), code).toEqual(Object.keys(en).sort());
      for (const v of Object.values(dict)) expect(v).not.toContain(String.fromCharCode(0x2014));
    }
  });
  it("names Google Fonts, and only Google, in every consent text", () => {
    for (const dict of Object.values(LOCALES)) {
      expect(dict.fontsConsent).toContain("Google Fonts");
      expect(dict.fontsConsent).not.toContain("GitHub");
      expect(dict.fontsConsent).toMatch(/IP/);
    }
  });
  it("switches locale and lets the host override", () => {
    setFontLocale("fr-CA");
    expect(getFontLocale()).toBe("fr");
    expect(fontT("fontsFound", { n: 3 })).toBe("3 polices de plus disponibles");
    setFontStrings({ fontsFound: "{n} extra" });
    expect(fontT("fontsFound", { n: 3 })).toBe("3 extra");
    setFontStrings((k) => (k === "font" ? "Typeface" : undefined));
    expect(fontT("font")).toBe("Typeface");
    expect(fontT("cancel")).toBe("Annuler");
    setFontLocale("xx");
    expect(getFontLocale()).toBe("en");
  });
});

describe("dialogs", () => {
  it("does nothing when the host has not enabled remote fonts", async () => {
    expect(await requestRemoteFont()).toBeNull();
    expect(document.querySelector(".fontshelf-overlay")).toBeNull();
  });
  it("records consent on Continue and opens the catalog", async () => {
    const fetch = vi.fn(async (_url: string) => ({ ok: false, text: async () => "" }));
    vi.stubGlobal("fetch", fetch);
    setRemoteEnabled(true);
    const p = requestRemoteFont();
    const dlg = document.querySelector(".fontshelf-consent")!;
    expect(dlg.getAttribute("role")).toBe("dialog");
    expect(dlg.textContent).toContain("Google Fonts");
    (dlg.querySelector(".fontshelf-primary") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(hasConsent()).toBe(true);
    const cat = document.querySelector(".fontshelf-catalog")!;
    expect(cat.querySelectorAll(".fontshelf-item").length).toBeGreaterThan(150);
    const search = cat.querySelector<HTMLInputElement>(".fontshelf-search")!;
    search.value = "klee";
    search.dispatchEvent(new Event("input"));
    expect([...cat.querySelectorAll<HTMLElement>(".fontshelf-item")].filter((b) => !b.hidden).map((b) => b.firstChild!.textContent)).toEqual(["Klee One"]);
    cat.parentElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await p).toBeNull();
    expect(fetch.mock.calls[0]![0]).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?/); // previews, after consent only
  });
  it("cancel leaves consent off", async () => {
    const p = openConsentDialog();
    (document.querySelector(".fontshelf-consent .fontshelf-button:not(.fontshelf-primary)") as HTMLButtonElement).click();
    expect(await p).toBe(false);
    expect(hasConsent()).toBe(false);
  });
});
