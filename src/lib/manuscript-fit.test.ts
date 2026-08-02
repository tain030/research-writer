import { describe, expect, it } from "vitest";
import {
  calculateContainedPageScale,
  calculateManuscriptFitScale,
  MANUSCRIPT_GUTTER_X,
  MANUSCRIPT_PAGE_BORDER,
  MANUSCRIPT_PAPER_HEIGHT,
  MANUSCRIPT_PAPER_WIDTH,
  PAGE_FIT_INSET,
  PAGE_FIT_SAFETY,
} from "./manuscript-fit";

describe("manuscript viewport fitting", () => {
  it("fits the whole page using the tighter viewport axis", () => {
    const viewport = { width: 1_180, height: 774 };
    const expected =
      (viewport.height -
        PAGE_FIT_INSET * 2 -
        PAGE_FIT_SAFETY) /
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
    ).toBeGreaterThan(0);
  });

  it("contains fractional page sizes without a rounding overflow", () => {
    const viewport = { width: 713.25, height: 511.5 };
    const page = { width: 793.7, height: 1_122.6 };
    const scale = calculateContainedPageScale({ viewport, page });

    expect(page.width * scale + PAGE_FIT_INSET * 2).toBeLessThan(
      viewport.width,
    );
    expect(page.height * scale + PAGE_FIT_INSET * 2).toBeLessThan(
      viewport.height,
    );
  });
});
