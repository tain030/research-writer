import { describe, expect, it } from "vitest";
import {
  carriageReturnDuration,
  isTypebarKey,
  renderedTranslateX,
  resolveCarriageOrigin,
  resolveCarriageTarget,
  resolveScrollbarGutter,
  typebarOriginForCode,
  typewriterStrikeBottomClearance,
} from "./typewriter-carriage";

describe("typewriter carriage geometry", () => {
  it("reads the rendered translation from 2D and 3D CSS matrices", () => {
    expect(renderedTranslateX("none")).toBe(0);
    expect(renderedTranslateX("matrix(1, 0, 0, 1, 262.569, 0)")).toBeCloseTo(
      262.569,
    );
    expect(
      renderedTranslateX(
        "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 381.5, 0, 0, 1)",
      ),
    ).toBeCloseTo(381.5);
    expect(renderedTranslateX("translateX(12px)")).toBeNull();
  });

  it("retargets from the rendered frame instead of an animation destination", () => {
    // The stored destination may already be 411px while the paper is only at
    // 262px. The caret is therefore at 562px on screen, not at the destination.
    expect(
      resolveCarriageTarget({
        renderedShift: 262,
        caretLeft: 562,
        strikePoint: 712,
      }),
    ).toBe(412);
  });

  it("refuses invalid measurements without forcing the paper back to zero", () => {
    expect(
      resolveCarriageTarget({
        renderedShift: Number.NaN,
        caretLeft: 712,
        strikePoint: 712,
      }),
    ).toBeNull();
  });

  it("keeps the carriage artwork on the paper's unshifted layout origin", () => {
    expect(
      resolveCarriageOrigin({
        paperLeft: 247,
        paperWidth: 794,
        renderedShift: 120,
        machineLeft: 0,
        machineWidth: 1280,
      }),
    ).toBe(-116);
    expect(
      resolveCarriageOrigin({
        paperLeft: 367,
        paperWidth: 794,
        renderedShift: 240,
        machineLeft: 0,
        machineWidth: 1280,
      }),
    ).toBe(-116);
  });

  it("ignores unusable carriage-origin measurements", () => {
    expect(
      resolveCarriageOrigin({
        paperLeft: 0,
        paperWidth: 0,
        renderedShift: 0,
        machineLeft: 0,
        machineWidth: 800,
      }),
    ).toBeNull();
  });

  it("reserves the real scrollbar gutter without inventing overlay space", () => {
    expect(resolveScrollbarGutter(1154, 1139)).toBe(15);
    expect(resolveScrollbarGutter(1154, 1154)).toBe(0);
    expect(resolveScrollbarGutter(1139, 1154)).toBe(0);
    expect(resolveScrollbarGutter(Number.NaN, 1139)).toBe(0);
  });

  it("strikes for printable and Korean IME keys, but not spacing or controls", () => {
    expect(isTypebarKey({ key: "a", code: "KeyA" })).toBe(true);
    expect(isTypebarKey({ key: "Process", code: "KeyR" })).toBe(true);
    expect(isTypebarKey({ key: " ", code: "Space" })).toBe(false);
    expect(isTypebarKey({ key: "Enter", code: "Enter" })).toBe(false);
    expect(isTypebarKey({ key: "a", code: "KeyA", ctrlKey: true })).toBe(
      false,
    );
  });

  it("maps physical keys to stable positions across the type basket", () => {
    expect(typebarOriginForCode("KeyQ", 1)).toBe(-1);
    expect(typebarOriginForCode("KeyU", 2)).toBe(0);
    expect(typebarOriginForCode("Backslash", 3)).toBe(1);
    expect(typebarOriginForCode("Unknown", 0)).not.toBe(
      typebarOriginForCode("Unknown", 1),
    );
  });

  it("scales manual carriage return timing with travel distance", () => {
    expect(carriageReturnDuration(0)).toBe(180);
    expect(carriageReturnDuration(300)).toBe(254);
    expect(carriageReturnDuration(1000)).toBe(300);
    expect(carriageReturnDuration(Number.NaN)).toBe(180);
  });

  it("anchors the strike point above an 18px minimal rail bed", () => {
    expect(typewriterStrikeBottomClearance(22)).toBe(42);
    expect(typewriterStrikeBottomClearance(40)).toBe(51);
    expect(typewriterStrikeBottomClearance(58)).toBe(60);
    expect(typewriterStrikeBottomClearance(Number.NaN)).toBe(42);
  });
});
