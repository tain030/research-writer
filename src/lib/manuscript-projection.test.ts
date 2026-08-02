import { describe, expect, it } from "vitest";
import { layoutManuscript, MANUSCRIPT_COLUMNS } from "./manuscript-layout";
import {
  contiguousEdit,
  projectManuscriptEdit,
  projectedPagesForRender,
} from "./manuscript-projection";

describe("optimistic manuscript projection", () => {
  it("finds one contiguous edit without parsing Markdown", () => {
    expect(contiguousEdit("앞 문장 뒤", "앞 새 문장 뒤")).toEqual({
      from: 2,
      deletedTo: 2,
      inserted: "새 ",
    });
    expect(contiguousEdit("같음", "같음")).toBeNull();
  });

  it("projects appended Korean and half-cell Latin text", () => {
    const source = "# 제목\n\n문장";
    const layout = layoutManuscript(source);
    const next = `${source}ab한`;
    const projection = projectManuscriptEdit(
      layout,
      source,
      next,
      next.length,
    )!;

    expect(Object.values(projection.cells)).toEqual(["ab", "한"]);
    expect(projection.caretOffset).toBe(next.length);
  });

  it("moves an Enter paragraph caret to the indented next row", () => {
    const source = "# 제목\n\n문장";
    const layout = layoutManuscript(source);
    const projection = projectManuscriptEdit(
      layout,
      source,
      `${source}\n\n`,
      source.length + 2,
    )!;

    expect(projection.caret.cellIndex % MANUSCRIPT_COLUMNS).toBe(1);
  });

  it("projects an appended character onto a new page after a full sheet", () => {
    const source = "가".repeat(299);
    const layout = layoutManuscript(source);
    const projection = projectManuscriptEdit(
      layout,
      source,
      `${source}나`,
      source.length + 1,
    )!;

    expect(projection.cells[400]).toBe("나");
    expect(projection.cells[399]).toBeUndefined();
    expect(projection.caret.pageIndex).toBe(1);
    expect(projection.caret.cellIndex).toBe(1);
    const rendered = projectedPagesForRender(layout.pages, projection);
    expect(rendered).toHaveLength(2);
    expect(rendered[1].cells).toHaveLength(400);
    expect(rendered[1].number).toBe(2);
  });

  it("keeps the caret on the last cell when an edit only fills that sheet", () => {
    const source = "가".repeat(298);
    const layout = layoutManuscript(source);
    const projection = projectManuscriptEdit(
      layout,
      source,
      `${source}나`,
      source.length + 1,
    )!;

    expect(projection.cells[399]).toBe("나");
    expect(projection.caret).toMatchObject({
      pageIndex: 0,
      cellIndex: 399,
      slot: 1,
    });
    expect(projectedPagesForRender(layout.pages, projection)).toHaveLength(1);
  });
});
