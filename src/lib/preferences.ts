import type { FocusMode } from "./types";

export type PageFitMode = "page" | "width";

export const PREFERENCES_SCHEMA_VERSION = 2;

export interface Preferences {
  schemaVersion: number;
  fontFamily: string;
  pageFitMode: PageFitMode;
  focusMode: FocusMode;
  typewriterMode: boolean;
  soundEnabled: boolean;
  autoComplete: boolean;
  theme: "system" | "light" | "dark";
  immersiveChrome: boolean;
  focusSheetMode: boolean;
  companionSplitRatio: number;
}

export const defaultPreferences: Preferences = {
  schemaVersion: PREFERENCES_SCHEMA_VERSION,
  fontFamily: "NanumGothicCoding",
  pageFitMode: "width",
  focusMode: "off",
  typewriterMode: true,
  soundEnabled: false,
  autoComplete: false,
  theme: "system",
  immersiveChrome: false,
  focusSheetMode: false,
  companionSplitRatio: 0.56,
};

type StoredPreferences = Omit<Partial<Preferences>, "schemaVersion"> & {
  schemaVersion?: unknown;
  manuscriptFitMode?: unknown;
  manuscriptGuidance?: unknown;
  typewriterImperfection?: unknown;
  manuscriptZoom?: unknown;
};

function clampSplitRatio(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(0.7, Math.max(0.35, value))
    : defaultPreferences.companionSplitRatio;
}

function migrateFontFamily(
  fontFamily: string,
  storedSchemaVersion: number,
): string {
  if (storedSchemaVersion >= PREFERENCES_SCHEMA_VERSION) return fontFamily;
  if (fontFamily === "MaruBuri") return defaultPreferences.fontFamily;
  if (storedSchemaVersion < 1 && fontFamily === "Pretendard") {
    return defaultPreferences.fontFamily;
  }
  return fontFamily;
}

export function parsePreferences(stored: string | null): Preferences {
  if (!stored) return { ...defaultPreferences };
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...defaultPreferences };
    }
    const candidate = parsed as StoredPreferences;
    const storedSchemaVersion =
      typeof candidate.schemaVersion === "number" &&
      Number.isInteger(candidate.schemaVersion) &&
      candidate.schemaVersion >= 0
        ? candidate.schemaVersion
        : 0;
    const storedFontFamily =
      typeof candidate.fontFamily === "string" && candidate.fontFamily.trim()
        ? candidate.fontFamily
        : defaultPreferences.fontFamily;
    const storedPageFitMode =
      candidate.pageFitMode ?? candidate.manuscriptFitMode;
    return {
      schemaVersion: Math.max(
        PREFERENCES_SCHEMA_VERSION,
        storedSchemaVersion,
      ),
      fontFamily: migrateFontFamily(storedFontFamily, storedSchemaVersion),
      pageFitMode:
        storedPageFitMode === "page" || storedPageFitMode === "width"
        ? storedPageFitMode
        : defaultPreferences.pageFitMode,
      focusMode: ["off", "paragraph", "sentence"].includes(
        candidate.focusMode ?? "",
      )
        ? (candidate.focusMode as FocusMode)
        : defaultPreferences.focusMode,
      typewriterMode:
        typeof candidate.typewriterMode === "boolean"
          ? candidate.typewriterMode
          : defaultPreferences.typewriterMode,
      soundEnabled:
        typeof candidate.soundEnabled === "boolean"
          ? candidate.soundEnabled
          : defaultPreferences.soundEnabled,
      autoComplete:
        typeof candidate.autoComplete === "boolean"
          ? candidate.autoComplete
          : defaultPreferences.autoComplete,
      theme: ["system", "light", "dark"].includes(candidate.theme ?? "")
        ? (candidate.theme as Preferences["theme"])
        : defaultPreferences.theme,
      immersiveChrome:
        typeof candidate.immersiveChrome === "boolean"
          ? candidate.immersiveChrome
          : defaultPreferences.immersiveChrome,
      focusSheetMode:
        typeof candidate.focusSheetMode === "boolean"
          ? candidate.focusSheetMode
          : defaultPreferences.focusSheetMode,
      companionSplitRatio: clampSplitRatio(candidate.companionSplitRatio),
    };
  } catch {
    return { ...defaultPreferences };
  }
}
