// @ts-expect-error Vitest provides Node built-ins; the production bundle does not import this file.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const editorSource = readFileSync(
  new URL("./Editor.svelte", import.meta.url),
  "utf8",
);

function styleBlock(selector: string): string {
  const selectorStart = editorSource.indexOf(selector);
  expect(selectorStart, `Missing ${selector}`).toBeGreaterThanOrEqual(0);
  const blockStart = editorSource.indexOf("{", selectorStart);
  const blockEnd = editorSource.indexOf("}", blockStart);
  return editorSource.slice(blockStart + 1, blockEnd);
}

describe("manuscript glyph rendering", () => {
  it("gives descenders vertical ink room without widening their cell", () => {
    const glyph = styleBlock(".cell-text,\n  .ghost-text");

    expect(glyph).toContain("width: calc(var(--cell-size) - 3px)");
    expect(glyph).toContain(
      "height: calc(var(--cell-size) + var(--row-gap) * 0.5)",
    );
    expect(glyph).toContain("overflow: hidden");
    expect(Number(glyph.match(/line-height:\s*([\d.]+)/)?.[1])).toBeGreaterThanOrEqual(
      1.2,
    );
  });

  it("keeps Markdown heading guidance out of print", () => {
    const printStyles = editorSource.slice(editorSource.indexOf("@media print"));

    expect(printStyles).toContain(".heading-guide");
    expect(printStyles).toContain(".heading-placeholder");
    expect(printStyles).toContain("display: none");
  });

  it("keeps paired Latin glyphs near the surrounding text size", () => {
    const pair = styleBlock(
      ".half-cell-pair .cell-text,\n  .half-cell-pair .ghost-text",
    );
    const glyph = styleBlock(".half-cell-glyph");

    expect(pair).toContain(
      "grid-template-columns: repeat(2, minmax(0, 1fr))",
    );
    expect(pair).toContain("font-size: 0.94em");
    expect(pair).toContain("letter-spacing: 0");
    expect(glyph).toContain("transform: scaleX(0.88)");
    expect(pair).not.toContain("var(--writing-font-size)");
  });

  it("classifies the text currently shown during optimistic rendering", () => {
    expect(editorSource).toContain(
      "{@const displayedText = optimistic || cell.text || ghost}",
    );
    expect(editorSource).toContain(
      "class:compact-cell={cell.compact && !halfCellPair}",
    );
    expect(editorSource).toContain("class:half-cell-pair={halfCellPair}");
  });
});
