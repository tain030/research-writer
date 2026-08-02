import { describe, expect, it } from "vitest";
import {
  calculateManuscriptFitScale,
  MANUSCRIPT_GUTTER_BOTTOM,
  MANUSCRIPT_GUTTER_TOP,
  MANUSCRIPT_GUTTER_X,
  MANUSCRIPT_PAGE_BORDER,
  MANUSCRIPT_PAPER_HEIGHT,
  MANUSCRIPT_PAPER_WIDTH,
} from "./manuscript-fit";

describe("manuscript viewport fitting", () => {
  it("fits the whole page using the tighter viewport axis", () => {
    const viewport = { width: 1_180, height: 774 };
    const expected =
      (viewport.height -
        MANUSCRIPT_GUTTER_TOP -
        MANUSCRIPT_GUTTER_BOTTOM -
        MANUSCRIPT_PAGE_BORDER) /
      MANUSCRIPT_PAPER_HEIGHT;

    expect(calculateManuscriptFitScale(viewport, "page")).toBeCloseTo(expected);
  });

  it("fits page width independently of viewport height", () => {
    const viewport = { width: 1_180, height: 540 };
    const expected =
      (viewport.width - MANUSCRIPT_GUTTER_X * 2 - MANUSCRIPT_PAGE_BORDER) /
      MANUSCRIPT_PAPER_WIDTH;

    expect(calculateManuscriptFitScale(viewport, "width")).toBeCloseTo(expected);
  });

  it("keeps a safe positive scale for a collapsed viewport", () => {
    expect(
      calculateManuscriptFitScale({ width: 0, height: 0 }, "page"),
    ).toBe(0.1);
  });
});
