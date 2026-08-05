import type { FocusMode, WritingExperience } from "./types";

export type PageFitMode = "page" | "width";
export type FontFamilyByExperience = Record<WritingExperience, string>;

export const PREFERENCES_SCHEMA_VERSION = 6;

export const defaultFontFamilyByExperience: FontFamilyByExperience = {
  typewriter: "Goorm Sans Code",
  literary: "MaruBuri",
  flow: "Pretendard",
};

export interface Preferences {
  schemaVersion: number;
  fontFamilyByExperience: FontFamilyByExperience;
  writingExperience: WritingExperience;
  pageFitMode: PageFitMode;
  focusMode: FocusMode;
  autoComplete: boolean;
  theme: "system" | "light" | "dark";
  flowAutoHideChrome: boolean;
  focusSheetMode: boolean;
  companionSplitRatio: number;
}

export const defaultPreferences: Preferences = {
  schemaVersion: PREFERENCES_SCHEMA_VERSION,
  fontFamilyByExperience: { ...defaultFontFamilyByExperience },
  writingExperience: "typewriter",
  pageFitMode: "width",
  focusMode: "off",
  autoComplete: false,
  theme: "system",
  flowAutoHideChrome: true,
  focusSheetMode: false,
  companionSplitRatio: 0.56,
};

type StoredPreferences = Omit<
  Partial<Preferences>,
  "schemaVersion" | "fontFamilyByExperience" | "writingExperience"
> & {
  schemaVersion?: unknown;
  fontFamily?: unknown;
  fontFamilyByExperience?: unknown;
  manuscriptFitMode?: unknown;
  manuscriptGuidance?: unknown;
  typewriterImperfection?: unknown;
  manuscriptZoom?: unknown;
  writingExperience?: unknown;
  typewriterMode?: unknown;
  caretTracking?: unknown;
  immersiveChrome?: unknown;
  soundEnabled?: unknown;
};

const writingExperienceIds: WritingExperience[] = [
  "typewriter",
  "literary",
  "flow",
];

function isWritingExperience(value: unknown): value is WritingExperience {
  return (
    typeof value === "string" &&
    writingExperienceIds.includes(value as WritingExperience)
  );
}

function defaultPreferencesCopy(): Preferences {
  return {
    ...defaultPreferences,
    fontFamilyByExperience: { ...defaultFontFamilyByExperience },
  };
}

function validFontFamily(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function clampSplitRatio(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(0.7, Math.max(0.35, value))
    : defaultPreferences.companionSplitRatio;
}

function migrateLegacyFontFamily(
  fontFamily: string,
  storedSchemaVersion: number,
  storedWritingExperience: WritingExperience | null,
): string {
  // These were application defaults in early schemas, not explicit choices.
  // An explicit non-typewriter experience is always treated as a user choice.
  if (storedWritingExperience === "literary" || storedWritingExperience === "flow") {
    return fontFamily;
  }
  if (storedSchemaVersion < 2 && fontFamily === "MaruBuri") {
    return defaultFontFamilyByExperience.typewriter;
  }
  if (storedSchemaVersion < 1 && fontFamily === "Pretendard") {
    return defaultFontFamilyByExperience.typewriter;
  }
  return fontFamily;
}

function parseStoredFontFamilies(value: unknown): FontFamilyByExperience {
  const parsed = { ...defaultFontFamilyByExperience };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return parsed;
  }
  const candidate = value as Partial<Record<WritingExperience, unknown>>;
  for (const experience of writingExperienceIds) {
    const family = validFontFamily(candidate[experience]);
    if (family) parsed[experience] = family;
  }
  return parsed;
}

function migrateFontFamilies(
  candidate: StoredPreferences,
  storedSchemaVersion: number,
  storedWritingExperience: WritingExperience | null,
): {
  fontFamilyByExperience: FontFamilyByExperience;
  writingExperience: WritingExperience;
} {
  if (storedSchemaVersion >= PREFERENCES_SCHEMA_VERSION) {
    const fontFamilyByExperience = parseStoredFontFamilies(
      candidate.fontFamilyByExperience,
    );
    return {
      fontFamilyByExperience,
      writingExperience:
        storedWritingExperience ??
        writingExperienceForFont(fontFamilyByExperience.typewriter),
    };
  }

  const legacyFontFamily = migrateLegacyFontFamily(
    validFontFamily(candidate.fontFamily) ??
      defaultFontFamilyByExperience.typewriter,
    storedSchemaVersion,
    storedWritingExperience,
  );
  const writingExperience =
    storedWritingExperience ?? writingExperienceForFont(legacyFontFamily);
  const fontFamilyByExperience = { ...defaultFontFamilyByExperience };

  // Schema 6 intentionally gives every existing typewriter profile the new
  // Goorm default once. Non-typewriter choices remain attached to their mode.
  if (writingExperience !== "typewriter") {
    fontFamilyByExperience[writingExperience] = legacyFontFamily;
  }

  return { fontFamilyByExperience, writingExperience };
}

export function writingExperienceForFont(
  fontFamily: string,
  monospaced?: boolean,
): WritingExperience {
  if (
    monospaced === true ||
    fontFamily === "Goorm Sans Code" ||
    fontFamily === "NanumGothicCoding"
  ) {
    return "typewriter";
  }
  if (fontFamily === "Pretendard") return "flow";
  return "literary";
}

export function hasStoredWritingExperience(stored: string | null): boolean {
  if (!stored) return false;
  try {
    const parsed: unknown = JSON.parse(stored);
    return Boolean(
      parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        isWritingExperience(
          (parsed as { writingExperience?: unknown }).writingExperience,
        ),
    );
  } catch {
    return false;
  }
}

export function parsePreferences(stored: string | null): Preferences {
  if (!stored) return defaultPreferencesCopy();
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return defaultPreferencesCopy();
    }
    const candidate = parsed as StoredPreferences;
    const storedSchemaVersion =
      typeof candidate.schemaVersion === "number" &&
      Number.isInteger(candidate.schemaVersion) &&
      candidate.schemaVersion >= 0
        ? candidate.schemaVersion
        : 0;
    const storedWritingExperience = isWritingExperience(
      candidate.writingExperience,
    )
      ? candidate.writingExperience
      : null;
    const migratedFonts = migrateFontFamilies(
      candidate,
      storedSchemaVersion,
      storedWritingExperience,
    );
    const storedPageFitMode =
      candidate.pageFitMode ?? candidate.manuscriptFitMode;
    return {
      schemaVersion: Math.max(
        PREFERENCES_SCHEMA_VERSION,
        storedSchemaVersion,
      ),
      ...migratedFonts,
      pageFitMode:
        storedPageFitMode === "page" || storedPageFitMode === "width"
          ? storedPageFitMode
          : defaultPreferences.pageFitMode,
      focusMode: ["off", "paragraph", "sentence"].includes(
        candidate.focusMode ?? "",
      )
        ? (candidate.focusMode as FocusMode)
        : defaultPreferences.focusMode,
      autoComplete:
        typeof candidate.autoComplete === "boolean"
          ? candidate.autoComplete
          : defaultPreferences.autoComplete,
      theme: ["system", "light", "dark"].includes(candidate.theme ?? "")
        ? (candidate.theme as Preferences["theme"])
        : defaultPreferences.theme,
      flowAutoHideChrome:
        storedSchemaVersion >= 4 &&
        typeof candidate.flowAutoHideChrome === "boolean"
          ? candidate.flowAutoHideChrome
          : defaultPreferences.flowAutoHideChrome,
      focusSheetMode:
        typeof candidate.focusSheetMode === "boolean"
          ? candidate.focusSheetMode
          : defaultPreferences.focusSheetMode,
      companionSplitRatio: clampSplitRatio(candidate.companionSplitRatio),
    };
  } catch {
    return defaultPreferencesCopy();
  }
}
