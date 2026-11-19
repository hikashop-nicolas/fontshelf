// Google Fonts CSS2 loading, for drawing a catalog family in the page. Gated by remoteAllowed().
import { GROUP_SAMPLE, findWebFont, type WebFont } from "./catalog.js";
import { cssFamily } from "./detect.js";
import { remoteAllowed } from "./shared.js";

const GOOGLE_CSS = "https://fonts.googleapis.com/css2";
const AXES: Record<WebFont["v"], string> = {
  bi: ":ital,wght@0,400;0,700;1,400;1,700",
  b: ":wght@400;700",
  i: ":ital@0;1",
  "": "",
};
const familyParam = (f: string, v: WebFont["v"]): string => `family=${encodeURIComponent(f).replace(/%20/g, "+")}${AXES[v]}`;

/** The CSS2 API URL for one or more families. */
export function googleCssUrl(families: readonly { family: string; v: WebFont["v"] }[], text?: string): string {
  const q = families.map((f) => familyParam(f.family, f.v));
  if (text) q.push(`text=${encodeURIComponent(text)}`);
  else q.push("display=swap");
  return `${GOOGLE_CSS}?${q.join("&")}`;
}

/** The axis sets to try, richest first (a wrong guess makes the API answer 400). */
export function axisFallbacks(v: WebFont["v"]): WebFont["v"][] {
  return [...new Set<WebFont["v"]>(["bi", v, ""])];
}

export type Fetcher = (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;
const defaultFetch: Fetcher = (url) => fetch(url, { mode: "cors", credentials: "omit" });

const injected = new Map<string, Promise<boolean>>();
const injectCss = (css: string, tag: string): void => {
  const s = document.createElement("style");
  s.dataset.fontshelfFont = tag;
  s.textContent = css;
  document.head.appendChild(s);
};

/** Load a catalog family's @font-face rules from Google Fonts. False on failure or without consent. */
export function loadWebFont(family: string, fetcher: Fetcher = defaultFetch): Promise<boolean> {
  const wf = findWebFont(family);
  if (!wf || !remoteAllowed()) return Promise.resolve(false);
  const key = wf.family.toLowerCase();
  const prev = injected.get(key);
  if (prev) return prev;
  const p = (async () => {
    for (const v of axisFallbacks(wf.v)) {
      try {
        const res = await fetcher(googleCssUrl([{ family: wf.family, v }]));
        if (!res.ok) continue;
        injectCss(await res.text(), wf.family);
        try { await document.fonts?.load(`16px ${cssFamily(wf.family)}`, GROUP_SAMPLE[wf.group] ?? wf.family); } catch { /* still usable */ }
        return true;
      } catch {
        return false; // offline or blocked: no point trying other axes
      }
    }
    return false;
  })();
  injected.set(key, p);
  p.then((ok) => { if (!ok) injected.delete(key); });
  return p;
}

/** The renamed family a preview subset is loaded under. */
export const previewFamily = (family: string): string => `fontshelf-preview ${family}`;

/** Load tiny name-only subsets for previews, renamed so they never stand in for the real font. */
const previewed = new Set<string>();
export async function loadWebFontPreviews(fonts: readonly WebFont[], fetcher: Fetcher = defaultFetch, batch = 12): Promise<void> {
  if (!remoteAllowed()) return;
  const todo = fonts.filter((f) => !previewed.has(f.family));
  for (let i = 0; i < todo.length; i += batch) {
    const part = todo.slice(i, i + batch);
    const text = [...new Set(part.map((f) => f.family + (GROUP_SAMPLE[f.group] ?? "")).join(""))].join("");
    try {
      const res = await fetcher(googleCssUrl(part.map((f) => ({ family: f.family, v: "" })), text));
      if (!res.ok) continue;
      const css = (await res.text()).replace(/font-family:\s*'([^']+)'/g, (_, f: string) => `font-family: '${previewFamily(f)}'`);
      injectCss(css, "preview");
      for (const f of part) previewed.add(f.family);
    } catch {
      return; // offline
    }
  }
}
