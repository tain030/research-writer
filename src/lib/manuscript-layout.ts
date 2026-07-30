export const MANUSCRIPT_COLUMNS = 20;
export const MANUSCRIPT_ROWS = 20;
export const MANUSCRIPT_CELLS_PER_PAGE =
  MANUSCRIPT_COLUMNS * MANUSCRIPT_ROWS;

export interface ManuscriptCell {
  index: number;
  row: number;
  column: number;
  text: string;
  from: number;
  to: number;
  caretOffset: number;
  filled: boolean;
  tabContinuation: boolean;
}

export interface ManuscriptPage {
  number: number;
  cells: ManuscriptCell[];
}

interface Grapheme {
  segment: string;
  index: number;
}

function graphemes(value: string): Grapheme[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter("ko", { granularity: "grapheme" });
    return Array.from(segmenter.segment(value), (entry) => ({
      segment: entry.segment,
      index: entry.index,
    }));
  }

  const result: Grapheme[] = [];
  let index = 0;
  for (const segment of Array.from(value)) {
    result.push({ segment, index });
    index += segment.length;
  }
  return result;
}

function blankPage(number: number): ManuscriptPage {
  return {
    number,
    cells: Array.from(
      { length: MANUSCRIPT_CELLS_PER_PAGE },
      (_, index): ManuscriptCell => ({
        index,
        row: Math.floor(index / MANUSCRIPT_COLUMNS),
        column: index % MANUSCRIPT_COLUMNS,
        text: "",
        from: 0,
        to: 0,
        caretOffset: 0,
        filled: false,
        tabContinuation: false,
      }),
    ),
  };
}

export function paginateManuscript(value: string): ManuscriptPage[] {
  const pages = [blankPage(1)];
  let pageIndex = 0;
  let row = 0;
  let column = 0;
  let lastOffset = 0;

  const currentPage = () => pages[pageIndex];
  const ensurePosition = () => {
    if (column >= MANUSCRIPT_COLUMNS) {
      column = 0;
      row += 1;
    }
    if (row >= MANUSCRIPT_ROWS) {
      pages.push(blankPage(pages.length + 1));
      pageIndex += 1;
      row = 0;
    }
  };
  const fillUntilRowEnd = (offset: number) => {
    if (column >= MANUSCRIPT_COLUMNS) return;
    for (let current = column; current < MANUSCRIPT_COLUMNS; current += 1) {
      const cell = currentPage().cells[row * MANUSCRIPT_COLUMNS + current];
      if (!cell.filled) {
        cell.from = offset;
        cell.to = offset;
        cell.caretOffset = offset;
      }
    }
  };
  const placeCell = (
    text: string,
    from: number,
    to: number,
    tabContinuation = false,
  ) => {
    ensurePosition();
    const cell =
      currentPage().cells[row * MANUSCRIPT_COLUMNS + column];
    cell.text = text;
    cell.from = from;
    cell.to = to;
    cell.caretOffset = from;
    cell.filled = true;
    cell.tabContinuation = tabContinuation;
    column += 1;
  };

  for (const grapheme of graphemes(value)) {
    const from = grapheme.index;
    const to = from + grapheme.segment.length;
    lastOffset = to;

    if (grapheme.segment.includes("\n")) {
      fillUntilRowEnd(from);
      column = 0;
      row += 1;
      if (row < MANUSCRIPT_ROWS) {
        const first = currentPage().cells[row * MANUSCRIPT_COLUMNS];
        first.from = to;
        first.to = to;
        first.caretOffset = to;
      }
      continue;
    }

    if (grapheme.segment === "\t") {
      ensurePosition();
      const tabWidth = 4 - (column % 4);
      for (let index = 0; index < tabWidth; index += 1) {
        placeCell(index === 0 ? "⇥" : "", from, to, index > 0);
      }
      continue;
    }

    placeCell(grapheme.segment, from, to);
  }

  if (row >= MANUSCRIPT_ROWS) {
    pages.push(blankPage(pages.length + 1));
    pageIndex += 1;
    row = 0;
  }
  if (column >= MANUSCRIPT_COLUMNS && row < MANUSCRIPT_ROWS - 1) {
    column = 0;
    row += 1;
  }
  if (row < MANUSCRIPT_ROWS) {
    for (let currentRow = row; currentRow < MANUSCRIPT_ROWS; currentRow += 1) {
      const startColumn = currentRow === row ? column : 0;
      for (
        let currentColumn = startColumn;
        currentColumn < MANUSCRIPT_COLUMNS;
        currentColumn += 1
      ) {
        const cell =
          currentPage().cells[
            currentRow * MANUSCRIPT_COLUMNS + currentColumn
          ];
        if (!cell.filled && cell.from === 0 && cell.to === 0) {
          cell.from = lastOffset;
          cell.to = lastOffset;
          cell.caretOffset = lastOffset;
        }
      }
    }
  }

  return pages;
}

export function pageIndexForOffset(
  pages: ManuscriptPage[],
  offset: number,
): number {
  const safeOffset = Math.max(0, offset);
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const cells = pages[pageIndex].cells;
    if (
      cells.some(
        (cell) =>
          (cell.filled && safeOffset >= cell.from && safeOffset < cell.to) ||
          (!cell.filled && cell.caretOffset === safeOffset),
      )
    ) {
      return pageIndex;
    }
  }
  return Math.max(0, pages.length - 1);
}

export function cellIndexForOffset(
  page: ManuscriptPage,
  offset: number,
): number {
  const exact = page.cells.findIndex(
    (cell) =>
      (cell.filled && offset >= cell.from && offset < cell.to) ||
      (!cell.filled && cell.caretOffset === offset),
  );
  if (exact >= 0) return exact;

  const following = page.cells.findIndex(
    (cell) => cell.filled && cell.from > offset,
  );
  if (following >= 0) return following;

  const lastFilled = page.cells.findLastIndex((cell) => cell.filled);
  return Math.max(0, lastFilled);
}
