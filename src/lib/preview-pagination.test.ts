// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  extractPreviewDocument,
  paginatePreviewBlocks,
  paginatePreviewBlocksAsync,
} from "./preview-pagination";

describe("completed-document pagination", () => {
  it("places a footnote on the first page that references it", () => {
    const extracted = extractPreviewDocument(
      '<p data-source-from="10" data-source-to="20">첫 문단<a data-footnote-ref href="#user-content-fn-1">1</a></p>' +
        '<p data-source-from="21" data-source-to="40">둘째 문단</p>' +
        '<section data-footnotes><ol><li id="user-content-fn-1">근거</li></ol></section>',
    );
    const pages = paginatePreviewBlocks(
      extracted,
      (blocks) => blocks.length <= 1,
    );

    expect(pages).toHaveLength(2);
    expect(pages[0].footnoteHtml).toContain("근거");
    expect(pages[1].footnoteHtml).toBe("");
    expect(pages[1].sourceFrom).toBe(21);
  });

  it("does not duplicate a repeatedly referenced footnote", () => {
    const extracted = extractPreviewDocument(
      '<p><a data-footnote-ref href="#user-content-fn-a">1</a></p>' +
        '<p><a data-footnote-ref href="#user-content-fn-a">1</a></p>' +
        '<section data-footnotes><ol><li id="user-content-fn-a">하나</li></ol></section>',
    );
    const pages = paginatePreviewBlocks(extracted, () => true);

    expect((pages[0].footnoteHtml.match(/하나/g) ?? [])).toHaveLength(1);
  });

  it("moves an indivisible opening block when it cannot share the title page", () => {
    const extracted = extractPreviewDocument(
      '<figure data-source-from="5" data-source-to="30">도판</figure>',
    );
    const pages = paginatePreviewBlocks(
      extracted,
      (_blocks, _notes, firstPage) => !firstPage,
    );

    expect(pages).toHaveLength(2);
    expect(pages[0].bodyHtml).toBe("");
    expect(pages[1].bodyHtml).toContain("도판");
  });

  it("keeps a heading with the following block when the pair fits a new page", () => {
    const extracted = extractPreviewDocument(
      '<p data-source-from="0">앞 문단</p>' +
        '<h2 data-source-from="10">소제목</h2>' +
        '<p data-source-from="20">뒤 문단</p>',
    );
    const pages = paginatePreviewBlocks(extracted, (blocks, _notes, firstPage) => {
      const capacity = firstPage ? 2 : 2;
      return blocks.length <= capacity;
    });

    expect(pages).toHaveLength(2);
    expect(pages[0].bodyHtml).toContain("앞 문단");
    expect(pages[0].bodyHtml).not.toContain("소제목");
    expect(pages[1].bodyHtml).toContain("소제목");
    expect(pages[1].bodyHtml).toContain("뒤 문단");
  });

  it("can paginate incrementally without changing page contents", async () => {
    const extracted = extractPreviewDocument("<p>하나</p><p>둘</p><p>셋</p>");
    const sync = paginatePreviewBlocks(extracted, (blocks) => blocks.length <= 2);
    const incremental = await paginatePreviewBlocksAsync(
      extracted,
      (blocks) => blocks.length <= 2,
      { frameBudgetMs: 0, yieldControl: () => Promise.resolve() },
    );
    expect(incremental).toEqual(sync);
  });
});
