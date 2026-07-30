import type { FocusMode } from "./types";

export interface Preferences {
  fontFamily: string;
  focusMode: FocusMode;
  typewriterMode: boolean;
  soundEnabled: boolean;
  autoComplete: boolean;
  theme: "system" | "light" | "dark";
}

export const defaultPreferences: Preferences = {
  fontFamily: "Pretendard",
  focusMode: "off",
  typewriterMode: true,
  soundEnabled: false,
  autoComplete: false,
  theme: "system",
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
    };
  } catch {
    return { ...defaultPreferences };
  }
}
