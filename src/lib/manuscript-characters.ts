const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("ko", { granularity: "grapheme" })
    : null;

export function manuscriptGraphemes(value: string): string[] {
  if (graphemeSegmenter) {
    return Array.from(
      graphemeSegmenter.segment(value),
      (entry) => entry.segment,
    );
  }
  return Array.from(value);
}

export function isHalfCellCharacter(value: string): boolean {
  return /^[0-9a-z]$/u.test(value);
}

export function isHalfCellPair(value: string): boolean {
  return /^[0-9a-z]{2}$/u.test(value);
}

export function packHalfCellText(value: string): string[] {
  const cells: string[] = [];

  for (const grapheme of manuscriptGraphemes(value)) {
    const previous = cells.at(-1);
    if (
      previous &&
      isHalfCellCharacter(previous) &&
      isHalfCellCharacter(grapheme)
    ) {
      cells[cells.length - 1] = `${previous}${grapheme}`;
      continue;
    }
    cells.push(grapheme);
  }

  return cells;
}
