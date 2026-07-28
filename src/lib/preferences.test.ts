import { describe, expect, it } from "vitest";
import { defaultPreferences, parsePreferences } from "./preferences";

describe("writing preferences", () => {
  it("uses Pretendard for a fresh profile", () => {
    expect(defaultPreferences.fontFamily).toBe("Pretendard");
    expect(parsePreferences(null).fontFamily).toBe("Pretendard");
  });

  it("preserves an existing explicit font choice", () => {
    const stored = JSON.stringify({
      fontFamily: "MaruBuri",
      measure: 72,
    });

    expect(parsePreferences(stored)).toMatchObject({
      fontFamily: "MaruBuri",
      measure: 72,
      typewriterMode: true,
    });
  });

  it("falls back safely when stored preferences are invalid", () => {
    expect(parsePreferences("{not-json")).toEqual(defaultPreferences);
    expect(parsePreferences("[]")).toEqual(defaultPreferences);
  });
});
