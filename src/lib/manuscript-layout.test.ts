import { describe, expect, it } from "vitest";
import {
  cellIndexForOffset,
  MANUSCRIPT_CELLS_PER_PAGE,
  pageIndexForOffset,
  paginateManuscript,
} from "./manuscript-layout";

describe("200-character manuscript layout", () => {
  it("creates a blank 20 by 10 first page", () => {
    const pages = paginateManuscript("");

    expect(pages).toHaveLength(1);
    expect(pages[0].cells).toHaveLength(MANUSCRIPT_CELLS_PER_PAGE);
    expect(pages[0].cells[0]).toMatchObject({
      row: 0,
      column: 0,
      caretOffset: 0,
      filled: false,
    });
  });

  it("wraps after 20 cells and paginates after 200", () => {
    const twoHundred = paginateManuscript("가".repeat(200));
    const twoHundredOne = paginateManuscript("가".repeat(201));

    expect(twoHundred).toHaveLength(1);
    expect(twoHundred[0].cells[199].text).toBe("가");
    expect(twoHundredOne).toHaveLength(2);
    expect(twoHundredOne[1].cells[0]).toMatchObject({
      text: "가",
      row: 0,
      column: 0,
    });
  });

  it("moves a trailing line break after the last row to a blank page", () => {
    const pages = paginateManuscript(`${"가".repeat(200)}\n`);

    expect(pages).toHaveLength(2);
    expect(pages[1].cells[0].filled).toBe(false);
    expect(pages[1].cells[0].caretOffset).toBe(201);
  });

  it("moves a hard newline to the next manuscript row", () => {
    const [page] = paginateManuscript("가\n나");

    expect(page.cells[0].text).toBe("가");
    expect(page.cells[20]).toMatchObject({
      text: "나",
      row: 1,
      column: 0,
      from: 2,
    });
    expect(page.cells[1].caretOffset).toBe(1);
  });

  it("counts an emoji sequence and combining text as grapheme cells", () => {
    const [page] = paginateManuscript("👨‍👩‍👧‍👦e\u0301한");

    expect(page.cells.filter((cell) => cell.filled)).toHaveLength(3);
    expect(page.cells[0].text).toBe("👨‍👩‍👧‍👦");
    expect(page.cells[1].text).toBe("e\u0301");
    expect(page.cells[2].text).toBe("한");
  });

  it("expands a stored tab to the next four-cell stop", () => {
    const [page] = paginateManuscript("가\t나");

    expect(page.cells[0].text).toBe("가");
    expect(page.cells[1].text).toBe("⇥");
    expect(page.cells[4].text).toBe("나");
  });

  it("maps source offsets back to a page and cell", () => {
    const pages = paginateManuscript(`${"가".repeat(200)}나`);

    expect(pageIndexForOffset(pages, 200)).toBe(1);
    expect(cellIndexForOffset(pages[1], 200)).toBe(0);
  });
});
