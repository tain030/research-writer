import type { FocusMode, ManuscriptFitMode } from "./types";

export interface Preferences {
  fontFamily: string;
  manuscriptFitMode: ManuscriptFitMode;
  focusMode: FocusMode;
  typewriterMode: boolean;
  soundEnabled: boolean;
  autoComplete: boolean;
  manuscriptGuidance: boolean;
  theme: "system" | "light" | "dark";
  immersiveChrome: boolean;
  typewriterImperfection: boolean;
  focusSheetMode: boolean;
}

export const defaultPreferences: Preferences = {
  fontFamily: "Pretendard",
  manuscriptFitMode: "page",
  focusMode: "off",
  typewriterMode: true,
  soundEnabled: false,
  autoComplete: false,
  manuscriptGuidance: true,
  theme: "system",
  immersiveChrome: false,
  typewriterImperfection: false,
  focusSheetMode: false,
};

export function parsePreferences(stored: string | null): Preferences {
  if (!stored) return { ...defaultPreferences };
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...defaultPreferences };
    }
    const candidate = parsed as Partial<Preferences>;
    return {
      fontFamily:
        typeof candidate.fontFamily === "string" && candidate.fontFamily.trim()
          ? candidate.fontFamily
          : defaultPreferences.fontFamily,
      manuscriptFitMode: ["page", "width"].includes(
        candidate.manuscriptFitMode ?? "",
      )
        ? (candidate.manuscriptFitMode as ManuscriptFitMode)
        : defaultPreferences.manuscriptFitMode,
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
      manuscriptGuidance:
        typeof candidate.manuscriptGuidance === "boolean"
          ? candidate.manuscriptGuidance
          : defaultPreferences.manuscriptGuidance,
      theme: ["system", "light", "dark"].includes(candidate.theme ?? "")
        ? (candidate.theme as Preferences["theme"])
        : defaultPreferences.theme,
      immersiveChrome:
        typeof candidate.immersiveChrome === "boolean"
          ? candidate.immersiveChrome
          : defaultPreferences.immersiveChrome,
      typewriterImperfection:
        typeof candidate.typewriterImperfection === "boolean"
          ? candidate.typewriterImperfection
          : defaultPreferences.typewriterImperfection,
      focusSheetMode:
        typeof candidate.focusSheetMode === "boolean"
          ? candidate.focusSheetMode
          : defaultPreferences.focusSheetMode,
    };
  } catch {
    return { ...defaultPreferences };
  }
}
