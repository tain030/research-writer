export interface MarkdownPositionMap {
  documentSize: number;
  frontmatterLength: number;
  serializedPrefixLength: (position: number) => number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function documentPositionToMarkdownOffset(
  position: number,
  map: MarkdownPositionMap,
): number {
  const safePosition = clamp(position, 0, map.documentSize);
  return map.frontmatterLength + map.serializedPrefixLength(safePosition);
}

export function markdownOffsetToDocumentPosition(
  offset: number,
  map: MarkdownPositionMap,
): number {
  if (map.documentSize <= 0) return 0;
  const target = Math.max(0, offset - map.frontmatterLength);
  let low = 0;
  let high = map.documentSize;

  // Choose the first document position that reaches the Markdown offset.
  // Structural prefixes such as `## ` have no visual text position, so using
  // the last equal prefix would incorrectly cross into the following block.
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (map.serializedPrefixLength(middle) < target) low = middle + 1;
    else high = middle;
  }

  return clamp(low, 1, map.documentSize);
}
