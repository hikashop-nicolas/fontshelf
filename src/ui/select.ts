// A font picker on a native <select> (robust on touch and screen readers), grouped as
// "In this document" / "Fonts" / "More fonts". The last group holds action entries
// ("Show my fonts", "Get more fonts") that run and then restore the previous choice.
import { BASE_FONTS } from "../catalog.js";
import { canDraw, buildFontGroups } from "../detect.js";
import { addDocumentFonts, getFontState, isAdded, onFontsChange, restoreFonts, showInstalledFonts } from "../registry.js";
import { setRemoteEnabled } from "../shared.js";
import { fontT } from "../strings.js";
import { requestRemoteFont, showFontToast, type DialogOptions } from "./dialogs.js";

/** Remote fonts: off, or Google Fonts (CSS2 for drawing, the google/fonts repo for files). */
export type RemoteOption = false | { provider: "google" };

export interface FontSelectOptions {
  /** Fonts the open document uses ("In this document"). */
  docFonts?: readonly string[];
  /** Offer "Show my fonts". Default true. */
  local?: boolean;
  /** Offer "Get more fonts" (and enable the network after consent). Default off. */
  remote?: RemoteOption;
  /** Always-offered fonts, kept when drawable. Default BASE_FONTS. */
  base?: readonly string[];
  /** Hosts the dialogs and the toast. Default document.body. */
  container?: HTMLElement;
  /** Extra class for the dialog panels. */
  dialogClass?: string;
  /** Apply a picked family (to the selection, cell, style...). */
  apply: (family: string) => void;
  /** An action entry is about to open a dialog: save the selection. */
  onAction?: () => void;
  /** A downloaded family is about to be applied: restore the selection. */
  onPicked?: () => void;
  /** Element to keep focused when the select is pressed (an editing surface). */
  focusTarget?: () => HTMLElement | null | undefined;
  /** Show a short status ("12 more fonts available"); default a toast in the container. */
  notify?: (text: string) => void;
}

export interface FontSelect {
  select: HTMLSelectElement;
  /** Every font in the picker (document fonts first). */
  fonts(): string[];
  has(family: string): boolean;
  /** Show a value (caret sync); it is also what an action entry restores. */
  set(value: string): void;
  /** Replace the document fonts. */
  setDocFonts(names: readonly string[]): void;
  /** Rebuild the options (after a host change). */
  refresh(): void;
  teardown(): void;
}

// document.createElement, not new Option(): some DOMs (happy-dom) lack the constructor.
const opt = (text: string, value: string): HTMLOptionElement => {
  const o = document.createElement("option");
  o.textContent = text;
  o.value = value;
  return o;
};

const ACTION = "\u0001"; // value prefix of the action entries
export const SHOW_MINE_VALUE = `${ACTION}local`;
export const GET_MORE_VALUE = `${ACTION}remote`;

export function createFontSelect(opts: FontSelectOptions): FontSelect {
  const remote = !!opts.remote && opts.remote.provider === "google";
  const localOn = opts.local !== false;
  const base = opts.base ?? BASE_FONTS;
  const dialogOpts: DialogOptions = { container: opts.container, className: opts.dialogClass };
  if (remote) setRemoteEnabled(true);
  let docFonts = [...(opts.docFonts ?? [])];
  let unregister = addDocumentFonts(docFonts);
  let all: string[] = [];
  let disposed = false;

  const select = document.createElement("select");
  select.title = fontT("font");
  select.setAttribute("aria-label", fontT("font"));

  const render = (): void => {
    const keep = select.value;
    const st = getFontState();
    const groups = buildFontGroups({ docFonts, base, extra: [...st.installed, ...st.added], canDraw: (n) => isAdded(n) || canDraw(n) });
    all = [...groups.doc.map((d) => d.name), ...groups.fonts];
    const head = opt(fontT("font"), "");
    head.disabled = true;
    const parts: (HTMLOptionElement | HTMLOptGroupElement)[] = [head];
    const group = (label: string, list: HTMLOptionElement[]): void => {
      if (!list.length) return;
      const g = document.createElement("optgroup");
      g.label = label;
      g.append(...list);
      parts.push(g);
    };
    group(fontT("fontsInDocument"), groups.doc.map((d) => opt(d.missing ? fontT("fontMissing", { name: d.name }) : d.name, d.name)));
    group(fontT("fontsAll"), groups.fonts.map((f) => opt(f, f)));
    const actions: HTMLOptionElement[] = [];
    if (localOn && !st.installedFull) actions.push(opt(fontT("fontsShowMine"), SHOW_MINE_VALUE));
    if (remote) actions.push(opt(fontT("fontsGetMore"), GET_MORE_VALUE));
    group(fontT("fontsMore"), actions);
    select.replaceChildren(...parts);
    select.value = all.includes(keep) ? keep : "";
  };

  // The value before the current interaction, restored after an action entry.
  let prev = "";
  let navKey = false;
  const remember = (): void => { if (!select.value.startsWith(ACTION)) prev = select.value; };
  select.addEventListener("pointerdown", remember);
  select.addEventListener("focus", remember);
  select.addEventListener("mousedown", () => opts.focusTarget?.()?.focus());
  // Arrow keys on a closed select fire change per step: never run an action from those.
  select.addEventListener("keydown", (e) => {
    remember();
    navKey = /^(Arrow|Page|Home|End)/.test(e.key);
  });
  select.addEventListener("change", () => {
    const v = select.value;
    const fromNav = navKey;
    navKey = false;
    if (!v) return;
    if (!v.startsWith(ACTION)) {
      prev = v;
      opts.apply(v);
      return;
    }
    select.value = prev;
    if (fromNav) return;
    opts.onAction?.();
    if (v === SHOW_MINE_VALUE) void showMine();
    else if (v === GET_MORE_VALUE) void getMore();
  });

  const notify = (text: string): void => {
    if (opts.notify) opts.notify(text);
    else showFontToast(opts.container ?? document.body, text);
  };

  const showMine = async (): Promise<void> => {
    const before = all.length;
    await showInstalledFonts({ gesture: true });
    if (disposed) return;
    render();
    const n = all.length - before;
    notify(n > 0 ? fontT("fontsFound", { n }) : fontT("fontsNoneFound"));
  };

  const getMore = async (): Promise<void> => {
    const family = await requestRemoteFont(dialogOpts);
    if (!family || disposed) return;
    render();
    opts.onPicked?.();
    select.value = family;
    prev = family;
    opts.apply(family);
  };

  const off = onFontsChange(() => { if (!disposed) render(); });
  render();
  restoreFonts({ local: localOn, remote, docFonts });

  return {
    select,
    fonts: () => all,
    has: (family) => all.includes(family),
    set: (value) => {
      select.value = value;
      prev = select.value;
    },
    setDocFonts: (names) => {
      docFonts = [...names];
      unregister();
      unregister = addDocumentFonts(docFonts);
    },
    refresh: render,
    teardown: () => {
      disposed = true;
      off();
      unregister();
    },
  };
}
