import { describe, expect, it } from "vitest";
import { renderAiMarkdown } from "./ai-markdown";

describe("AI Markdown rendering", () => {
  it("renders GFM structure and math for assistant replies", () => {
    const html = renderAiMarkdown(
      [
        "## 결론",
        "",
        "**핵심**을 정리합니다.",
        "",
        "- 첫째",
        "- 둘째",
        "",
        "| 항목 | 값 |",
        "| --- | --- |",
        "| 식 | $x^2$ |",
      ].join("\n"),
    );

    expect(html).toContain("<h2>결론</h2>");
    expect(html).toContain("<strong>핵심</strong>");
    expect(html).toContain("<li>첫째</li>");
    expect(html).toContain("<table>");
    expect(html).toContain("class=\"katex\"");
  });

  it("drops raw HTML and unsafe link protocols", () => {
    const html = renderAiMarkdown(
      '<script>alert("x")</script>\n\n[위험](javascript:alert(1)) [안전](https://example.com)',
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com"');
  });
});
