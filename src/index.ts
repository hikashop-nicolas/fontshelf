// fontshelf: one font service for browser editors.
export { BASE_FONTS, LOCAL_CANDIDATES, WEB_FONTS, GROUP_SAMPLE, findWebFont } from "./catalog";
export type { WebFont, WebFontGroup } from "./catalog";

export {
  PROBE_TEXT, cssFamily, fontPresent, detectFonts, detectFontsAsync, canvasMeasure, faceFamilies, canDraw,
  detectInstalled, hasLocalFontAccess, localFontsPermission, queryLocalFonts, queryLocalFamilies, mergeNames,
  buildFontGroups,
} from "./detect";
export type { Measure, DetectCache, LocalFontData, FontGroups } from "./detect";

export { PREFS_KEY, readFontPrefs, writeFontPrefs } from "./prefs";
export type { FontPrefs } from "./prefs";

export { setRemoteEnabled, isRemoteEnabled, hasConsent, setConsent, remoteAllowed } from "./shared";

export { googleCssUrl, axisFallbacks, loadWebFont, loadWebFontPreviews, previewFamily } from "./google";
export type { Fetcher } from "./google";

export { getFontState, onFontsChange, addDocumentFonts, isAdded, showInstalledFonts, addRemoteFamily, restoreFonts } from "./registry";
export type { FontState } from "./registry";

export { parseFontInfo, embeddingOf, embeddableOf } from "./sfnt";
export type { FontInfo, FontFormat, Embedding } from "./sfnt";

export {
  GOOGLE_FONTS_RAW, catalogFiles, pickCatalogFile, styleOf, pickLocalFace, fetchFontBytes, isFontFileCached, getFontFile,
} from "./files";
export type { CatalogFile, CatalogFamilyFiles, FontFile, GetFontFileOptions } from "./files";

export { setFontLocale, getFontLocale, setFontStrings, fontT, fontLocales } from "./strings";
export type { FontStringKey, FontStrings, FontStringResolver } from "./strings";

export { injectFontshelfStyles, openConsentDialog, openCatalogDialog, requestRemoteFont, showFontToast } from "./ui/dialogs";
export type { DialogOptions } from "./ui/dialogs";

export { createFontSelect, SHOW_MINE_VALUE, GET_MORE_VALUE } from "./ui/select";
export type { RemoteOption, FontSelectOptions, FontSelect } from "./ui/select";
