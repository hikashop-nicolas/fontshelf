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
2. the user accepted the consent dialog (`hasConsent()`), which names both providers:
   Google Fonts (`fonts.googleapis.com`, CSS for drawing fonts in the page) and Google's font
   collection on GitHub (`raw.githubusercontent.com/google/fonts`, the font files), says that
   they see each request including the IP address, and that the document is never sent.

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
  instance?: boolean;  // variable file: return a static instance at weight/italic (default false)
}

interface FontFile {
  bytes: Uint8Array;
  family: string;
  source: "local" | "remote";
  format: "ttf" | "otf" | "ttc" | "woff" | "woff2";
  embeddable: boolean | "restricted";   // false: bitmap-only or unreadable
  embedding: "installable" | "editable" | "preview-print" | "restricted";
  noSubsetting: boolean;                // embed the whole font, do not subset
  weight: number | [number, number] | null;   // a range for a remote variable file
  italic: boolean;
  variable: boolean;
  postscriptName: string | null;
  fullName: string | null;
  index: number;                        // face index inside a .ttc
  url?: string;                         // remote only
  license?: "ofl" | "apache" | "ufl";   // remote only
  instancedFrom?: string;               // instance: true only; source URL, or "local:<PostScript name>"
}
```

- **Local** first: `queryLocalFonts()` blobs (Chromium desktop). It needs the `local-fonts`
  permission already `"granted"`, or `gesture: true`; it never prompts silently. The face
  closest to weight/italic is chosen by style name (a full or PostScript name also matches).
  A font found only by canvas probing has no bytes: `null`.
- **Remote** next: the catalog's plain TTF/OTF from
  `https://raw.githubusercontent.com/google/fonts/main/<license>/<dir>/<file>` (not the CSS2
  woff2, which engines and libass cannot read), right italic first, then nearest weight.
  Downloads go to Cache Storage (`fontshelf-files-v1`, memory fallback), so a file fetched
  once is reused offline, even with remote later switched off.
- **Embedding**: `embeddable === "restricted"` means the OS/2 fsType forbids embedding; PDF and
  subtitle writers should refuse it. `"preview-print"` allows embedding in a read-only
  document; `"editable"` and `"installable"` allow editing too.
- **Variable fonts**: many catalog families ship one variable file (`NotoSansJP[wght].ttf`).
  Its default instance can be far from 400 (Noto Sans JP defaults to Thin), so an engine
  that cannot apply variations (libass, a PDF writer, a wasm slide engine) should pass
  `instance: true`. See [Static instances](#static-instances-of-variable-fonts).

### Static instances of variable fonts

`getFontFile(family, { weight, italic, instance: true })` turns a variable file (catalog or
installed, such as Skia or SF Pro) into a static font, using HarfBuzz's instancer:

- `wght` is pinned at the requested weight, clamped to the axis range; `ital` at 1 when
  italic is asked and the font has that axis, else 0; `slnt` at its full lean for italic only
  without an `ital` axis, else 0. Every other axis (`wdth`, `opsz`, ...) stays at its default.
  All glyphs and OpenType layout are kept.
- The result has `variable: false`, `weight` the pinned number, `instancedFrom` the source,
  `index: 0`. Its names are rewritten so engines find it by the catalog family: name ID 1 and
  16 are the family, ID 2 the RIBBI style, ID 17 the full style, full name and PostScript name
  per instance (`Noto Sans JP Bold`, `NotoSansJP-Bold`), and the OS/2 fsSelection and head
  macStyle bold/italic bits match. HarfBuzz itself sets OS/2 usWeightClass and drops
  fvar/gvar/avar/HVAR.
- Instances are cached by source and axis location: in memory, and catalog instances also in
  Cache Storage (`fontshelf-files-v1`, under a synthetic `https://fontshelf.invalid/...` key)
  so they survive a reload. Installed fonts are only kept in memory.
- A static file comes back unchanged. If HarfBuzz cannot load or fails, the variable file
  comes back as without `instance` (`variable: true`), so check `variable` when it matters.

Noto Sans JP (9.6 MB) instances to 5.8 MB in about 150 ms in Node on an Intel i9 laptop; a
small Latin family takes under 10 ms. The wasm compiles in about 40 ms on first use.

#### The HarfBuzz wasm asset

`dist/harfbuzz-subset.wasm` (683 KB, 275 KB gzipped; harfbuzzjs 1.6.4, MIT, a HarfBuzz build
under the Old MIT license, see `dist/harfbuzz-subset.LICENSE.txt`) is fetched only the first
time a variable file is instanced. The default URL is
`new URL("./harfbuzz-subset.wasm", import.meta.url)`, which Vite, webpack 5, Rollup and
Parcel builds pick up and emit as an asset on their own. Hosts that do not bundle copy the file
into their static directory and say where it is. The Vite dev server pre-bundles
dependencies and can lose the relative file there: add `fontshelf` to `optimizeDeps.exclude`,
or set the URL.

```ts
setHarfbuzzWasm("/assets/fontshelf/harfbuzz-subset.wasm");  // a URL (resolved by fetch)
setHarfbuzzWasm(bytes);   // or the bytes (Node, tests): Uint8Array | ArrayBuffer
setHarfbuzzWasm(null);    // back to the default URL
```

Lower level:

```ts
instanceFont(bytes, { weight?, italic?, index?, family? }): Promise<FontInstance | null>
// { bytes, location: { wght: 700 }, weight, italic }; null for a static font or a HarfBuzz failure
instanceLocation(axes, weight?, italic?): Record<string, number>   // the pure axis choice above
instanceStyleName(weight, italic): string                          // "SemiBold Italic", "Weight450"
parseAxes(bytes, index?): FontAxis[]                               // fvar axes: { tag, min, default, max }
catalogFiles(family): CatalogFamilyFiles | undefined
// { family, license, dir: "ofl/notosansjp", files: CatalogFile[] }
// CatalogFile = { file, url, weight: [min, max], italic, variable, bytes }  (bytes = size, for warnings)
pickCatalogFile(files, weight?, italic?): CatalogFile | undefined
fetchFontBytes(url, fetchBytes?): Promise<Uint8Array | null>   // cached, gated
isFontFileCached(url): Promise<boolean>                          // never hits the network
parseFontInfo(bytes, index?): FontInfo | null   // format, numFonts, fsType, embedding, noSubsetting,
                                                // bitmapOnly, weight, italic, variable, names
embeddingOf(fsType: number | null): Embedding
embeddableOf(info): boolean | "restricted"
styleOf(style: string): { weight: number; italic: boolean }
pickLocalFace(fonts, family, weight?, italic?)
GOOGLE_FONTS_RAW
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
| `--fontshelf-font` | `13px/1.3 system-ui, sans-serif` |
| `--fontshelf-z` | `1000` |

### Strings

English, French, German, Spanish, Portuguese, Russian, Japanese and Simplified Chinese are
built in. English is the default.

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
Cyrillic, Devanagari, Thai). `src/catalog-files.ts` is generated from the google/fonts
`METADATA.pb` files, every URL checked with a HEAD request:

```sh
npm run gen:catalog   # node scripts/gen-catalog.mjs (Node 23.6+)
```

Current output: 165 families (158 OFL, 5 Apache, 2 UFL), 507 files of which 117 variable, 598.9 MB in all. CJK files run from 4 to 25 MB (Noto Serif SC is the largest), so a UI should show `bytes` before a download.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT. `dist/harfbuzz-subset.wasm` is HarfBuzz (Old MIT) built by harfbuzzjs (MIT). The fonts
themselves are under their own licenses (SIL OFL, Apache 2.0 or the Ubuntu Font License,
given per file as `license`). The test fixture `test/fixtures/Figtree[wght].ttf` is Figtree
(SIL OFL 1.1, `test/fixtures/Figtree-OFL.txt`).
