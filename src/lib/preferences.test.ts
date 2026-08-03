import { describe, expect, it } from "vitest";
import {
  PREFERENCES_SCHEMA_VERSION,
  defaultPreferences,
  parsePreferences,
} from "./preferences";

describe("writing preferences", () => {
  it("uses MaruBuri for a fresh profile", () => {
    expect(defaultPreferences.schemaVersion).toBe(PREFERENCES_SCHEMA_VERSION);
    expect(defaultPreferences.fontFamily).toBe("MaruBuri");
    expect(defaultPreferences.pageFitMode).toBe("width");
    expect(defaultPreferences.companionSplitRatio).toBe(0.56);
    expect(parsePreferences(null).fontFamily).toBe("MaruBuri");
  });

  it("migrates the legacy Pretendard default exactly once", () => {
    expect(parsePreferences('{"fontFamily":"Pretendard"}')).toMatchObject({
      schemaVersion: PREFERENCES_SCHEMA_VERSION,
      fontFamily: "MaruBuri",
    });
    expect(
      parsePreferences(
        JSON.stringify({
          schemaVersion: PREFERENCES_SCHEMA_VERSION,
          fontFamily: "Pretendard",
        }),
      ),
    ).toMatchObject({
      schemaVersion: PREFERENCES_SCHEMA_VERSION,
      fontFamily: "Pretendard",
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

  it("preserves an existing explicit font choice", () => {
    const stored = JSON.stringify({
      fontFamily: "MaruBuri",
      measure: 72,
    });

    expect(parsePreferences(stored)).toMatchObject({
      fontFamily: "MaruBuri",
      pageFitMode: "width",
      typewriterMode: true,
    });
    expect("measure" in parsePreferences(stored)).toBe(false);
  });

  it("falls back safely when stored preferences are invalid", () => {
    expect(parsePreferences("{not-json")).toEqual(defaultPreferences);
    expect(parsePreferences("[]")).toEqual(defaultPreferences);
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

  it("migrates immersive writing options without changing old profiles", () => {
    expect(parsePreferences("{}")).toMatchObject({
      immersiveChrome: false,
      focusSheetMode: false,
    });
    expect(
      parsePreferences(
        JSON.stringify({
          immersiveChrome: true,
          focusSheetMode: true,
        }),
      ),
    ).toMatchObject({
      immersiveChrome: true,
      focusSheetMode: true,
    });
  });
});
