import { describe, expect, it } from "vitest";
import {
  approximatePrintingGraphemeAdvance,
  isPrintingKey,
  printCarrierReturnDuration,
  printingCursorMetrics,
  printingElementPoseForCode,
  representativePrintingGrapheme,
  resolvePaperMachineOrigin,
  resolvePrintCarrierOffset,
  resolvePrintingCellCenter,
  resolveScrollbarGutter,
  typewriterStrikeBottomClearance,
} from "./typewriter-carriage";

describe("stationary-paper typewriter geometry", () => {
  it("chooses a stable empty-cell sample from the nearest writing script", () => {
    expect(representativePrintingGrapheme("본문 문장… → ")).toBe("가");
    expect(representativePrintingGrapheme("漢字。")).toBe("漢");
    expect(representativePrintingGrapheme("ひらがな。")).toBe("あ");
    expect(representativePrintingGrapheme("カタカナ。")).toBe("ア");
    expect(representativePrintingGrapheme("release notes!")).toBe("n");
    expect(representativePrintingGrapheme("API: ")).toBe("H");
    expect(representativePrintingGrapheme("2026. ")).toBe("0");
    expect(representativePrintingGrapheme("완료 👩‍💻")).toBe("👩‍💻");
    expect(representativePrintingGrapheme("   … → ")).toBeNull();
  });

  it("uses script-aware estimates only when browser glyph measurement fails", () => {
    expect(approximatePrintingGraphemeAdvance("가", 14)).toBeCloseTo(12.32);
    expect(approximatePrintingGraphemeAdvance("漢", 14)).toBeCloseTo(12.32);
    expect(approximatePrintingGraphemeAdvance("H", 14)).toBeCloseTo(9.52);
    expect(approximatePrintingGraphemeAdvance("n", 14)).toBeCloseTo(7.84);
    expect(approximatePrintingGraphemeAdvance("0", 14)).toBeCloseTo(8.4);
    expect(approximatePrintingGraphemeAdvance("👩‍💻", 14)).toBe(14);
  });

  it("tracks the resolved print point instead of translating the paper", () => {
    expect(
      resolvePrintCarrierOffset({
        printPointLeft: 562,
        paperLeft: 247,
        paperWidth: 794,
      }),
    ).toBe(-82);
    expect(
      resolvePrintCarrierOffset({
        printPointLeft: 712,
        paperLeft: 247,
        paperWidth: 794,
      }),
    ).toBe(68);
  });

  it("refuses unusable carrier measurements", () => {
    expect(
      resolvePrintCarrierOffset({
        printPointLeft: 712,
        paperLeft: 247,
        paperWidth: 0,
      }),
    ).toBeNull();
  });

  it("centers the print point on a visible grapheme or either adjacent empty cell", () => {
    expect(
      resolvePrintingCellCenter({
        caretLeft: 500,
        glyphLeft: 506,
        glyphRight: 524,
        fallbackAdvance: 12,
      }),
    ).toBe(515);
    expect(
      resolvePrintingCellCenter({
        caretLeft: 500,
        fallbackAdvance: 12,
      }),
    ).toBe(506);
    expect(
      resolvePrintingCellCenter({
        caretLeft: 500,
        fallbackAdvance: 12,
        fallbackSide: "before",
      }),
    ).toBe(494);
    expect(
      resolvePrintingCellCenter({
        caretLeft: 500,
        fallbackAdvance: 12,
        direction: "rtl",
      }),
    ).toBe(494);
    expect(
      resolvePrintingCellCenter({
        caretLeft: 500,
        fallbackAdvance: 12,
        direction: "rtl",
        fallbackSide: "before",
      }),
    ).toBe(506);
    expect(
      resolvePrintingCellCenter({
        caretLeft: 500,
        fallbackAdvance: Number.NaN,
      }),
    ).toBe(500);
    expect(
      resolvePrintingCellCenter({
        caretLeft: Number.NaN,
        fallbackAdvance: 12,
      }),
    ).toBeNull();
  });

  it("aligns fixed platen hardware with the stationary sheet", () => {
    expect(
      resolvePaperMachineOrigin({
        paperLeft: 247,
        paperWidth: 794,
        machineLeft: 0,
        machineWidth: 1280,
      }),
    ).toBe(4);
    expect(
      resolvePaperMachineOrigin({
        paperLeft: 367,
        paperWidth: 794,
        machineLeft: 120,
        machineWidth: 1280,
      }),
    ).toBe(4);
  });

  it("ignores unusable platen-origin measurements", () => {
    expect(
      resolvePaperMachineOrigin({
        paperLeft: 0,
        paperWidth: 0,
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
    expect(isPrintingKey({ key: "a", code: "KeyA" })).toBe(true);
    expect(isPrintingKey({ key: "Process", code: "KeyR" })).toBe(true);
    expect(isPrintingKey({ key: " ", code: "Space" })).toBe(false);
    expect(isPrintingKey({ key: "Enter", code: "Enter" })).toBe(false);
    expect(isPrintingKey({ key: "a", code: "KeyA", ctrlKey: true })).toBe(false);
  });

  it("maps physical keys to restrained tilt and rotate poses", () => {
    expect(printingElementPoseForCode("KeyQ", 1)).toEqual({
      rotate: -9,
      tilt: -1,
    });
    expect(printingElementPoseForCode("KeyU", 2)).toEqual({
      rotate: 0,
      tilt: -1,
    });
    expect(printingElementPoseForCode("Backslash", 3)).toEqual({
      rotate: 9,
      tilt: -1,
    });
    expect(printingElementPoseForCode("Unknown", 0)).not.toEqual(
      printingElementPoseForCode("Unknown", 1),
    );
  });

  it("sizes a low horizontal strike face from body or heading type", () => {
    expect(printingCursorMetrics(10.75 * 96 / 72, 1)).toEqual({
      strikeWidth: 10,
      strikeHeight: 3,
      strikeTopOffset: 8.67,
      elementWidth: 14,
      elementHeight: 13,
    });
    expect(printingCursorMetrics(32, 1)).toEqual({
      strikeWidth: 16.64,
      strikeHeight: 4,
      strikeTopOffset: 17.5,
      elementWidth: 19,
      elementHeight: 16.72,
    });
    expect(printingCursorMetrics(32, 1.28)).toEqual({
      strikeWidth: 17,
      strikeHeight: 4,
      strikeTopOffset: 21.98,
      elementWidth: 19,
      elementHeight: 16.72,
    });
  });

  it("clamps tiny zoom levels and falls back from invalid measurements", () => {
    expect(printingCursorMetrics(14, 0.2)).toEqual({
      strikeWidth: 10,
      strikeHeight: 3,
      strikeTopOffset: 6,
      elementWidth: 14,
      elementHeight: 13,
    });
    expect(printingCursorMetrics(Number.NaN, Number.NaN)).toEqual({
      strikeWidth: 10,
      strikeHeight: 3,
      strikeTopOffset: 8.5,
      elementWidth: 14,
      elementHeight: 13,
    });
  });

  it("scales powered carrier return timing with travel distance", () => {
    expect(printCarrierReturnDuration(0)).toBe(180);
    expect(printCarrierReturnDuration(300)).toBe(254);
    expect(printCarrierReturnDuration(1000)).toBe(300);
    expect(printCarrierReturnDuration(Number.NaN)).toBe(180);
  });

  it("anchors the printing line above a 19px minimal rail bed", () => {
    expect(typewriterStrikeBottomClearance(22)).toBe(43);
    expect(typewriterStrikeBottomClearance(40)).toBe(52);
    expect(typewriterStrikeBottomClearance(58)).toBe(61);
    expect(typewriterStrikeBottomClearance(Number.NaN)).toBe(43);
  });
});
