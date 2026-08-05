import { describe, expect, it } from "vitest";
import { resolveCaretLineGeometry } from "./caret-line-geometry";

const page = {
  stack: { top: 100, left: 50 },
  scale: 1,
  pageWidth: 800,
  pageHeight: 1120,
  pageGap: 28,
  pageTopInset: 84,
  pageBottomInset: 68,
  pageHorizontalInset: 76,
} as const;

describe("caret line geometry", () => {
  it("uses the visual line nearest the caret rather than the whole block", () => {
    const result = resolveCaretLineGeometry({
      ...page,
      caret: { top: 310, bottom: 338, left: 410, right: 410 },
      lineRects: [
        { top: 270, bottom: 298, left: 130, right: 650 },
        { top: 310, bottom: 338, left: 130, right: 530 },
      ],
      blockKind: "heading",
    });

    expect(result).toMatchObject({
      pageIndex: 0,
      top: 210,
      height: 28,
      lineLeft: 80,
      lineWidth: 400,
      blockKind: "heading",
    });
  });

  it("normalizes zoomed coordinates and preserves list indentation", () => {
    const result = resolveCaretLineGeometry({
      ...page,
      scale: 0.5,
      caret: { top: 250, bottom: 264, left: 205, right: 205 },
      lineRects: [{ top: 250, bottom: 264, left: 150, right: 340 }],
      blockKind: "list-item",
    });

    expect(result).toMatchObject({
      top: 300,
      height: 28,
      caretLeft: 310,
      lineLeft: 200,
      lineWidth: 380,
    });
  });

  it("clips a tall title to the printable page body", () => {
    const result = resolveCaretLineGeometry({
      ...page,
      caret: { top: 176, bottom: 214, left: 300, right: 300 },
      lineRects: [{ top: 160, bottom: 214, left: 100, right: 700 }],
      blockKind: "heading",
    });

    expect(result?.top).toBe(84);
    expect(result?.height).toBe(30);
  });

  it("assigns the caret after a page gap to the next sheet", () => {
    const secondPageTop = page.stack.top + page.pageHeight + page.pageGap;
    const result = resolveCaretLineGeometry({
      ...page,
      caret: {
        top: secondPageTop + 110,
        bottom: secondPageTop + 138,
        left: 220,
        right: 220,
      },
      lineRects: [
        {
          top: secondPageTop + 110,
          bottom: secondPageTop + 138,
          left: 130,
          right: 620,
        },
      ],
      blockKind: "paragraph",
    });

    expect(result?.pageIndex).toBe(1);
    expect(result?.top).toBe(page.pageHeight + page.pageGap + 110);
  });

  it("returns null when the caret falls in the physical page gap", () => {
    const result = resolveCaretLineGeometry({
      ...page,
      caret: { top: 1225, bottom: 1227, left: 200, right: 200 },
      lineRects: [],
      blockKind: "paragraph",
    });

    expect(result).toBeNull();
  });
});
