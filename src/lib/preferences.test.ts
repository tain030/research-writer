import { describe, expect, it } from "vitest";
import { defaultPreferences, parsePreferences } from "./preferences";

describe("writing preferences", () => {
  it("uses Pretendard for a fresh profile", () => {
    expect(defaultPreferences.fontFamily).toBe("Pretendard");
    expect(defaultPreferences.manuscriptZoom).toBe(100);
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
      manuscriptZoom: 100,
      typewriterMode: true,
      manuscriptGuidance: true,
    });
    expect("measure" in parsePreferences(stored)).toBe(false);
  });

  it("falls back safely when stored preferences are invalid", () => {
    expect(parsePreferences("{not-json")).toEqual(defaultPreferences);
    expect(parsePreferences("[]")).toEqual(defaultPreferences);
  });

  it("clamps and rounds the saved manuscript zoom", () => {
    expect(parsePreferences('{"manuscriptZoom":126}').manuscriptZoom).toBe(130);
    expect(parsePreferences('{"manuscriptZoom":20}').manuscriptZoom).toBe(80);
    expect(parsePreferences('{"manuscriptZoom":200}').manuscriptZoom).toBe(140);
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
