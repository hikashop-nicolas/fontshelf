# fontshelf

One font service for browser editors. It finds the fonts installed on the device, offers a
curated catalog of 165 Google Fonts families behind a single in-app consent, hands engines
the plain TTF/OTF bytes they need (WebGL text, PDF writers, libass), says whether a font may
be embedded, and keeps every editor on a page in sync. Framework-agnostic, plain DOM, no
runtime dependencies.

Used by [richdoc](https://github.com/hikashop-nicolas/richdoc) and meant for sheetedit,
subedit and the slide and PDF editors of
**[Omnitext](https://hikashop-nicolas.github.io/omnitext/)**.

```sh
npm install github:hikashop-nicolas/fontshelf
```

`prepare` builds `dist/` on install (TypeScript to plain ES modules with `.js` import paths,
so Node, vitest and bundlers all load it).

## Privacy and consent

Nothing leaves the device unless **both** are true:

1. the host enabled remote fonts (`setRemoteEnabled(true)`, or a picker created with
   `remote: { provider: "google" }`), and
2. the user accepted the consent dialog (`hasConsent()`), which names the one provider,
   Google Fonts (`fonts.googleapis.com` for the CSS that draws fonts in the page,
   `fonts.gstatic.com` for the font files), says that Google sees each request including the
   IP address, and that the document is never sent.

There is one consent flag (stored in `localStorage` under `fontshelf.prefs`, with a session
fallback when storage is blocked). `remoteAllowed()` is the gate every network call checks.
Remote is **off by default**; a host can leave it off for good (an F-Droid build, a privacy
mode) and fontshelf then never makes a request: the catalog entry is hidden, `loadWebFont`
and `getFontFile` answer from local fonts and from the cache only.

"Show my fonts" never sends anything: it uses the Local Font Access API where the browser has
it (Chromium desktop, behind its own permission prompt) and otherwise probes 528 common font
names with canvas `measureText`.

## API

### Shared state (one per page)

The state lives on `globalThis`, so two bundled copies of fontshelf still agree.

```ts
setRemoteEnabled(on: boolean): void
isRemoteEnabled(): boolean
hasConsent(): boolean
setConsent(on: boolean): void
remoteAllowed(): boolean                         // enabled && consent

getFontState(): FontState
// { document: string[]; installed: string[]; installedFull: boolean; added: string[];
//   base: string[]; remoteEnabled: boolean; consent: boolean }
onFontsChange(listener: () => void): () => void  // returns unsubscribe
addDocumentFonts(names: readonly string[]): () => void  // returns unregister
isAdded(family: string): boolean                 // a web family loaded in this page
showInstalledFonts(opts?: { gesture?: boolean; candidates?: readonly string[] }): Promise<{ found: number; full: boolean }>
addRemoteFamily(family: string, fetcher?: Fetcher): Promise<boolean>   // CSS2 load, remembered
restoreFonts(opts?: { local?: boolean; remote?: boolean; docFonts?: readonly string[] }): void
```

`showInstalledFonts({ gesture: true })` is "show my fonts": call it from a click so the
permission prompt may appear; without `gesture` it only uses an already granted permission.

### Font files (bytes for engines)

```ts
getFontFile(family: string, opts?: GetFontFileOptions): Promise<FontFile | null>

interface GetFontFileOptions {
  weight?: number;     // default 400
  italic?: boolean;    // default false
  local?: boolean;     // try the installed font (default true)
  remote?: boolean;    // try the catalog download (default true, still needs remoteAllowed())
  gesture?: boolean;   // called from a click: queryLocalFonts may prompt
  fetchBytes?: (url: string) => Promise<Uint8Array | null>;  // tests or a host proxy
}

interface FontFile {
  bytes: Uint8Array;
  family: string;
  source: "local" | "remote";
  format: "ttf" | "otf" | "ttc" | "woff" | "woff2";
  embeddable: boolean | "restricted";   // false: bitmap-only or unreadable
  embedding: "installable" | "editable" | "preview-print" | "restricted";
  noSubsetting: boolean;                // embed the whole font, do not subset
  weight: number | null;                // the catalog weight for a remote file
  italic: boolean;
  variable: boolean;                    // only ever true for an installed variable font
  postscriptName: string | null;
  fullName: string | null;
  index: number;                        // face index inside a .ttc
  renamed: boolean;                     // remote only: name table rewritten to read as `family`
  url?: string;                         // remote only
  license?: "ofl" | "apache" | "ufl";   // remote only
}
```

- **Local** first: `queryLocalFonts()` blobs (Chromium desktop). It needs the `local-fonts`
  permission already `"granted"`, or `gesture: true`; it never prompts silently. The face
  closest to weight/italic is chosen by style name (a full or PostScript name also matches).
  A font found only by canvas probing has no bytes: `null`.
- **Remote** next: the catalog's static TTF for that weight and style, as Google Fonts serves
  it to non-browser clients (`https://fonts.gstatic.com/s/<family>/vNN/<hash>.ttf`, a whole
  font, not the unicode-range woff2 slices the CSS2 API gives browsers, which engines and
  libass cannot read). Right italic first, then the nearest weight (heavier on a tie). The
  files are static, so an engine that cannot apply variations gets the weight it asked for.
  Downloads go to Cache Storage (`fontshelf-files-v2`, memory fallback), so a file fetched
  once is reused offline, even with remote later switched off. The `fontshelf-files-v1`
  cache of earlier versions is deleted on first use.
- **Embedding**: `embeddable === "restricted"` means the OS/2 fsType forbids embedding; PDF and
  subtitle writers should refuse it. `"preview-print"` allows embedding in a read-only
  document; `"editable"` and `"installable"` allow editing too.
- **Installed variable fonts** (Skia, SF Pro) come back as they are, `variable: true`.
- **Names**: a file of a family Google Fonts builds from a variable source names the family in
  name ID 16 and the weight in ID 1 (`Noto Sans JP` / `Noto Sans JP Medium`); a family built
  from static masters may only have ID 1 (`Klee One SemiBold`, `Lato Black`). Engines that look
  a face up by family (libass reads ID 1 or the full name, DeckCraft reads ID 16 then ID 1) would
  miss those, so a remote file whose ID 1 or ID 16 is not the catalog family comes back renamed
  (`renamed: true`): ID 1 and 16 = the family, ID 2 = Regular / Bold / Italic / Bold Italic
  (Bold from weight 600 up), ID 17 = the real style (`SemiBold`, `Black Italic`), full and
  PostScript names kept, OS/2 usWeightClass kept, fsSelection and head.macStyle set to match,
  checksums recomputed. Cache Storage keeps the file as served; renaming is cheap and done once
  per file per session. Installed fonts are never renamed.

Lower level:

```ts
catalogFiles(family): CatalogFamilyFiles | undefined
// { family, license, files: CatalogFile[] }
// CatalogFile = { url, weight, italic, bytes }  (bytes = file size, for warnings)
pickCatalogFile(files, weight?, italic?): CatalogFile | undefined
fetchFontBytes(url, fetchBytes?): Promise<Uint8Array | null>   // cached, gated
isFontFileCached(url): Promise<boolean>                          // never hits the network
parseFontInfo(bytes, index?): FontInfo | null   // format, numFonts, fsType, embedding, noSubsetting,
                                                // bitmapOnly, weight, italic, variable, names
renameFace(bytes, family): Uint8Array    // the same bytes when already named, a TTC or junk
isNamedAs(bytes, family): boolean        // ID 1 (and ID 16 if present) say `family`
faceNames(bytes): { [nameId]: string }   // English name strings of a single font
embeddingOf(fsType: number | null): Embedding
embeddableOf(info): boolean | "restricted"
styleOf(style: string): { weight: number; italic: boolean }
pickLocalFace(fonts, family, weight?, italic?)
GSTATIC_FONTS   // "https://fonts.gstatic.com/s/"
```

### Drawing fonts in the page (Google CSS2)

```ts
loadWebFont(family: string, fetcher?: Fetcher): Promise<boolean>   // gated; injects @font-face
loadWebFontPreviews(fonts: readonly WebFont[], fetcher?, batch?): Promise<void>  // name-only subsets
googleCssUrl(families, text?): string
axisFallbacks(v): WebFont["v"][]
previewFamily(family): string
```

### Detection and lists

```ts
canDraw(name, measure?): boolean        // page @font-face or installed; unknown = true
fontPresent(name, measure, cache?): boolean
detectFonts(names, measure, cache?): string[]
detectFontsAsync(names, measure, cache?, budgetMs?): Promise<string[]>
detectInstalled(candidates, measure?): Promise<string[]>   // session-cached
canvasMeasure(): Measure | null
faceFamilies(): Set<string>
hasLocalFontAccess(): boolean
localFontsPermission(): Promise<PermissionState | null>   // never prompts
queryLocalFonts(): Promise<LocalFontData[] | null>
queryLocalFamilies(): Promise<string[] | null>
mergeNames(...lists): string[]
buildFontGroups({ docFonts, base, extra, canDraw }): { doc: { name, missing }[]; fonts: string[] }
cssFamily(name): string
BASE_FONTS, LOCAL_CANDIDATES, WEB_FONTS, GROUP_SAMPLE, findWebFont(family)
readFontPrefs(), writeFontPrefs(patch)   // { local?, consent?, added? }
```

### Picker for a native `<select>`

```ts
const picker = createFontSelect({
  docFonts: ["Calibri", "Arial"],          // "In this document"
  local: true,                             // "Show my fonts…" (default true)
  remote: { provider: "google" },          // "Get more fonts…" (default off)
  container: editorWrap,                   // hosts the dialogs and the toast
  apply: (family) => setFont(family),
  onAction: saveSelection,                 // before a dialog opens
  onPicked: restoreSelection,              // before a downloaded family is applied
  focusTarget: () => editingSurface,       // keeps the caret where it was
  notify: (text) => showTip(text),         // optional; default a toast
});
toolbar.append(picker.select);
picker.set(currentFamily);   // caret sync; also what an action entry restores
picker.fonts(); picker.has(name); picker.setDocFonts(names); picker.refresh(); picker.teardown();
```

Groups: "In this document" (missing ones marked "(not installed)"), "Fonts" (drawable base
fonts, installed fonts, added web fonts) and "More fonts" with the two action entries. An
action entry runs and the previous choice comes back; arrowing through a closed select never
triggers one. Every picker on the page re-renders when another one finds or adds fonts.

### Dialogs

```ts
requestRemoteFont(opts?: DialogOptions): Promise<string | null>  // consent if needed, then catalog
openConsentDialog(opts?): Promise<boolean>
openCatalogDialog(opts?): Promise<string | null>
showFontToast(container, text, ms?): void
injectFontshelfStyles(doc?): void
// DialogOptions = { container?: HTMLElement; className?: string }
```

Modal, with `role="dialog"`, focus trap, Escape and backdrop close, focus returned to the
opener. Theme with CSS variables on the container or any ancestor:

| Variable | Default |
|---|---|
| `--fontshelf-bg` | `#2b2f36` |
| `--fontshelf-fg` | `#e6e8ec` |
| `--fontshelf-border` | `#4a4f57` |
| `--fontshelf-accent` / `--fontshelf-accent-fg` | `#6e7bff` / `#fff` |
| `--fontshelf-hover` / `--fontshelf-hover-strong` | `#1f2329` / `#3a3f47` |
| `--fontshelf-input-bg` | `#1f2329` |
| `--fontshelf-backdrop` | `rgba(0,0,0,.45)` |
| `--fontshelf-toast-bg` / `--fontshelf-toast-fg` | `#fff` / `#222` |
| `--fontshelf-font` | `13px/1.3 system-ui, sans-serif` (Korean adds Apple SD Gothic Neo, Malgun Gothic, Noto Sans KR) |
| `--fontshelf-z` | `1000` |

### Strings

English, French, German, Spanish, Portuguese, Russian, Japanese, Simplified Chinese,
Italian, Polish, Korean and Turkish are built in. English is the default. Once `setFontLocale` has been
called, the dialogs, toast and picker carry that `lang`, so CJK glyphs and Turkish casing
follow it; Korean also gets installed Hangul fonts ahead of the fallback, nothing downloaded.

```ts
setFontLocale("fr");             // or "pt-BR" -> pt; unknown -> en
getFontLocale(); fontLocales();
setFontStrings({ fontsFound: "{n} extra fonts" });              // partial override
setFontStrings((key, params) => myT(`fonts.${key}`, params));   // or a resolver; undefined falls through
fontT(key, params?)
```

## The catalog

`src/catalog.ts` holds the curated families (14 groups: Office-compatible metric clones,
sans, serif, mono, display, handwriting, Japanese, Chinese, Korean, Arabic, Hebrew,
Cyrillic, Devanagari, Thai). `src/catalog-files.ts` is generated: the family's weights and
license from `fonts.google.com/metadata/fonts/<family>`, then one CSS2 request per family
with a non-browser User-Agent, which answers with a static TTF URL per weight and style
(weights up to 900, the CSS2 limit), each sized with a HEAD request. A browser cannot set its
User-Agent, so the URLs are resolved here and baked in; the `vNN` in a path is Google's
version of the family, so regenerate to move to newer files (old versions stay served).

```sh
npm run gen:catalog   # node scripts/gen-catalog.mjs (Node 23.6+)
```

Current output (2026-11-19): 165 families (158 OFL, 5 Apache, 2 UFL), 1228 static files,
1148.6 MB in all. A CJK file is 5.7 MB (Noto Sans JP) to 14.8 MB (Noto Serif SC) per weight,
so a UI should show `bytes` before a download.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT. The fonts themselves are under their own licenses (SIL OFL, Apache 2.0 or the Ubuntu
Font License, given per family as `license`).
