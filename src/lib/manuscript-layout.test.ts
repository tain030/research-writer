import { describe, expect, it } from "vitest";
import {
  caretPlacementForOffset,
  cellIndexForOffset,
  MANUSCRIPT_CELLS_PER_PAGE,
  MANUSCRIPT_COLUMNS,
  layoutManuscript,
  pageIndexForOffset,
  paginateManuscript,
} from "./manuscript-layout";

describe("400-character manuscript layout", () => {
  it("creates a blank 20 by 20 first page", () => {
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

  it("wraps after 20 cells and paginates after 400", () => {
    const fourHundred = paginateManuscript("가".repeat(400));
    const fourHundredOne = paginateManuscript("가".repeat(401));

    expect(fourHundred).toHaveLength(1);
    expect(fourHundred[0].cells[399].text).toBe("가");
    expect(fourHundredOne).toHaveLength(2);
    expect(fourHundredOne[1].cells[0]).toMatchObject({
      text: "가",
      row: 0,
      column: 0,
    });
  });

  it("moves a trailing line break after the last row to a blank page", () => {
    const pages = paginateManuscript(`${"가".repeat(400)}\n`);

    expect(pages).toHaveLength(2);
    expect(pages[1].cells[0].filled).toBe(false);
    expect(pages[1].cells[0].caretOffset).toBe(401);
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
    const pages = paginateManuscript(`${"가".repeat(400)}나`);

    expect(pageIndexForOffset(pages, 400)).toBe(1);
    expect(cellIndexForOffset(pages[1], 400)).toBe(0);
  });
});

describe("semantic Korean manuscript layout", () => {
  it("reserves the first-page header and automatically indents body paragraphs", () => {
    const { pages, document } = layoutManuscript(
      [
        "---",
        "title: 원고지의 하루",
        "author: 김작가",
        "genre: 수필",
        "---",
        "",
        "첫 문장입니다.",
      ].join("\n"),
    );
    const page = pages[0];

    expect(document.metadata.title).toBe("원고지의 하루");
    expect(page.cells[1].text).toBe("수");
    expect(page.cells[MANUSCRIPT_COLUMNS + 7].style).toBe("title");
    expect(page.cells[5 * MANUSCRIPT_COLUMNS]).toMatchObject({
      virtual: true,
      filled: true,
      text: "",
    });
    expect(page.cells[5 * MANUSCRIPT_COLUMNS + 1].text).toBe("첫");
  });

  it("uses the same compact Latin-cell rules for titles and authors", () => {
    const { pages } = layoutManuscript(
      [
        "---",
        "title: My research 2026",
        "author: Jane Doe",
        "---",
        "",
        "본문",
      ].join("\n"),
    );
    const page = pages[0];
    const title = page.cells
      .slice(MANUSCRIPT_COLUMNS, 2 * MANUSCRIPT_COLUMNS)
      .filter((cell) => cell.filled);
    const author = page.cells
      .slice(3 * MANUSCRIPT_COLUMNS, 4 * MANUSCRIPT_COLUMNS)
      .filter((cell) => cell.filled);

    expect(title.map((cell) => cell.text)).toEqual([
      "M",
      "y",
      " ",
      "re",
      "se",
      "ar",
      "ch",
      " ",
      "20",
      "26",
    ]);
    expect(title[0].column).toBe(5);
    expect(title.filter((cell) => cell.compact)).toHaveLength(6);
    expect(author.map((cell) => cell.text)).toEqual([
      "J",
      "an",
      "e",
      " ",
      "D",
      "oe",
    ]);
    expect(author[0].column).toBe(12);
  });

  it("places edit-only guides for document and section headings", () => {
    const source = "# 문서 제목\n\n## ";
    const { pages } = layoutManuscript(source);

    expect(pages[0].headingGuides).toEqual([
      {
        from: 0,
        to: "# 문서 제목".length,
        row: 1,
        level: 1,
        empty: false,
        documentTitle: true,
      },
      {
        from: source.indexOf("##"),
        to: source.length,
        row: 5,
        level: 2,
        empty: true,
        documentTitle: false,
      },
    ]);
  });

  it("collapses a hidden title marker onto the first real title cell", () => {
    const source = "# ab";
    const layout = layoutManuscript(source);
    const marker = caretPlacementForOffset(layout, 0, "forward");
    const titleStart = caretPlacementForOffset(layout, 2, "forward");
    const titleMiddle = caretPlacementForOffset(layout, 3, "forward");

    expect(marker).toEqual(titleStart);
    expect(titleStart.cellIndex).toBe(MANUSCRIPT_COLUMNS + 9);
    expect([titleStart.slot, titleMiddle.slot]).toEqual([0, 1]);
  });

  it("leaves the title row empty while an empty document heading is active", () => {
    const layout = layoutManuscript("#");
    const { pages } = layout;
    const titleCells = pages[0].cells.slice(
      MANUSCRIPT_COLUMNS,
      2 * MANUSCRIPT_COLUMNS,
    );

    expect(titleCells.every((cell) => !cell.filled)).toBe(true);
    expect(pages[0].headingGuides[0]).toMatchObject({
      level: 1,
      empty: true,
      documentTitle: true,
    });
    expect(caretPlacementForOffset(layout, 1, "forward")).toMatchObject({
      pageIndex: 0,
      cellIndex: MANUSCRIPT_COLUMNS + 9,
    });
  });

  it("groups lowercase Latin letters and digits two per cell", () => {
    const { pages } = layoutManuscript("# 제목\n\nab12한");
    const body = pages[0].cells.slice(5 * MANUSCRIPT_COLUMNS);
    const visible = body.filter((cell) => cell.filled && !cell.virtual);

    expect(visible.slice(0, 3).map((cell) => cell.text)).toEqual([
      "ab",
      "12",
      "한",
    ]);
    expect(visible[0].compact).toBe(true);
  });

  it("keeps closing punctuation in the preceding line-end cell", () => {
    const { pages } = layoutManuscript(`# 제목\n\n${"가".repeat(19)}.`);
    const firstBodyLine = pages[0].cells.slice(
      5 * MANUSCRIPT_COLUMNS,
      6 * MANUSCRIPT_COLUMNS,
    );

    expect(firstBodyLine[19].text).toBe("가.");
    expect(firstBodyLine[19].compact).toBe(true);
    expect(pages[0].cells[6 * MANUSCRIPT_COLUMNS].filled).toBe(false);
  });

  it("moves opening punctuation away from the final cell of a line", () => {
    const { pages } = layoutManuscript(`# 제목\n\n${"가".repeat(18)}“나`);

    expect(pages[0].cells[5 * MANUSCRIPT_COLUMNS + 19].filled).toBe(false);
    expect(pages[0].cells[6 * MANUSCRIPT_COLUMNS].text).toBe("“");
    expect(pages[0].cells[6 * MANUSCRIPT_COLUMNS + 1].text).toBe("나");
  });

  it("hides Markdown marks and reserves two rows for structured blocks", () => {
    const { pages } = layoutManuscript(
      "# 제목\n\n**강조**와 [링크](https://example.com)\n\n![그림](assets/a.png)",
    );
    const bodyText = pages[0].cells
      .slice(5 * MANUSCRIPT_COLUMNS)
      .filter((cell) => cell.filled && !cell.virtual)
      .map((cell) => cell.text)
      .join("");

    expect(bodyText).toContain("강조와 링크");
    expect(bodyText).not.toContain("**");
    expect(bodyText).not.toContain("https://");
    expect(pages[0].blocks).toHaveLength(1);
    expect(pages[0].blocks[0]).toMatchObject({
      kind: "figure",
      rows: 2,
      label: "그림",
    });
  });

  it("maps the end caret to the body instead of an unused header cell", () => {
    const source = "# 제목\n\n마지막";
    const { pages } = layoutManuscript(source);
    const pageIndex = pageIndexForOffset(pages, source.length);
    const cellIndex = cellIndexForOffset(pages[pageIndex], source.length);

    expect(pageIndex).toBe(0);
    expect(cellIndex).toBeGreaterThanOrEqual(5 * MANUSCRIPT_COLUMNS);
  });

  it("places every newly typed trailing space in its own cell immediately", () => {
    const source = "# 제목\n\n단어  ";
    const { pages } = layoutManuscript(source);
    const visible = pages[0].cells
      .slice(5 * MANUSCRIPT_COLUMNS)
      .filter((cell) => cell.filled && !cell.virtual);

    expect(visible.map((cell) => cell.text)).toEqual(["단", "어", " ", " "]);
    expect(visible.slice(-2)).toMatchObject([
      { from: source.length - 2, to: source.length - 1 },
      { from: source.length - 1, to: source.length },
    ]);
    expect(
      cellIndexForOffset(pages[0], source.length),
    ).toBeGreaterThan(5 * MANUSCRIPT_COLUMNS + 3);
  });

  it("keeps a source-aware caret for hard breaks and empty paragraphs", () => {
    const firstBreak = layoutManuscript("가\n");
    const emptyParagraph = layoutManuscript("가\n\n");
    const nextEmptyParagraph = layoutManuscript("가\n\n\n");

    const afterLetter = caretPlacementForOffset(firstBreak, 1, "backward");
    const afterBreak = caretPlacementForOffset(firstBreak, 2, "forward");
    const afterParagraph = caretPlacementForOffset(
      emptyParagraph,
      3,
      "forward",
    );
    const afterSecondParagraph = caretPlacementForOffset(
      nextEmptyParagraph,
      4,
      "forward",
    );

    expect(afterBreak.cellIndex).toBeGreaterThan(afterLetter.cellIndex);
    expect(afterParagraph.cellIndex).toBe(afterBreak.cellIndex + 1);
    expect(afterSecondParagraph.cellIndex).toBeGreaterThan(
      afterParagraph.cellIndex,
    );
  });

  it("keeps every empty-paragraph caret when text follows the blank lines", () => {
    const source = "가\n\n\n나";
    const layout = layoutManuscript(source);
    const afterFirstBreak = caretPlacementForOffset(layout, 2, "forward");
    const afterEmptyParagraph = caretPlacementForOffset(layout, 3, "forward");
    const beforeNextParagraph = caretPlacementForOffset(layout, 4, "forward");

    expect(afterFirstBreak.cellIndex % MANUSCRIPT_COLUMNS).toBe(0);
    expect(afterEmptyParagraph.cellIndex % MANUSCRIPT_COLUMNS).toBe(1);
    expect(beforeNextParagraph.cellIndex).toBeGreaterThan(
      afterEmptyParagraph.cellIndex,
    );
    expect(beforeNextParagraph.cellIndex % MANUSCRIPT_COLUMNS).toBe(1);
  });

  it("exposes every half-cell source stop and skips hidden Markdown marks", () => {
    const compactSource = "# 제목\n\nab";
    const compact = layoutManuscript(compactSource);
    const a = compactSource.indexOf("ab");
    const first = caretPlacementForOffset(compact, a, "forward");
    const middle = caretPlacementForOffset(compact, a + 1, "forward");
    const last = caretPlacementForOffset(compact, a + 2, "backward");

    expect([first.cellIndex, middle.cellIndex, last.cellIndex]).toEqual([
      first.cellIndex,
      first.cellIndex,
      first.cellIndex,
    ]);
    expect([first.slot, middle.slot, last.slot]).toEqual([0, 1, 2]);

    const markdownSource = "# 제목\n\n**강조**";
    const markdown = layoutManuscript(markdownSource);
    const opening = markdownSource.indexOf("**");
    expect(
      caretPlacementForOffset(markdown, opening, "forward"),
    ).toEqual(caretPlacementForOffset(markdown, opening + 2, "forward"));
  });

  it("keeps page offset boundaries monotonic when a card moves to a new page", () => {
    const paragraphs = Array.from(
      { length: 14 },
      (_, index) => `문단 ${index + 1}`,
    );
    const source = [
      "# 제목",
      "",
      ...paragraphs.flatMap((paragraph) => [paragraph, ""]),
      "![그림](assets/a.png)",
      "",
      "카드 뒤 문장",
    ].join("\n");
    const { pages } = layoutManuscript(source);
    const figureOffset = source.indexOf("![그림]");

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map((page) => page.endOffset)).toEqual(
      [...pages.map((page) => page.endOffset)].sort((left, right) => left - right),
    );
    expect(pageIndexForOffset(pages, figureOffset)).toBe(1);
  });
});
