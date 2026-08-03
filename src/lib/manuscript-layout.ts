import {
  parseManuscript,
  type ManuscriptBlock,
  type ManuscriptBlockKind,
  type ManuscriptHeadingLevel,
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
  caretStops?: number[];
}

export type ManuscriptCaretAffinity = "forward" | "backward";

export interface ManuscriptCaretPlacement {
  pageIndex: number;
  cellIndex: number;
  slot: number;
  slotCount: number;
}

export interface ManuscriptCaretBoundary {
  forward: ManuscriptCaretPlacement;
  backward: ManuscriptCaretPlacement;
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

export interface ManuscriptHeadingGuide {
  from: number;
  to: number;
  row: number;
  level: ManuscriptHeadingLevel;
  empty: boolean;
  documentTitle: boolean;
}

export interface ManuscriptPage {
  number: number;
  cells: ManuscriptCell[];
  blocks: ManuscriptBlockPlacement[];
  headingGuides: ManuscriptHeadingGuide[];
  endOffset: number;
}

export interface ManuscriptLayout {
  pages: ManuscriptPage[];
  document: ParsedManuscript;
  carets: ManuscriptCaretBoundary[];
}

interface Grapheme {
  segment: string;
  index: number;
}

const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("ko", { granularity: "grapheme" })
    : null;

function* graphemes(value: string): Iterable<Grapheme> {
  if (graphemeSegmenter) {
    for (const entry of graphemeSegmenter.segment(value)) {
      yield { segment: entry.segment, index: entry.index };
    }
    return;
  }

  let index = 0;
  for (const segment of Array.from(value)) {
    yield { segment, index };
    index += segment.length;
  }
}

function blankPage(number: number): ManuscriptPage {
  return {
    number,
    blocks: [],
    headingGuides: [],
    endOffset: 0,
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
  stops?: number[];
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
  const document = parseManuscript(value, fallbackTitle, { diagnostics: false });
  const pages = [blankPage(1)];
  let pageIndex = 0;
  let row = 0;
  let column = 0;
  let lastOffset = document.bodyStart;
  const forwardCarets: Array<ManuscriptCaretPlacement | undefined> =
    Array.from({ length: value.length + 1 });
  const backwardCarets: Array<ManuscriptCaretPlacement | undefined> =
    Array.from({ length: value.length + 1 });

  const currentPage = () => pages[pageIndex];
  const placement = (
    targetPage: number,
    targetRow: number,
    targetColumn: number,
    slot = 0,
    slotCount = 1,
  ): ManuscriptCaretPlacement => ({
    pageIndex: Math.max(0, Math.min(targetPage, pages.length - 1)),
    cellIndex:
      Math.max(0, Math.min(targetRow, MANUSCRIPT_ROWS - 1)) *
        MANUSCRIPT_COLUMNS +
      Math.max(0, Math.min(targetColumn, MANUSCRIPT_COLUMNS - 1)),
    slot: Math.max(0, Math.min(slot, slotCount)),
    slotCount: Math.max(1, slotCount),
  });
  const currentPlacement = (): ManuscriptCaretPlacement => {
    if (column < MANUSCRIPT_COLUMNS) {
      return placement(pageIndex, row, column);
    }
    if (row < MANUSCRIPT_ROWS - 1) {
      return placement(pageIndex, row + 1, 0);
    }
    return placement(pageIndex, row, MANUSCRIPT_COLUMNS - 1, 1, 1);
  };
  const recordForward = (
    offset: number,
    target: ManuscriptCaretPlacement,
  ) => {
    const safeOffset = Math.max(0, Math.min(offset, value.length));
    forwardCarets[safeOffset] = target;
  };
  const recordBackward = (
    offset: number,
    target: ManuscriptCaretPlacement,
  ) => {
    const safeOffset = Math.max(0, Math.min(offset, value.length));
    backwardCarets[safeOffset] = target;
  };
  const recordCollapsed = (
    offset: number,
    target = currentPlacement(),
  ) => {
    recordForward(offset, target);
    recordBackward(offset, target);
  };
  const mapCellStops = (
    targetPage: number,
    cell: ManuscriptCell,
  ) => {
    const stops = cell.caretStops;
    if (!stops?.length) return;
    const slotCount = Math.max(1, stops.length - 1);
    for (let slot = 0; slot < stops.length; slot += 1) {
      const target = placement(
        targetPage,
        cell.row,
        cell.column,
        slot,
        slotCount,
      );
      if (slot > 0) recordBackward(stops[slot], target);
      if (slot < stops.length - 1) recordForward(stops[slot], target);
      if (slot > 0 && slot < stops.length - 1) {
        recordForward(stops[slot], target);
        recordBackward(stops[slot], target);
      }
    }
  };
  const ensurePage = (offset = lastOffset) => {
    while (row >= MANUSCRIPT_ROWS) {
      finalizePage(currentPage(), offset);
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
    cell.caretStops =
      unit.stops ??
      (!unit.virtual && unit.to > unit.from ? [unit.from, unit.to] : undefined);
    mapCellStops(pageIndex, cell);
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
    ensurePage(offset);
    for (let index = 0; index < indent; index += 1) {
      placeVirtual("", offset, "normal");
    }
    recordCollapsed(offset);
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
        previous.cell.text += unit.text;
        previous.cell.to = Math.max(previous.cell.to, unit.to);
        previous.cell.compact = true;
        previous.cell.caretStops = Array.from(
          new Set([
            ...(previous.cell.caretStops ?? [previous.cell.from]),
            unit.from,
            unit.to,
          ]),
        ).sort((left, right) => left - right);
        mapCellStops(previous.pageIndex, previous.cell);
        recordForward(unit.to, currentPlacement());
        lastOffset = unit.to;
        return;
      }
    }
    setDirect(row, column, unit);
    column += 1;
    recordForward(unit.to, currentPlacement());
    lastOffset = unit.to;
  };

  const header = placeHeader(document, value, (targetRow, targetColumn, unit) => {
    setDirect(targetRow, targetColumn, unit);
  });
  const headerEndRow = header.endRow;
  if (header.headingGuide) currentPage().headingGuides.push(header.headingGuide);
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

  if (!document.blocks.length) {
    placeVirtual("", document.bodyStart, "normal");
    recordCollapsed(document.bodyStart);
  }

  let previousBlockTo = document.bodyStart;
  for (const block of document.blocks) {
    lastOffset = Math.max(lastOffset, block.from);
    if (cards.has(block.kind)) {
      placeInterBlockGap(previousBlockTo, block.from, false);
      startBlockRow(block.from);
      if (row > MANUSCRIPT_ROWS - 2) {
        row = MANUSCRIPT_ROWS;
        ensurePage(block.from);
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
      const blockCaret = placementAtBlock(pageIndex, row);
      recordForward(block.from, blockCaret);
      recordBackward(block.to, blockCaret);
      for (let blockRow = row; blockRow < row + 2; blockRow += 1) {
        for (let blockColumn = 0; blockColumn < MANUSCRIPT_COLUMNS; blockColumn += 1) {
          const cell = directCell(blockRow, blockColumn);
          cell.from = block.from;
          cell.to = block.to;
          cell.caretOffset = block.from;
          cell.blockContinuation = true;
        }
      }
      row += 2;
      column = 0;
      ensurePage(block.to);
      lastOffset = Math.max(lastOffset, block.to);
      previousBlockTo = block.to;
      continue;
    }

    placeInterBlockGap(previousBlockTo, block.from, block.indent > 0);
    startBlockRow(block.from);
    if (block.kind === "heading") {
      currentPage().headingGuides.push({
        from: block.from,
        to: block.to,
        row,
        level: block.headingLevel ?? 2,
        empty: block.detail.trim().length === 0,
        documentTitle: false,
      });
    }
    for (let index = 0; index < block.indent; index += 1) {
      placeVirtual("", block.from, block.kind === "quote" ? "quote" : "normal");
    }
    if (block.marker) {
      placeVirtual(block.marker, block.from, "metadata");
      placeVirtual("", block.from, "normal");
    }
    recordForward(block.from, currentPlacement());
    const units = unitsForBlock(block);
    for (const unit of units) {
      if (unit.text === "\n") {
        advanceRow(unit.to, block.continuationIndent);
        lastOffset = unit.to;
        continue;
      }
      if (unit.text === "―") {
        placeUnit(unit, block);
        placeUnit(
          {
            ...unit,
            from: unit.to,
            virtual: true,
            continuation: true,
            stops: undefined,
          },
          block,
        );
        continue;
      }
      placeUnit(unit, block);
    }
    lastOffset = Math.max(lastOffset, block.to);
    recordForward(block.to, currentPlacement());
    previousBlockTo = block.to;
  }

  placeTrailingLineBreaks(previousBlockTo);

  if (header.headingGuide?.empty) {
    const emptyTitleCaret = placement(
      0,
      header.headingGuide.row,
      Math.floor((MANUSCRIPT_COLUMNS - 1) / 2),
    );
    for (
      let offset = header.headingGuide.from;
      offset <= header.headingGuide.to;
      offset += 1
    ) {
      recordCollapsed(offset, emptyTitleCaret);
    }
  }

  finalizePage(currentPage(), lastOffset);

  const carets = completeCaretMap(
    value.length,
    forwardCarets,
    backwardCarets,
    currentPlacement(),
  );
  return { pages, document, carets };

  function placementAtBlock(
    targetPage: number,
    targetRow: number,
  ): ManuscriptCaretPlacement {
    return placement(targetPage, targetRow, 0);
  }

  function placeInterBlockGap(
    from: number,
    to: number,
    indentEmptyRows: boolean,
  ): void {
    const lineBreakOffsets: number[] = [];
    for (let offset = Math.max(document.bodyStart, from); offset < to; offset += 1) {
      if (value[offset] === "\n") lineBreakOffsets.push(offset + 1);
    }
    for (let index = 0; index < lineBreakOffsets.length; index += 1) {
      const caretOffset = lineBreakOffsets[index];
      if (index === 0) {
        if (column > 0 || column >= MANUSCRIPT_COLUMNS) {
          advanceRow(caretOffset);
        } else {
          recordCollapsed(caretOffset);
        }
        continue;
      }
      if (index >= 2) advanceRow(caretOffset);
      const isLast = index === lineBreakOffsets.length - 1;
      if (!isLast && indentEmptyRows && column === 0) {
        placeVirtual("", caretOffset, "normal");
      }
      recordCollapsed(caretOffset);
    }
  }

  function placeTrailingLineBreaks(from: number): void {
    let lineBreaks = 0;
    for (let offset = Math.max(document.bodyStart, from); offset < value.length; offset += 1) {
      if (value[offset] !== "\n") continue;
      lineBreaks += 1;
      const caretOffset = offset + 1;
      if (lineBreaks === 1) {
        advanceRow(caretOffset);
      } else if (lineBreaks === 2) {
        if (column === 0) placeVirtual("", caretOffset, "normal");
        recordCollapsed(caretOffset);
      } else {
        advanceRow(caretOffset, 1);
      }
      lastOffset = caretOffset;
    }
  }
}

function finalizePage(page: ManuscriptPage, offset: number): void {
  let endOffset = Math.max(
    offset,
    ...page.blocks.map((block) => block.to),
  );
  for (const cell of page.cells) {
    if (
      !cell.filled &&
      !cell.blockContinuation &&
      cell.from === 0 &&
      cell.to === 0
    ) {
      cell.from = offset;
      cell.to = offset;
      cell.caretOffset = offset;
    }
    endOffset = Math.max(endOffset, cell.to, cell.caretOffset);
  }
  page.endOffset = endOffset;
}

function completeCaretMap(
  length: number,
  forward: Array<ManuscriptCaretPlacement | undefined>,
  backward: Array<ManuscriptCaretPlacement | undefined>,
  fallback: ManuscriptCaretPlacement,
): ManuscriptCaretBoundary[] {
  const nextForward: Array<ManuscriptCaretPlacement | undefined> =
    Array.from({ length: length + 1 });
  const previousBackward: Array<ManuscriptCaretPlacement | undefined> =
    Array.from({ length: length + 1 });
  let next: ManuscriptCaretPlacement | undefined;
  for (let offset = length; offset >= 0; offset -= 1) {
    if (forward[offset]) next = forward[offset];
    nextForward[offset] = next;
  }
  let previous: ManuscriptCaretPlacement | undefined;
  for (let offset = 0; offset <= length; offset += 1) {
    if (backward[offset]) previous = backward[offset];
    previousBackward[offset] = previous;
  }

  return Array.from({ length: length + 1 }, (_, offset) => ({
    forward:
      forward[offset] ??
      nextForward[offset] ??
      previousBackward[offset] ??
      fallback,
    backward:
      backward[offset] ??
      previousBackward[offset] ??
      nextForward[offset] ??
      fallback,
  }));
}

export function caretPlacementForOffset(
  layout: ManuscriptLayout,
  offset: number,
  affinity: ManuscriptCaretAffinity = "forward",
): ManuscriptCaretPlacement {
  const safeOffset = Math.max(0, Math.min(offset, layout.carets.length - 1));
  return layout.carets[safeOffset]?.[affinity] ?? {
    pageIndex: 0,
    cellIndex: 0,
    slot: 0,
    slotCount: 1,
  };
}

export function sameCaretPlacement(
  left: ManuscriptCaretPlacement,
  right: ManuscriptCaretPlacement,
): boolean {
  return (
    left.pageIndex === right.pageIndex &&
    left.cellIndex === right.cellIndex &&
    left.slot === right.slot &&
    left.slotCount === right.slotCount
  );
}

interface HeaderLayout {
  endRow: number;
  headingGuide?: ManuscriptHeadingGuide;
}

function placeHeader(
  document: ParsedManuscript,
  sourceValue: string,
  place: (
    row: number,
    column: number,
    unit: ProjectedUnit,
  ) => void,
): HeaderLayout {
  const metadata = document.metadata;
  const source = document.metadataSource.range;
  const virtual = document.metadataSource.kind !== "heading";
  const placeUnits = (
    units: ProjectedUnit[],
    targetRow: number,
    startColumn: number,
  ) => {
    let targetColumn = startColumn;
    for (const unit of units) {
      place(targetRow, targetColumn, unit);
      targetColumn += 1;
      if (targetColumn >= MANUSCRIPT_COLUMNS) break;
    }
  };
  const centered = (
    units: ProjectedUnit[],
    targetRow: number,
  ) => {
    const visible = units.slice(0, MANUSCRIPT_COLUMNS);
    const start = Math.max(
      0,
      Math.floor((MANUSCRIPT_COLUMNS - visible.length) / 2),
    );
    placeUnits(visible, targetRow, start);
  };
  const rightAligned = (
    text: string,
    targetRow: number,
    style: ManuscriptTextStyle,
  ) => {
    const units = projectedUnitsForText(text, style, source, true).slice(
      0,
      MANUSCRIPT_COLUMNS - 2,
    );
    const start = Math.max(0, MANUSCRIPT_COLUMNS - 2 - units.length);
    placeUnits(units, targetRow, start);
  };

  if (metadata.genre) {
    placeUnits(
      projectedUnitsForText(metadata.genre, "metadata", source, true).slice(
        0,
        MANUSCRIPT_COLUMNS - 1,
      ),
      0,
      1,
    );
  }

  const headingSource = document.titleHeadingRange
    ? sourceValue.slice(
        document.titleHeadingRange.from,
        document.titleHeadingRange.to,
      )
    : "";
  const emptyHeading =
    document.metadataSource.kind === "heading" &&
    /^#{1,6}(?:[ \t]+#+)?[ \t]*$/u.test(headingSource);
  const titleText = emptyHeading
    ? ""
    : metadata.title || "제목 없는 원고";
  const titleSource =
    document.metadataSource.kind === "heading" && document.titleTextRange
      ? document.titleTextRange
      : source;
  const titleUnits = projectedUnitsForText(
    titleText,
    "title",
    titleSource,
    virtual,
  );
  const titleLines: ProjectedUnit[][] = [];
  for (let index = 0; index < titleUnits.length; index += 18) {
    titleLines.push(titleUnits.slice(index, index + 18));
  }
  if (!titleLines.length) titleLines.push([]);
  let targetRow = 1;
  for (const line of titleLines.slice(0, 2)) {
    centered(line, targetRow);
    targetRow += 1;
  }
  if (metadata.subtitle) {
    centered(
      projectedUnitsForText(
        `― ${metadata.subtitle} ―`,
        "subtitle",
        source,
        true,
      ),
      targetRow,
    );
    targetRow += 1;
  }
  if (metadata.affiliation) rightAligned(metadata.affiliation, targetRow, "metadata");
  targetRow += 1;
  if (metadata.author) rightAligned(metadata.author, targetRow, "metadata");
  targetRow += 2;
  return {
    endRow: Math.min(MANUSCRIPT_ROWS - 1, Math.max(5, targetRow)),
    headingGuide:
      document.metadataSource.kind === "heading" && document.titleHeadingRange
        ? {
            from: document.titleHeadingRange.from,
            to: document.titleHeadingRange.to,
            row: 1,
            level: 1,
            empty: emptyHeading,
            documentTitle: true,
          }
        : undefined,
  };
}

function unitsForBlock(block: ManuscriptBlock): ProjectedUnit[] {
  const grouped: ProjectedUnit[] = [];

  for (const inline of block.inlines) {
    if (inline.atomic) {
      appendProjectedUnit(grouped, {
        text: inline.text,
        from: inline.from,
        to: inline.to,
        style: inline.style,
        compact: true,
        stops: [inline.from, inline.to],
      });
      continue;
    }
    let offset = inline.from;
    for (const segment of graphemes(inline.text)) {
      appendProjectedUnit(grouped, {
        text: segment.segment,
        from: offset,
        to: offset + segment.segment.length,
        style: inline.style,
        compact: false,
        stops: [offset, offset + segment.segment.length],
      });
      offset += segment.segment.length;
    }
  }
  return grouped;
}

function projectedUnitsForText(
  text: string,
  style: ManuscriptTextStyle,
  source: { from: number; to: number },
  virtual: boolean,
): ProjectedUnit[] {
  const units: ProjectedUnit[] = [];
  let offset = source.from;
  for (const segment of graphemes(text)) {
    const from = Math.min(source.to, offset);
    const to = Math.min(source.to, from + segment.segment.length);
    appendProjectedUnit(units, {
      text: segment.segment,
      from,
      to,
      style,
      compact: false,
      virtual,
      stops: virtual ? undefined : [from, to],
    });
    offset += segment.segment.length;
  }
  return units;
}

function appendProjectedUnit(
  units: ProjectedUnit[],
  unit: ProjectedUnit,
): void {
  const previous = units.at(-1);
  if (
    previous &&
    isHalfCellCharacter(previous.text) &&
    isHalfCellCharacter(unit.text) &&
    previous.style === unit.style &&
    (previous.to === unit.from || (previous.virtual && unit.virtual))
  ) {
    units[units.length - 1] = {
      text: `${previous.text}${unit.text}`,
      from: previous.from,
      to: unit.to,
      style: previous.style,
      compact: true,
      virtual: previous.virtual && unit.virtual,
      stops:
        previous.virtual && unit.virtual
          ? undefined
          : Array.from(
              new Set([
                ...(previous.stops ?? [previous.from, previous.to]),
                unit.to,
              ]),
            ).sort((left, right) => left - right),
    };
    return;
  }
  units.push(unit);
}

function previousFilledCell(
  pages: ManuscriptPage[],
  pageIndex: number,
  row: number,
): { pageIndex: number; cell: ManuscriptCell } | null {
  for (let currentPage = pageIndex; currentPage >= 0; currentPage -= 1) {
    const page = pages[currentPage];
    const lastIndex =
      currentPage === pageIndex
        ? Math.max(0, row * MANUSCRIPT_COLUMNS - 1)
        : page.cells.length - 1;
    for (let index = lastIndex; index >= 0; index -= 1) {
      const cell = page.cells[index];
      if (cell.filled && !cell.virtual) {
        return { pageIndex: currentPage, cell };
      }
    }
  }
  return null;
}

function isHalfCellCharacter(value: string): boolean {
  return /^[0-9a-z]$/u.test(value);
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

  for (const page of pages) {
    page.endOffset = page.cells.reduce(
      (end, cell) => Math.max(end, cell.to, cell.caretOffset),
      0,
    );
  }

  return pages;
}

export function pageIndexForOffset(
  pages: ManuscriptPage[],
  offset: number,
): number {
  const safeOffset = Math.max(0, offset);
  let low = 0;
  let high = pages.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (safeOffset < pages[middle].endOffset) high = middle;
    else low = middle + 1;
  }
  return Math.max(0, low);
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
