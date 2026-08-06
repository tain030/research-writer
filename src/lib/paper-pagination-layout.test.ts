import { describe, expect, it } from "vitest";
import {
  planPaperPageBreaks,
  resolvePageBlockGeometry,
  type MeasuredPageBlock,
} from "./paper-pagination-layout";

const metrics = { body: 100, top: 10, bottom: 10, epsilon: 0.1 };

function block(
  input: Partial<MeasuredPageBlock> &
    Pick<MeasuredPageBlock, "pos" | "contentHeight">,
): MeasuredPageBlock {
  return {
    kind: "atomic",
    afterGap: 0,
    leadHeight: input.contentHeight,
    opportunities: [],
    ...input,
  };
}

describe("paper pagination layout", () => {
  it("separates the final visual line from trailing paragraph space", () => {
    expect(
      resolvePageBlockGeometry({
        boxHeight: 94,
        visualContentHeight: 90,
        nextBlockOffset: 105,
      }),
    ).toEqual({ contentHeight: 90, afterGap: 15 });
  });

  it("keeps a heading with only the opening lines of a long paragraph", () => {
    const breaks = planPaperPageBreaks(
      [
        block({ pos: 0, contentHeight: 30 }),
        block({ pos: 10, contentHeight: 20, kind: "heading" }),
        block({
          pos: 20,
          contentHeight: 240,
          kind: "breakable",
          leadHeight: 20,
          opportunities: [
            { pos: 30, consumed: 20 },
            { pos: 40, consumed: 40 },
            { pos: 50, consumed: 60 },
            { pos: 60, consumed: 80 },
            { pos: 70, consumed: 100 },
            { pos: 80, consumed: 120 },
            { pos: 90, consumed: 140 },
            { pos: 100, consumed: 160 },
            { pos: 110, consumed: 180 },
            { pos: 120, consumed: 200 },
            { pos: 130, consumed: 220 },
          ],
        }),
      ],
      metrics,
    );

    expect(breaks[0]).toEqual({ pos: 40, restPx: 30 });
    expect(breaks.some((entry) => entry.pos === 10)).toBe(false);
  });

  it("does not add a page for an exact fit and splits a one-line overflow", () => {
    expect(
      planPaperPageBreaks(
        [
          block({ pos: 0, contentHeight: 60 }),
          block({ pos: 10, contentHeight: 40 }),
        ],
        metrics,
      ),
    ).toEqual([]);

    expect(
      planPaperPageBreaks(
        [
          block({ pos: 0, contentHeight: 80 }),
          block({
            pos: 10,
            contentHeight: 40,
            kind: "breakable",
            leadHeight: 20,
            opportunities: [{ pos: 20, consumed: 20 }],
          }),
        ],
        metrics,
      ),
    ).toEqual([{ pos: 20, restPx: 20 }]);
  });

  it("keeps the final line when only trailing paragraph space crosses the sheet", () => {
    const breaks = planPaperPageBreaks(
      [
        block({
          pos: 0,
          contentHeight: 90,
          afterGap: 15,
          kind: "breakable",
          opportunities: [{ pos: 5, consumed: 70 }],
        }),
        block({ pos: 10, contentHeight: 20 }),
      ],
      metrics,
    );

    expect(breaks).toEqual([{ pos: 10, restPx: 15 }]);
    expect(breaks.some((entry) => entry.pos === 5)).toBe(false);
  });

  it("creates bounded, strictly increasing breaks through long text", () => {
    const opportunities = Array.from({ length: 14 }, (_, index) => ({
      pos: 10 + index,
      consumed: 20 * (index + 1),
    }));
    const breaks = planPaperPageBreaks(
      [
        block({
          pos: 0,
          contentHeight: 300,
          kind: "breakable",
          leadHeight: 40,
          opportunities,
        }),
      ],
      metrics,
    );

    expect(breaks.map((entry) => entry.pos)).toEqual([14, 19]);
    expect(breaks.every((entry) => entry.restPx <= 120)).toBe(true);
    expect(new Set(breaks.map((entry) => entry.pos)).size).toBe(breaks.length);
  });

  it("fails open for an over-sized atomic block instead of making a blank page", () => {
    const breaks = planPaperPageBreaks(
      [
        block({ pos: 0, contentHeight: 20 }),
        block({ pos: 10, contentHeight: 260 }),
        block({ pos: 20, contentHeight: 20 }),
      ],
      metrics,
    );

    expect(breaks).toEqual([]);
  });

  it("does not make a nearly blank sheet for a page-sized atomic block", () => {
    expect(
      planPaperPageBreaks(
        [
          block({ pos: 0, contentHeight: 20 }),
          block({ pos: 10, contentHeight: 90 }),
        ],
        metrics,
      ),
    ).toEqual([]);

    expect(
      planPaperPageBreaks(
        [
          block({ pos: 0, contentHeight: 70 }),
          block({ pos: 10, contentHeight: 50 }),
        ],
        metrics,
      ),
    ).toEqual([{ pos: 10, restPx: 50 }]);
  });
});
