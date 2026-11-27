// fontshelf: one font service for browser editors.
export { BASE_FONTS, LOCAL_CANDIDATES, WEB_FONTS, GROUP_SAMPLE, findWebFont } from "./catalog.js";
export type { WebFont, WebFontGroup } from "./catalog.js";

export {
  PROBE_TEXT, cssFamily, fontPresent, detectFonts, detectFontsAsync, canvasMeasure, faceFamilies, canDraw,
  detectInstalled, hasLocalFontAccess, localFontsPermission, queryLocalFonts, queryLocalFamilies, mergeNames,
  buildFontGroups,
} from "./detect.js";
export type { Measure, DetectCache, LocalFontData, FontGroups } from "./detect.js";

export { PREFS_KEY, readFontPrefs, writeFontPrefs } from "./prefs.js";
export type { FontPrefs } from "./prefs.js";

export { setRemoteEnabled, isRemoteEnabled, hasConsent, setConsent, remoteAllowed } from "./shared.js";

export { googleCssUrl, axisFallbacks, loadWebFont, loadWebFontPreviews, previewFamily } from "./google.js";
export type { Fetcher } from "./google.js";

export { getFontState, onFontsChange, addDocumentFonts, isAdded, showInstalledFonts, addRemoteFamily, restoreFonts } from "./registry.js";
export type { FontState } from "./registry.js";

export { parseFontInfo, embeddingOf, embeddableOf, scriptsOf } from "./sfnt.js";
export { woffToSfnt, woff2Tables, extractFace } from "./woff.js";

export {
  MAX_FONT_FILE_BYTES, MAX_STORED_FONT_BYTES, readFontFaces, loadFontFile, restoreLoadedFonts, getLoadedFonts, loadedFamilies,
  removeLoadedFont,
} from "./loaded.js";
export type { FontFileFace, LoadedFont, LoadFontError, LoadFontResult } from "./loaded.js";
export { renameFace, isNamedAs, faceNames } from "./rename.js";
export type { FontInfo, FontFormat, Embedding } from "./sfnt.js";

export {
  GSTATIC_FONTS, catalogFiles, pickCatalogFile, styleOf, pickLocalFace, fetchFontBytes, isFontFileCached, getFontFile,
} from "./files.js";
export type { CatalogFile, CatalogFamilyFiles, FontFile, GetFontFileOptions } from "./files.js";

export { setFontLocale, getFontLocale, setFontStrings, fontT, fontLocales } from "./strings.js";
export type { FontStringKey, FontStrings, FontStringResolver } from "./strings.js";

export {
  injectFontshelfStyles, openConsentDialog, openCatalogDialog, requestRemoteFont, showFontToast, FONT_FILE_ACCEPT, pickFontFile,
  openFaceDialog, requestFontFile,
} from "./ui/dialogs.js";
export type { DialogOptions } from "./ui/dialogs.js";

export { createFontSelect, SHOW_MINE_VALUE, GET_MORE_VALUE, LOAD_FILE_VALUE } from "./ui/select.js";
export type { RemoteOption, FontSelectOptions, FontSelect } from "./ui/select.js";
