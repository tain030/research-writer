import { describe, expect, it } from "vitest";
import { renderManuscriptHtml } from "./render-manuscript";

describe("completed manuscript renderer", () => {
  it("renders GFM tables, math and footnotes", () => {
    const source = [
      "| 항목 | 값 |",
      "| --- | --- |",
      "| 합계 | 2 |",
      "",
      "식은 $x^2$이다.[^1]",
      "",
      "[^1]: 계산 근거",
    ].join("\n");
    const html = renderManuscriptHtml(source);

    expect(html).toContain("<table");
    expect(html).toContain("class=\"katex\"");
    expect(html).toContain("data-footnote-ref");
    expect(html).toContain("계산 근거");
  });

  it("drops raw HTML and never loads a remote image", () => {
    const source =
      '<script>window.evil = true</script>\n\n<img src="https://evil.example/x.png">\n\n![원격](https://example.com/image.png)';
    const html = renderManuscriptHtml(source);

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=\"https://");
    expect(html).not.toContain("evil.example");
    expect(html).toContain("remote-image");
    expect(html).toContain("data:image/gif;base64");
  });

  it("replaces a known local image with data supplied by the native layer", () => {
    const dataUrl = "data:image/png;base64,c2FmZQ==";
    const html = renderManuscriptHtml("![도표](assets/chart.png)", {
      "assets/chart.png": dataUrl,
    });

    expect(html).toContain(dataUrl);
    expect(html).toContain('data-asset-path="assets/chart.png"');
    expect(html).not.toContain("missing-image");
  });

  it("preserves source ranges and turns standalone images into figures", () => {
    const source = "# 문서 제목\n\n앞 문단\n\n![도표](chart.png \"분석 결과\")";
    const html = renderManuscriptHtml(source, {}, {
      hiddenRanges: [{ from: 0, to: 7 }],
    });

    expect(html).not.toContain("<h1");
    expect(html).toContain("data-source-from");
    expect(html).toContain('class="manuscript-figure"');
    expect(html).toContain("<figcaption>분석 결과</figcaption>");
  });
});
