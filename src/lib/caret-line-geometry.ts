export interface RectLike {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width?: number;
  height?: number;
}

export type WritingBlockKind =
  | "heading"
  | "paragraph"
  | "list-item"
  | "blockquote"
  | "code"
  | "table-cell"
  | "other";

export interface CaretLineGeometry {
  pageIndex: number;
  top: number;
  height: number;
  fontSize: number;
  caretLeft: number;
  lineLeft: number;
  lineWidth: number;
  bodyLeft: number;
  bodyWidth: number;
  blockKind: WritingBlockKind;
}

interface ResolveCaretLineGeometryOptions {
  caret: RectLike;
  lineRects: RectLike[];
  stack: Pick<RectLike, "top" | "left">;
  scale: number;
  pageWidth: number;
  pageHeight: number;
  pageGap: number;
  pageTopInset: number;
  pageBottomInset: number;
  pageHorizontalInset: number;
  fontSize: number;
  blockKind: WritingBlockKind;
}

function rectWidth(rect: RectLike): number {
  return rect.width ?? rect.right - rect.left;
}

function rectHeight(rect: RectLike): number {
  return rect.height ?? rect.bottom - rect.top;
}

function distanceFromInterval(value: number, start: number, end: number): number {
  if (value < start) return start - value;
  if (value > end) return value - end;
  return 0;
}

function nearestLineRect(caret: RectLike, rects: RectLike[]): RectLike | null {
  const valid = rects.filter(
    (rect) =>
      Number.isFinite(rect.top) &&
      Number.isFinite(rect.left) &&
      rectHeight(rect) > 0 &&
      rectWidth(rect) >= 0,
  );
  if (!valid.length) return null;
  const caretY = (caret.top + caret.bottom) / 2;
  const caretX = (caret.left + caret.right) / 2;
  return valid.reduce((nearest, rect) => {
    const nearestScore =
      distanceFromInterval(caretY, nearest.top, nearest.bottom) * 10 +
      distanceFromInterval(caretX, nearest.left, nearest.right);
    const score =
      distanceFromInterval(caretY, rect.top, rect.bottom) * 10 +
      distanceFromInterval(caretX, rect.left, rect.right);
    return score < nearestScore ? rect : nearest;
  });
}

export function resolveCaretLineGeometry(
  options: ResolveCaretLineGeometryOptions,
): CaretLineGeometry | null {
  const {
    caret,
    lineRects,
    stack,
    pageWidth,
    pageHeight,
    pageGap,
    pageTopInset,
    pageBottomInset,
    pageHorizontalInset,
    fontSize,
    blockKind,
  } = options;
  const scale = options.scale;
  if (!Number.isFinite(scale) || scale <= 0) return null;

  const caretTop = (caret.top - stack.top) / scale;
  const caretBottom = (caret.bottom - stack.top) / scale;
  const caretCenter = (caretTop + caretBottom) / 2;
  if (!Number.isFinite(caretCenter)) return null;

  const pagePeriod = pageHeight + pageGap;
  const pageIndex = Math.max(0, Math.floor(caretCenter / pagePeriod));
  const pageOffset = pageIndex * pagePeriod;
  const withinPage = caretCenter - pageOffset;
  if (withinPage < 0 || withinPage > pageHeight) return null;

  const line = nearestLineRect(caret, lineRects) ?? caret;
  const naturalTop = (line.top - stack.top) / scale;
  const naturalBottom = (line.bottom - stack.top) / scale;
  const bodyTop = pageOffset + pageTopInset;
  const bodyBottom = pageOffset + pageHeight - pageBottomInset;
  const top = Math.max(bodyTop, naturalTop);
  const bottom = Math.min(bodyBottom, Math.max(naturalBottom, top + 1));
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) {
    return null;
  }

  const bodyLeft = pageHorizontalInset;
  const bodyRight = pageWidth - pageHorizontalInset;
  const naturalLeft = (line.left - stack.left) / scale;
  const naturalRight = (line.right - stack.left) / scale;
  const lineLeft = Math.max(bodyLeft, Math.min(bodyRight, naturalLeft));
  const lineRight = Math.max(lineLeft, Math.min(bodyRight, naturalRight));

  return {
    pageIndex,
    top,
    height: bottom - top,
    fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 14,
    caretLeft: (caret.left - stack.left) / scale,
    lineLeft,
    lineWidth: Math.max(1, lineRight - lineLeft),
    bodyLeft,
    bodyWidth: bodyRight - bodyLeft,
    blockKind,
  };
}
