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

export { parseFontInfo, embeddingOf, embeddableOf } from "./sfnt.js";
export type { FontInfo, FontFormat, Embedding } from "./sfnt.js";

export {
  GOOGLE_FONTS_RAW, catalogFiles, pickCatalogFile, styleOf, pickLocalFace, fetchFontBytes, isFontFileCached, getFontFile,
} from "./files.js";
export type { CatalogFile, CatalogFamilyFiles, FontFile, GetFontFileOptions } from "./files.js";

export { setFontLocale, getFontLocale, setFontStrings, fontT, fontLocales } from "./strings.js";
export type { FontStringKey, FontStrings, FontStringResolver } from "./strings.js";

export { injectFontshelfStyles, openConsentDialog, openCatalogDialog, requestRemoteFont, showFontToast } from "./ui/dialogs.js";
export type { DialogOptions } from "./ui/dialogs.js";

export { createFontSelect, SHOW_MINE_VALUE, GET_MORE_VALUE } from "./ui/select.js";
export type { RemoteOption, FontSelectOptions, FontSelect } from "./ui/select.js";
