import { describe, expect, it } from "vitest";
import { normalizePaperPageBreaks } from "./paper-pagination";

describe("paper pagination decorations", () => {
  it("sorts, deduplicates, and bounds page gaps", () => {
    expect(
      normalizePaperPageBreaks(
        [
          { pos: 20, restPx: 90 },
          { pos: 10, restPx: 80 },
          { pos: 20, restPx: 40 },
          { pos: 30, restPx: 100_000 },
          { pos: 40, restPx: Number.NaN },
          { pos: 0, restPx: 10 },
          { pos: 10.5, restPx: 10 },
        ],
        50,
      ),
    ).toEqual([
      { pos: 10, restPx: 80 },
      { pos: 20, restPx: 40 },
      { pos: 30, restPx: 297 * 96 / 25.4 },
    ]);
  });
});
