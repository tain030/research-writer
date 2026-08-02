import { describe, expect, it } from "vitest";
import { layoutManuscript, MANUSCRIPT_COLUMNS } from "./manuscript-layout";
import { contiguousEdit, projectManuscriptEdit } from "./manuscript-projection";

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
});
