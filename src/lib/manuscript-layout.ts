import {
  parseManuscript,
  type DiagnosticSeverity,
  type ManuscriptBlock,
  type ManuscriptBlockKind,
  type ManuscriptInline,
  type ManuscriptTextStyle,
  type ParsedManuscript,
} from "./manuscript-document";

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
  virtual?: boolean;
  compact?: boolean;
  style?: ManuscriptTextStyle;
  blockContinuation?: boolean;
  diagnosticIds?: string[];
  diagnosticSeverity?: DiagnosticSeverity;
}

export interface ManuscriptBlockPlacement {
  id: string;
  kind: ManuscriptBlockKind;
  label: string;
  detail: string;
  from: number;
  to: number;
  row: number;
  rows: number;
}

export interface ManuscriptPage {
  number: number;
  cells: ManuscriptCell[];
  blocks: ManuscriptBlockPlacement[];
}

export interface ManuscriptLayout {
  pages: ManuscriptPage[];
  document: ParsedManuscript;
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
    blocks: [],
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

interface ProjectedUnit {
  text: string;
  from: number;
  to: number;
  style: ManuscriptTextStyle;
  compact: boolean;
  virtual?: boolean;
  continuation?: boolean;
}

const cards = new Set<ManuscriptBlockKind>([
  "figure",
  "table",
  "math",
  "code",
  "footnote",
  "divider",
  "unsupported",
]);

const closingPunctuation = /^[,.!?;:、。，．？！’”」』】）》〉〕］）]$/u;
const openingPunctuation = /^[‘“「『【《〈〔［（]$/u;

export function layoutManuscript(
  value: string,
  fallbackTitle = "제목 없는 원고",
): ManuscriptLayout {
  const document = parseManuscript(value, fallbackTitle);
  const pages = [blankPage(1)];
  let pageIndex = 0;
  let row = 0;
  let column = 0;
  let lastOffset = document.bodyStart;

  const currentPage = () => pages[pageIndex];
  const ensurePage = () => {
    while (row >= MANUSCRIPT_ROWS) {
      pages.push(blankPage(pages.length + 1));
      pageIndex += 1;
      row -= MANUSCRIPT_ROWS;
    }
  };
  const directCell = (targetRow: number, targetColumn: number) =>
    currentPage().cells[targetRow * MANUSCRIPT_COLUMNS + targetColumn];
  const setDirect = (
    targetRow: number,
    targetColumn: number,
    unit: ProjectedUnit,
  ) => {
    const cell = directCell(targetRow, targetColumn);
    cell.text = unit.text;
    cell.from = unit.from;
    cell.to = unit.to;
    cell.caretOffset = unit.from;
    cell.filled = true;
    cell.virtual = unit.virtual;
    cell.compact = unit.compact;
    cell.style = unit.style;
    cell.tabContinuation = Boolean(unit.continuation);
    attachDiagnostics(cell, document);
  };
  const fillRowRemainder = (offset: number) => {
    if (column >= MANUSCRIPT_COLUMNS) return;
    for (let current = column; current < MANUSCRIPT_COLUMNS; current += 1) {
      const cell = directCell(row, current);
      if (!cell.filled && !cell.blockContinuation) {
        cell.from = offset;
        cell.to = offset;
        cell.caretOffset = offset;
      }
    }
  };
  const advanceRow = (offset: number, indent = 0) => {
    if (column < MANUSCRIPT_COLUMNS) fillRowRemainder(offset);
    row += 1;
    column = 0;
    ensurePage();
    for (let index = 0; index < indent; index += 1) {
      placeVirtual("", offset, "normal");
    }
  };
  const startBlockRow = (offset: number) => {
    if (column > 0 || column >= MANUSCRIPT_COLUMNS) {
      advanceRow(offset);
    }
    ensurePage();
  };
  const placeVirtual = (
    text: string,
    offset: number,
    style: ManuscriptTextStyle,
  ) => {
    if (column >= MANUSCRIPT_COLUMNS) advanceRow(offset);
    setDirect(row, column, {
      text,
      from: offset,
      to: offset,
      style,
      compact: text.length > 1,
      virtual: true,
    });
    column += 1;
  };
  const placeUnit = (unit: ProjectedUnit, block: ManuscriptBlock) => {
    if (column >= MANUSCRIPT_COLUMNS) {
      advanceRow(unit.from, block.continuationIndent);
    }
    if (openingPunctuation.test(unit.text) && column === MANUSCRIPT_COLUMNS - 1) {
      advanceRow(unit.from, block.continuationIndent);
    }
    if (closingPunctuation.test(unit.text) && column === 0) {
      const previous = previousFilledCell(pages, pageIndex, row);
      if (previous) {
        previous.text += unit.text;
        previous.to = Math.max(previous.to, unit.to);
        previous.compact = true;
        attachDiagnostics(previous, document);
        lastOffset = unit.to;
        return;
      }
    }
    setDirect(row, column, unit);
    column += 1;
    lastOffset = unit.to;
  };

  const headerEndRow = placeHeader(document, (targetRow, targetColumn, unit) => {
    setDirect(targetRow, targetColumn, unit);
  });
  for (let headerRow = 0; headerRow < headerEndRow; headerRow += 1) {
    for (let headerColumn = 0; headerColumn < MANUSCRIPT_COLUMNS; headerColumn += 1) {
      const cell = directCell(headerRow, headerColumn);
      if (cell.filled) continue;
      cell.from = document.bodyStart;
      cell.to = document.bodyStart;
      cell.caretOffset = document.bodyStart;
      cell.virtual = true;
    }
  }
  row = headerEndRow;
  column = 0;

  for (const block of document.blocks) {
    lastOffset = Math.max(lastOffset, block.from);
    if (cards.has(block.kind)) {
      startBlockRow(block.from);
      if (row > MANUSCRIPT_ROWS - 2) {
        row = MANUSCRIPT_ROWS;
        ensurePage();
      }
      const placement: ManuscriptBlockPlacement = {
        id: block.id,
        kind: block.kind,
        label: block.label,
        detail: block.detail,
        from: block.from,
        to: block.to,
        row,
        rows: 2,
      };
      currentPage().blocks.push(placement);
      for (let blockRow = row; blockRow < row + 2; blockRow += 1) {
        for (let blockColumn = 0; blockColumn < MANUSCRIPT_COLUMNS; blockColumn += 1) {
          const cell = directCell(blockRow, blockColumn);
          cell.from = block.from;
          cell.to = block.to;
          cell.caretOffset = block.from;
          cell.blockContinuation = true;
          attachDiagnostics(cell, document);
        }
      }
      row += 2;
      column = 0;
      ensurePage();
      lastOffset = Math.max(lastOffset, block.to);
      continue;
    }

    startBlockRow(block.from);
    for (let index = 0; index < block.indent; index += 1) {
      placeVirtual("", block.from, block.kind === "quote" ? "quote" : "normal");
    }
    if (block.marker) {
      placeVirtual(block.marker, block.from, "metadata");
      placeVirtual("", block.from, "normal");
    }
    const units = unitsForBlock(block);
    for (const unit of units) {
      if (unit.text === "\n") {
        advanceRow(unit.to, block.continuationIndent);
        lastOffset = unit.to;
        continue;
      }
      if (unit.text === "―") {
        placeUnit(unit, block);
        placeUnit({ ...unit, from: unit.to, virtual: true, continuation: true }, block);
        continue;
      }
      placeUnit(unit, block);
    }
    lastOffset = Math.max(lastOffset, block.to);
  }

  for (const page of pages) {
    for (const cell of page.cells) {
      if (
        !cell.filled &&
        !cell.blockContinuation &&
        cell.from === 0 &&
        cell.to === 0
      ) {
        cell.from = lastOffset;
        cell.to = lastOffset;
        cell.caretOffset = lastOffset;
      }
    }
  }

  return { pages, document };
}

function placeHeader(
  document: ParsedManuscript,
  place: (
    row: number,
    column: number,
    unit: ProjectedUnit,
  ) => void,
): number {
  const metadata = document.metadata;
  const source = document.metadataSource.range;
  const sourceLength = Math.max(1, source.to - source.from);
  let nextSource = source.from;
  const headerText = (
    text: string,
    targetRow: number,
    startColumn: number,
    style: ManuscriptTextStyle,
  ) => {
    let targetColumn = startColumn;
    for (const segment of segmentText(text)) {
      const from = Math.min(source.to, nextSource);
      const to = Math.min(source.to, from + Math.max(1, segment.length));
      place(targetRow, targetColumn, {
        text: segment,
        from,
        to,
        style,
        compact: false,
        virtual: document.metadataSource.kind !== "heading",
      });
      targetColumn += 1;
      nextSource = source.from + ((nextSource - source.from + segment.length) % sourceLength);
      if (targetColumn >= MANUSCRIPT_COLUMNS) break;
    }
  };
  const centered = (
    text: string,
    targetRow: number,
    style: ManuscriptTextStyle,
  ) => {
    const segments = segmentText(text).slice(0, MANUSCRIPT_COLUMNS);
    const start = Math.max(0, Math.floor((MANUSCRIPT_COLUMNS - segments.length) / 2));
    headerText(segments.join(""), targetRow, start, style);
  };
  const rightAligned = (
    text: string,
    targetRow: number,
    style: ManuscriptTextStyle,
  ) => {
    const segments = segmentText(text).slice(0, MANUSCRIPT_COLUMNS - 2);
    const start = Math.max(0, MANUSCRIPT_COLUMNS - 2 - segments.length);
    headerText(segments.join(""), targetRow, start, style);
  };

  if (metadata.genre) headerText(metadata.genre, 0, 1, "metadata");
  const titleSegments = segmentText(metadata.title || "제목 없는 원고");
  const titleLines: string[] = [];
  for (let index = 0; index < titleSegments.length; index += 18) {
    titleLines.push(titleSegments.slice(index, index + 18).join(""));
  }
  if (!titleLines.length) titleLines.push("제목 없는 원고");
  let targetRow = 1;
  for (const line of titleLines.slice(0, 2)) {
    centered(line, targetRow, "title");
    targetRow += 1;
  }
  if (metadata.subtitle) {
    centered(`― ${metadata.subtitle} ―`, targetRow, "subtitle");
    targetRow += 1;
  }
  if (metadata.affiliation) rightAligned(metadata.affiliation, targetRow, "metadata");
  targetRow += 1;
  if (metadata.author) rightAligned(metadata.author, targetRow, "metadata");
  targetRow += 2;
  return Math.min(MANUSCRIPT_ROWS - 1, Math.max(5, targetRow));
}

function unitsForBlock(block: ManuscriptBlock): ProjectedUnit[] {
  const raw: ProjectedUnit[] = [];
  for (const inline of block.inlines) {
    if (inline.atomic) {
      raw.push({
        text: inline.text,
        from: inline.from,
        to: inline.to,
        style: inline.style,
        compact: true,
      });
      continue;
    }
    let offset = inline.from;
    for (const segment of graphemes(inline.text)) {
      raw.push({
        text: segment.segment,
        from: offset,
        to: offset + segment.segment.length,
        style: inline.style,
        compact: false,
      });
      offset += segment.segment.length;
    }
  }

  const grouped: ProjectedUnit[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const current = raw[index];
    const next = raw[index + 1];
    if (
      next &&
      isHalfCellCharacter(current.text) &&
      isHalfCellCharacter(next.text) &&
      current.style === next.style &&
      current.to === next.from
    ) {
      grouped.push({
        text: `${current.text}${next.text}`,
        from: current.from,
        to: next.to,
        style: current.style,
        compact: true,
      });
      index += 1;
    } else {
      grouped.push(current);
    }
  }
  return grouped;
}

function attachDiagnostics(
  cell: ManuscriptCell,
  document: ParsedManuscript,
): void {
  const matches = document.diagnostics.filter((item) =>
    item.from === item.to
      ? cell.from <= item.from && cell.to >= item.to
      : cell.from < item.to && cell.to > item.from,
  );
  if (!matches.length) return;
  cell.diagnosticIds = matches.map((item) => item.id);
  cell.diagnosticSeverity = matches.some((item) => item.severity === "error")
    ? "error"
    : matches.some((item) => item.severity === "warning")
      ? "warning"
      : "suggestion";
}

function previousFilledCell(
  pages: ManuscriptPage[],
  pageIndex: number,
  row: number,
): ManuscriptCell | null {
  for (let currentPage = pageIndex; currentPage >= 0; currentPage -= 1) {
    const page = pages[currentPage];
    const lastIndex =
      currentPage === pageIndex
        ? Math.max(0, row * MANUSCRIPT_COLUMNS - 1)
        : page.cells.length - 1;
    for (let index = lastIndex; index >= 0; index -= 1) {
      const cell = page.cells[index];
      if (cell.filled && !cell.virtual) return cell;
    }
  }
  return null;
}

function isHalfCellCharacter(value: string): boolean {
  return /^[0-9a-z]$/u.test(value);
}

function segmentText(value: string): string[] {
  return graphemes(value).map((entry) => entry.segment);
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
      pages[pageIndex].blocks.some(
        (block) => safeOffset >= block.from && safeOffset <= block.to,
      ) ||
      cells.some(
        (cell) =>
          (cell.filled && safeOffset >= cell.from && safeOffset < cell.to) ||
          (!cell.filled &&
            !cell.virtual &&
            cell.caretOffset === safeOffset),
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
  const block = page.blocks.find(
    (item) => offset >= item.from && offset <= item.to,
  );
  if (block) return block.row * MANUSCRIPT_COLUMNS;

  const exact = page.cells.findIndex(
    (cell) =>
      (cell.filled && offset >= cell.from && offset < cell.to) ||
      (!cell.filled && !cell.virtual && cell.caretOffset === offset),
  );
  if (exact >= 0) return exact;

  const following = page.cells.findIndex(
    (cell) => cell.filled && cell.from > offset,
  );
  if (following >= 0) return following;

  const lastFilled = page.cells.findLastIndex((cell) => cell.filled);
  return Math.max(0, lastFilled);
}
