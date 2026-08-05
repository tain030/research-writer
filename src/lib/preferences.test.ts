import { describe, expect, it } from "vitest";
import {
  PREFERENCES_SCHEMA_VERSION,
  defaultFontFamilyByExperience,
  defaultPreferences,
  parsePreferences,
} from "./preferences";

describe("writing preferences", () => {
  it("uses Goorm Sans Code as the fresh typewriter default", () => {
    const fresh = parsePreferences(null);

    expect(defaultPreferences.schemaVersion).toBe(PREFERENCES_SCHEMA_VERSION);
    expect(defaultPreferences.fontFamilyByExperience).toEqual({
      typewriter: "Goorm Sans Code",
      literary: "MaruBuri",
      flow: "Pretendard",
    });
    expect(fresh.fontFamilyByExperience.typewriter).toBe("Goorm Sans Code");
    expect(fresh.writingExperience).toBe("typewriter");
    expect(fresh.flowAutoHideChrome).toBe(true);
    expect(fresh.pageFitMode).toBe("width");
    expect(fresh.companionSplitRatio).toBe(0.56);
  });

  it("migrates the earliest bundled defaults exactly once", () => {
    expect(parsePreferences('{"fontFamily":"Pretendard"}')).toMatchObject({
      schemaVersion: PREFERENCES_SCHEMA_VERSION,
      fontFamilyByExperience: defaultFontFamilyByExperience,
      writingExperience: "typewriter",
    });
    expect(
      parsePreferences(
        JSON.stringify({
          schemaVersion: 1,
          fontFamily: "MaruBuri",
        }),
      ),
    ).toMatchObject({
      fontFamilyByExperience: defaultFontFamilyByExperience,
      writingExperience: "typewriter",
    });
    expect(
      parsePreferences(
        JSON.stringify({
          schemaVersion: 2,
          fontFamily: "MaruBuri",
        }),
      ),
    ).toMatchObject({
      fontFamilyByExperience: {
        ...defaultFontFamilyByExperience,
        literary: "MaruBuri",
      },
      writingExperience: "literary",
    });
  });

  it("resets only the typewriter memory when migrating schema 5", () => {
    expect(
      parsePreferences(
        JSON.stringify({
          schemaVersion: 5,
          fontFamily: "NanumGothicCoding",
          writingExperience: "typewriter",
        }),
      ),
    ).toMatchObject({
      schemaVersion: PREFERENCES_SCHEMA_VERSION,
      fontFamilyByExperience: defaultFontFamilyByExperience,
      writingExperience: "typewriter",
    });
    expect(
      parsePreferences(
        JSON.stringify({
          schemaVersion: 5,
          fontFamily: "Repository Serif",
          writingExperience: "literary",
        }),
      ),
    ).toMatchObject({
      fontFamilyByExperience: {
        typewriter: "Goorm Sans Code",
        literary: "Repository Serif",
        flow: "Pretendard",
      },
      writingExperience: "literary",
    });
    expect(
      parsePreferences(
        JSON.stringify({
          schemaVersion: 5,
          fontFamily: "Repository Sans",
          writingExperience: "flow",
        }),
      ),
    ).toMatchObject({
      fontFamilyByExperience: {
        typewriter: "Goorm Sans Code",
        literary: "MaruBuri",
        flow: "Repository Sans",
      },
      writingExperience: "flow",
    });
  });

  it("preserves every per-experience choice after schema 6", () => {
    const stored = JSON.stringify({
      schemaVersion: PREFERENCES_SCHEMA_VERSION,
      writingExperience: "flow",
      fontFamilyByExperience: {
        typewriter: "NanumGothicCoding",
        literary: "Repository Serif",
        flow: "Repository Sans",
      },
    });

    expect(parsePreferences(stored)).toMatchObject({
      fontFamilyByExperience: {
        typewriter: "NanumGothicCoding",
        literary: "Repository Serif",
        flow: "Repository Sans",
      },
      writingExperience: "flow",
    });
  });

  it("repairs malformed schema 6 font memories independently", () => {
    expect(
      parsePreferences(
        JSON.stringify({
          schemaVersion: PREFERENCES_SCHEMA_VERSION,
          writingExperience: "literary",
          fontFamilyByExperience: {
            typewriter: "NanumGothicCoding",
            literary: "   ",
            flow: 42,
          },
        }),
      ).fontFamilyByExperience,
    ).toEqual({
      typewriter: "NanumGothicCoding",
      literary: "MaruBuri",
      flow: "Pretendard",
    });
  });

  it("migrates and clamps the companion split ratio", () => {
    expect(parsePreferences("{}").companionSplitRatio).toBe(0.56);
    expect(
      parsePreferences('{"companionSplitRatio":0.62}').companionSplitRatio,
    ).toBe(0.62);
    expect(
      parsePreferences('{"companionSplitRatio":0.9}').companionSplitRatio,
    ).toBe(0.7);
    expect(
      parsePreferences('{"companionSplitRatio":0.1}').companionSplitRatio,
    ).toBe(0.35);
  });

  it("preserves explicit and repository font choices outside typewriter", () => {
    const stored = JSON.stringify({
      schemaVersion: 1,
      fontFamily: "Pretendard",
      measure: 72,
    });

    expect(parsePreferences(stored)).toMatchObject({
      fontFamilyByExperience: {
        typewriter: "Goorm Sans Code",
        literary: "MaruBuri",
        flow: "Pretendard",
      },
      pageFitMode: "width",
      writingExperience: "flow",
      flowAutoHideChrome: true,
    });
    expect(
      parsePreferences(
        JSON.stringify({ schemaVersion: 1, fontFamily: "Custom Mono" }),
      ),
    ).toMatchObject({
      fontFamilyByExperience: {
        typewriter: "Goorm Sans Code",
        literary: "Custom Mono",
        flow: "Pretendard",
      },
      writingExperience: "literary",
    });
    expect("measure" in parsePreferences(stored)).toBe(false);
  });

  it("falls back safely without sharing mutable font maps", () => {
    expect(parsePreferences("{not-json")).toEqual(defaultPreferences);
    expect(parsePreferences("[]")).toEqual(defaultPreferences);

    const first = parsePreferences(null);
    const second = parsePreferences(null);
    first.fontFamilyByExperience.typewriter = "Changed";
    expect(second.fontFamilyByExperience.typewriter).toBe("Goorm Sans Code");
    expect(defaultPreferences.fontFamilyByExperience.typewriter).toBe(
      "Goorm Sans Code",
    );
  });

  it("migrates manual zoom profiles to page fitting", () => {
    const migrated = parsePreferences('{"manuscriptZoom":130}');
    expect(migrated.pageFitMode).toBe("width");
    expect("manuscriptZoom" in migrated).toBe(false);
  });

  it("migrates a valid legacy manuscript fitting mode", () => {
    expect(
      parsePreferences('{"manuscriptFitMode":"page"}').pageFitMode,
    ).toBe("page");
    expect(
      parsePreferences('{"pageFitMode":"width"}').pageFitMode,
    ).toBe("width");
    expect(
      parsePreferences('{"manuscriptFitMode":"invalid"}').pageFitMode,
    ).toBe("width");
  });

  it("migrates the former global chrome option to flow-owned behavior", () => {
    expect(parsePreferences("{}")).toMatchObject({
      flowAutoHideChrome: true,
      focusSheetMode: false,
    });
    expect(
      parsePreferences(
        JSON.stringify({
          schemaVersion: 3,
          immersiveChrome: true,
          focusSheetMode: true,
        }),
      ),
    ).toMatchObject({
      flowAutoHideChrome: true,
      focusSheetMode: true,
    });
    expect(
      parsePreferences(
        JSON.stringify({
          schemaVersion: PREFERENCES_SCHEMA_VERSION,
          flowAutoHideChrome: false,
        }),
      ).flowAutoHideChrome,
    ).toBe(false);
  });

  it("drops former caret, immersive, and synthetic sound settings", () => {
    const migrated = parsePreferences(
      JSON.stringify({
        schemaVersion: 2,
        fontFamily: "NanumGothicCoding",
        typewriterMode: false,
        soundEnabled: true,
      }),
    );
    expect(migrated).toMatchObject({
      fontFamilyByExperience: defaultFontFamilyByExperience,
      writingExperience: "typewriter",
      flowAutoHideChrome: true,
    });
    expect("typewriterMode" in migrated).toBe(false);
    expect("caretTracking" in migrated).toBe(false);
    expect("immersiveChrome" in migrated).toBe(false);
    expect("soundEnabled" in migrated).toBe(false);
  });
});
