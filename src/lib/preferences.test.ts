import { describe, expect, it } from "vitest";
import { defaultPreferences, parsePreferences } from "./preferences";

describe("writing preferences", () => {
  it("uses Pretendard for a fresh profile", () => {
    expect(defaultPreferences.fontFamily).toBe("Pretendard");
    expect(defaultPreferences.manuscriptFitMode).toBe("page");
    expect(defaultPreferences.manuscriptGuidance).toBe(true);
    expect(parsePreferences(null).fontFamily).toBe("Pretendard");
  });

  it("preserves an existing explicit font choice", () => {
    const stored = JSON.stringify({
      fontFamily: "MaruBuri",
      measure: 72,
    });

    expect(parsePreferences(stored)).toMatchObject({
      fontFamily: "MaruBuri",
      manuscriptFitMode: "page",
      typewriterMode: true,
      manuscriptGuidance: true,
    });
    expect("measure" in parsePreferences(stored)).toBe(false);
  });

  it("falls back safely when stored preferences are invalid", () => {
    expect(parsePreferences("{not-json")).toEqual(defaultPreferences);
    expect(parsePreferences("[]")).toEqual(defaultPreferences);
  });

  it("migrates manual zoom profiles to page fitting", () => {
    const migrated = parsePreferences('{"manuscriptZoom":130}');
    expect(migrated.manuscriptFitMode).toBe("page");
    expect("manuscriptZoom" in migrated).toBe(false);
  });

  it("preserves a valid manuscript fitting mode", () => {
    expect(
      parsePreferences('{"manuscriptFitMode":"width"}').manuscriptFitMode,
    ).toBe("width");
    expect(
      parsePreferences('{"manuscriptFitMode":"invalid"}').manuscriptFitMode,
    ).toBe("page");
  });

  it("preserves an explicit writing-guidance preference", () => {
    expect(
      parsePreferences('{"manuscriptGuidance":false}').manuscriptGuidance,
    ).toBe(false);
  });

  it("migrates immersive writing options without changing old profiles", () => {
    expect(parsePreferences("{}")).toMatchObject({
      immersiveChrome: false,
      typewriterImperfection: false,
      focusSheetMode: false,
    });
    expect(
      parsePreferences(
        JSON.stringify({
          immersiveChrome: true,
          typewriterImperfection: true,
          focusSheetMode: true,
        }),
      ),
    ).toMatchObject({
      immersiveChrome: true,
      typewriterImperfection: true,
      focusSheetMode: true,
    });
  });
});
