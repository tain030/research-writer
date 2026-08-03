import {
  caretPlacementForOffset,
  MANUSCRIPT_CELLS_PER_PAGE,
  MANUSCRIPT_COLUMNS,
  type ManuscriptCell,
  type ManuscriptCaretPlacement,
  type ManuscriptLayout,
  type ManuscriptPage,
} from "./manuscript-layout";
import {
  isHalfCellCharacter,
  manuscriptGraphemes,
} from "./manuscript-characters";

export interface ManuscriptOptimisticProjection {
  cells: Record<number, string>;
  caret: ManuscriptCaretPlacement;
  caretOffset: number;
  deletedFrom: number;
  deletedTo: number;
}

interface ContiguousEdit {
  from: number;
  deletedTo: number;
  inserted: string;
}

export function contiguousEdit(
  previous: string,
  next: string,
): ContiguousEdit | null {
  if (previous === next) return null;
  const shortest = Math.min(previous.length, next.length);
  let from = 0;
  while (from < shortest && previous.charCodeAt(from) === next.charCodeAt(from)) {
    from += 1;
  }
  let suffix = 0;
  while (
    suffix < shortest - from &&
    previous.charCodeAt(previous.length - suffix - 1) ===
      next.charCodeAt(next.length - suffix - 1)
  ) {
    suffix += 1;
  }
  return {
    from,
    deletedTo: previous.length - suffix,
    inserted: next.slice(from, next.length - suffix),
  };
}

export function projectManuscriptEdit(
  layout: ManuscriptLayout,
  layoutSource: string,
  nextSource: string,
  caretOffset: number,
  maxCells = 1_200,
): ManuscriptOptimisticProjection | null {
  const edit = contiguousEdit(layoutSource, nextSource);
  if (!edit) return null;
  const start = caretPlacementForOffset(layout, edit.from, "forward");
  let absoluteCell =
    start.pageIndex * MANUSCRIPT_CELLS_PER_PAGE + start.cellIndex;
  const startCell = layout.pages[start.pageIndex]?.cells[start.cellIndex];
  if (
    startCell?.filled &&
    !startCell.virtual &&
    !startCell.blockContinuation &&
    start.slot >= start.slotCount
  ) {
    absoluteCell += 1;
  }
  const cells: Record<number, string> = {};
  let cellsUsed = 0;
  let lineBreakRun = 0;
  let pendingHalfCell = false;

  const advanceCell = () => {
    absoluteCell += 1;
    pendingHalfCell = false;
  };
  const nextRow = (indent = 0) => {
    const row = Math.floor(absoluteCell / MANUSCRIPT_COLUMNS);
    absoluteCell = (row + 1) * MANUSCRIPT_COLUMNS + indent;
    pendingHalfCell = false;
  };

  for (const segment of manuscriptGraphemes(edit.inserted)) {
    if (segment === "\n") {
      lineBreakRun += 1;
      if (lineBreakRun === 1) nextRow();
      else if (lineBreakRun === 2) absoluteCell += 1;
      else nextRow(1);
      continue;
    }
    lineBreakRun = 0;
    if (cellsUsed >= maxCells) break;
    if (isHalfCellCharacter(segment)) {
      if (pendingHalfCell) {
        cells[absoluteCell] = `${cells[absoluteCell] ?? ""}${segment}`;
        advanceCell();
      } else {
        cells[absoluteCell] = segment;
        pendingHalfCell = true;
      }
    } else {
      if (pendingHalfCell) advanceCell();
      cells[absoluteCell] = segment;
      advanceCell();
    }
    cellsUsed += 1;
    if (absoluteCell % MANUSCRIPT_COLUMNS === 0) pendingHalfCell = false;
  }
  if (pendingHalfCell) advanceCell();

  let safeAbsolute = Math.max(0, absoluteCell);
  let caretSlot = 0;
  if (
    safeAbsolute > 0 &&
    safeAbsolute % MANUSCRIPT_CELLS_PER_PAGE === 0 &&
    !edit.inserted.includes("\n")
  ) {
    safeAbsolute -= 1;
    caretSlot = 1;
  }
  return {
    cells,
    caret: {
      pageIndex: Math.floor(safeAbsolute / MANUSCRIPT_CELLS_PER_PAGE),
      cellIndex: safeAbsolute % MANUSCRIPT_CELLS_PER_PAGE,
      slot: caretSlot,
      slotCount: 1,
    },
    caretOffset,
    deletedFrom: edit.from,
    deletedTo: edit.deletedTo,
  };
}

export function projectedPagesForRender(
  canonical: ManuscriptPage[],
  projection: ManuscriptOptimisticProjection | null,
): ManuscriptPage[] {
  if (!projection || projection.caret.pageIndex < canonical.length) {
    return canonical;
  }
  const result = [...canonical];
  const caretOffset = projection.caretOffset;
  while (result.length <= projection.caret.pageIndex) {
    result.push({
      number: result.length + 1,
      blocks: [],
      headingGuides: [],
      endOffset: caretOffset,
      cells: Array.from(
        { length: MANUSCRIPT_CELLS_PER_PAGE },
        (_, index): ManuscriptCell => ({
          index,
          row: Math.floor(index / MANUSCRIPT_COLUMNS),
          column: index % MANUSCRIPT_COLUMNS,
          text: "",
          from: caretOffset,
          to: caretOffset,
          caretOffset,
          filled: false,
          tabContinuation: false,
        }),
      ),
    });
  }
  return result;
}
