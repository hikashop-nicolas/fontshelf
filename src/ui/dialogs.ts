// The consent and catalog dialogs, plain DOM. Theme with the --fontshelf-* CSS variables on
// the container (or any ancestor); strings come from fontT().
import { GROUP_SAMPLE, WEB_FONTS } from "../catalog.js";
import { cssFamily } from "../detect.js";
import { loadWebFontPreviews, previewFamily } from "../google.js";
import { addRemoteFamily } from "../registry.js";
import { hasConsent, isRemoteEnabled, setConsent } from "../shared.js";
import { fontT, fontUiLang } from "../strings.js";

const CSS = `
.fontshelf-overlay:lang(ko), .fontshelf-toast:lang(ko) { --fontshelf-ui-family: system-ui, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", "Noto Sans CJK KR", "Nanum Gothic", sans-serif; }
.fontshelf-overlay { position: fixed; inset: 0; z-index: var(--fontshelf-z, 1000); display: flex; align-items: center; justify-content: center; background: var(--fontshelf-backdrop, rgba(0,0,0,.45)); }
.fontshelf-overlay[hidden] { display: none; }
.fontshelf-dialog { box-sizing: border-box; min-width: 280px; max-width: 400px; background: var(--fontshelf-bg, #2b2f36); color: var(--fontshelf-fg, #e6e8ec); border: 1px solid var(--fontshelf-border, #4a4f57); border-radius: 10px; padding: 16px; box-shadow: 0 12px 40px rgba(0,0,0,.55); display: flex; flex-direction: column; gap: 10px; font: var(--fontshelf-font, 13px/1.3 var(--fontshelf-ui-family, system-ui, sans-serif)); }
.fontshelf-dialog.fontshelf-catalog { width: min(440px, calc(100vw - 32px)); max-width: none; max-height: calc(100vh - 32px); }
.fontshelf-title { font-size: 15px; font-weight: 600; }
.fontshelf-note { margin: 0; line-height: 1.45; opacity: .9; }
.fontshelf-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px; }
.fontshelf-button { font: 13px/1 var(--fontshelf-ui-family, system-ui, sans-serif); padding: 6px 10px; border: 0; border-radius: 5px; background: transparent; color: inherit; cursor: pointer; }
.fontshelf-button:hover { background: var(--fontshelf-hover-strong, #3a3f47); }
.fontshelf-button.fontshelf-primary { background: var(--fontshelf-accent, #6e7bff); color: var(--fontshelf-accent-fg, #fff); }
.fontshelf-button:focus-visible, .fontshelf-item:focus-visible, .fontshelf-search:focus-visible { outline: 2px solid var(--fontshelf-accent, #6e7bff); outline-offset: 1px; }
.fontshelf-search { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--fontshelf-border, #4a4f57); border-radius: 6px; background: var(--fontshelf-input-bg, #1f2329); color: inherit; font: inherit; }
.fontshelf-list { display: flex; flex-direction: column; gap: 2px; min-height: 120px; max-height: 50vh; overflow-y: auto; overscroll-behavior: contain; }
.fontshelf-group { position: sticky; top: 0; padding: 6px 4px 2px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; opacity: .75; background: var(--fontshelf-bg, #2b2f36); }
.fontshelf-group[hidden], .fontshelf-item[hidden] { display: none; }
.fontshelf-item { display: flex; align-items: baseline; gap: 10px; min-height: 36px; padding: 4px 8px; border: 1px solid transparent; border-radius: 6px; background: none; color: inherit; font-size: 17px; text-align: left; cursor: pointer; }
.fontshelf-item:hover { background: var(--fontshelf-hover, #1f2329); border-color: var(--fontshelf-border, #4a4f57); }
.fontshelf-sample { margin-left: auto; opacity: .8; }
.fontshelf-status { min-height: 1.3em; font-size: 12px; }
.fontshelf-toast { position: absolute; z-index: 20; top: 8px; left: 12px; max-width: 300px; background: var(--fontshelf-toast-bg, #fff); color: var(--fontshelf-toast-fg, #222); border: 1px solid #c9c9c9; border-radius: 7px; box-shadow: 0 6px 22px rgba(0,0,0,.32); padding: 9px 11px; font: 13px/1.45 var(--fontshelf-ui-family, system-ui, sans-serif); }
@media (prefers-reduced-motion: reduce) { .fontshelf-overlay, .fontshelf-toast { transition: none !important; } }
`;

/** Add the stylesheet once (idempotent). Hosts may call it early or ship their own rules. */
export function injectFontshelfStyles(doc: Document = document): void {
  if (doc.getElementById("fontshelf-style")) return;
  const s = doc.createElement("style");
  s.id = "fontshelf-style";
  s.textContent = CSS;
  doc.head.appendChild(s);
}

export interface DialogOptions {
  /** Where the overlay is appended (inherits its CSS variables). Default document.body. */
  container?: HTMLElement;
  /** Extra class on the dialog panel. */
  className?: string;
}

let seq = 0;

interface Shell { overlay: HTMLElement; panel: HTMLElement; actions: HTMLElement; close: () => void }

// A modal: role=dialog, Tab trapped, Escape and backdrop close, focus returned to the opener.
// lang picks CJK glyph variants and Turkish casing (the uppercase group labels).
export function setLang(el: HTMLElement): void {
  const lang = fontUiLang();
  if (lang) el.lang = lang;
}

function shell(cls: string, title: string, opts: DialogOptions, onClose: () => void, initial: () => HTMLElement | null): Shell {
  injectFontshelfStyles();
  const opener = document.activeElement as HTMLElement | null;
  const overlay = document.createElement("div");
  overlay.className = "fontshelf-overlay";
  setLang(overlay);
  const panel = document.createElement("div");
  panel.className = `fontshelf-dialog ${cls}${opts.className ? ` ${opts.className}` : ""}`;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  const h = document.createElement("div");
  h.className = "fontshelf-title";
  h.id = `fontshelf-title-${++seq}`;
  h.textContent = title;
  panel.setAttribute("aria-labelledby", h.id);
  const actions = document.createElement("div");
  actions.className = "fontshelf-actions";
  panel.append(h, actions);
  overlay.appendChild(panel);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    overlay.remove();
    opener?.focus?.();
    onClose();
  };
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== "Tab") return;
    const f = [...panel.querySelectorAll<HTMLElement>("button:not([disabled]),input:not([disabled])")].filter((el) => !el.hidden);
    if (!f.length) return;
    const first = f[0]!;
    const last = f[f.length - 1]!;
    const a = document.activeElement;
    if (e.shiftKey && (a === first || !panel.contains(a))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
  });
  (opts.container ?? document.body).appendChild(overlay);
  setTimeout(() => { if (!closed) initial()?.focus(); }, 0);
  return { overlay, panel, actions, close };
}

function button(label: string, primary = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = primary ? "fontshelf-button fontshelf-primary" : "fontshelf-button";
  b.textContent = label;
  return b;
}

/** Ask for the download consent. Resolves true after "Continue" (consent is then stored). */
export function openConsentDialog(opts: DialogOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    let okBtn: HTMLButtonElement | null = null;
    const { panel, actions, close } = shell("fontshelf-consent", fontT("fontsGetTitle"), opts, () => resolve(ok), () => okBtn);
    const p = document.createElement("p");
    p.className = "fontshelf-note";
    p.textContent = fontT("fontsConsent");
    panel.insertBefore(p, actions);
    const cancel = button(fontT("cancel"));
    okBtn = button(fontT("fontsContinue"), true);
    actions.append(cancel, okBtn);
    cancel.addEventListener("click", close);
    okBtn.addEventListener("click", () => {
      ok = true;
      setConsent(true);
      close();
    });
  });
}

/** The searchable catalog. Picking a family loads it; resolves with it, or null when closed. */
export function openCatalogDialog(opts: DialogOptions = {}): Promise<string | null> {
  return new Promise((resolve) => {
    let picked: string | null = null;
    let search: HTMLInputElement | null = null;
    const { panel, actions, close } = shell("fontshelf-catalog", fontT("fontsGetTitle"), opts, () => resolve(picked), () => search);
    const note = document.createElement("p");
    note.className = "fontshelf-note";
    note.textContent = fontT("fontsCatalogNote");
    search = document.createElement("input");
    search.type = "search";
    search.className = "fontshelf-search";
    search.placeholder = fontT("fontsSearch");
    search.setAttribute("aria-label", fontT("fontsSearch"));
    const list = document.createElement("div");
    list.className = "fontshelf-list";
    const status = document.createElement("div");
    status.className = "fontshelf-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const rows: { el: HTMLElement; key: string; head: HTMLElement }[] = [];
    const heads: HTMLElement[] = [];
    let head: HTMLElement | null = null;
    let lastGroup = "";
    let busy = false;
    for (const wf of WEB_FONTS) {
      const label = fontT(`fontGroup_${wf.group}`);
      if (wf.group !== lastGroup) {
        head = document.createElement("div");
        head.className = "fontshelf-group";
        head.textContent = label;
        list.appendChild(head);
        heads.push(head);
        lastGroup = wf.group;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "fontshelf-item";
      b.style.fontFamily = `${cssFamily(previewFamily(wf.family))}, ${cssFamily(wf.family)}, system-ui, sans-serif`;
      b.textContent = wf.family;
      const sample = GROUP_SAMPLE[wf.group];
      if (sample) {
        const s = document.createElement("span");
        s.className = "fontshelf-sample";
        s.textContent = sample;
        s.setAttribute("aria-hidden", "true");
        b.appendChild(s);
      }
      b.setAttribute("aria-label", `${wf.family}, ${label}`);
      b.addEventListener("click", async () => {
        if (busy) return;
        busy = true;
        status.textContent = fontT("fontsLoading", { name: wf.family });
        const ok = await addRemoteFamily(wf.family);
        busy = false;
        if (!ok) {
          status.textContent = fontT("fontsLoadFailed", { name: wf.family });
          return;
        }
        status.textContent = "";
        picked = wf.family;
        close();
      });
      list.appendChild(b);
      rows.push({ el: b, key: `${wf.family} ${label}`.toLowerCase(), head: head! });
    }
    search.addEventListener("input", () => {
      const q = search!.value.trim().toLowerCase();
      const shown = new Set<HTMLElement>();
      for (const r of rows) {
        r.el.hidden = !!q && !r.key.includes(q);
        if (!r.el.hidden) shown.add(r.head);
      }
      for (const h of heads) h.hidden = !shown.has(h);
    });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        rows.find((r) => !r.el.hidden)?.el.click();
      }
    });
    const closeBtn = button(fontT("close"));
    closeBtn.addEventListener("click", close);
    actions.append(closeBtn);
    panel.insertBefore(note, actions);
    panel.insertBefore(search, actions);
    panel.insertBefore(list, actions);
    panel.insertBefore(status, actions);
    void loadWebFontPreviews(WEB_FONTS);
  });
}

/**
 * "Get more fonts": the consent dialog first when needed, then the catalog. Resolves with the
 * loaded family, or null (cancelled, or remote fonts not enabled by the host).
 */
export async function requestRemoteFont(opts: DialogOptions = {}): Promise<string | null> {
  if (!isRemoteEnabled()) return null;
  if (!hasConsent() && !(await openConsentDialog(opts))) return null;
  return openCatalogDialog(opts);
}

/** A short status message in `container` (positioned: give it position: relative). */
export function showFontToast(container: HTMLElement, text: string, ms = 2500): void {
  injectFontshelfStyles();
  const el = document.createElement("div");
  el.className = "fontshelf-toast";
  setLang(el);
  el.setAttribute("role", "status");
  el.textContent = text;
  container.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
