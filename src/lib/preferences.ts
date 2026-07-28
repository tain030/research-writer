import type { FocusMode } from "./types";

export interface Preferences {
  fontFamily: string;
  measure: number;
  focusMode: FocusMode;
  typewriterMode: boolean;
  soundEnabled: boolean;
  autoComplete: boolean;
  theme: "system" | "light" | "dark";
}

export const defaultPreferences: Preferences = {
  fontFamily: "Pretendard",
  measure: 68,
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
    return {
      ...defaultPreferences,
      ...(parsed as Partial<Preferences>),
    };
  } catch {
    return { ...defaultPreferences };
  }
}
