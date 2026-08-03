import { describe, expect, it } from "vitest";
import {
  isHalfCellCharacter,
  isHalfCellPair,
  packHalfCellText,
} from "./manuscript-characters";

describe("manuscript half-cell characters", () => {
  it("recognizes only lowercase Latin letters and digits as half-cell text", () => {
    expect(isHalfCellCharacter("a")).toBe(true);
    expect(isHalfCellCharacter("7")).toBe(true);
    expect(isHalfCellCharacter("A")).toBe(false);
    expect(isHalfCellCharacter("가")).toBe(false);
    expect(isHalfCellPair("ab")).toBe(true);
    expect(isHalfCellPair("20")).toBe(true);
    expect(isHalfCellPair("a.")).toBe(false);
    expect(isHalfCellPair("가.")).toBe(false);
  });

  it("packs lowercase and numeric runs without crossing other characters", () => {
    expect(packHalfCellText("My name 2026")).toEqual([
      "M",
      "y",
      " ",
      "na",
      "me",
      " ",
      "20",
      "26",
    ]);
    expect(packHalfCellText("abc한12")).toEqual(["ab", "c", "한", "12"]);
  });
});
