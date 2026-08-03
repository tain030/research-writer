import { describe, expect, it } from "vitest";
import {
  applyBlockStyle,
  currentBlockStyle,
  insertMarkdownLink,
  toggleInlineStyle,
} from "./markdown-formatting";

describe("semantic Markdown formatting", () => {
  it("changes selected lines to one semantic block style", () => {
    const content = "첫 줄\n> 둘째 줄";
    const edit = applyBlockStyle(content, { from: 0, to: content.length }, "heading2");
    expect(edit.replacement).toBe("## 첫 줄\n## 둘째 줄");
    expect(currentBlockStyle(edit.replacement, 3)).toBe("heading2");
  });

  it("offers a document-title style instead of requiring raw Markdown", () => {
    const edit = applyBlockStyle("새 원고", { from: 0, to: 4 }, "heading1");
    expect(edit.replacement).toBe("# 새 원고");
    expect(currentBlockStyle(edit.replacement, 3)).toBe("heading1");
  });

  it("wraps and unwraps strong text while retaining the text selection", () => {
    const wrapped = toggleInlineStyle("강조", { from: 0, to: 2 }, "strong");
    expect(wrapped).toMatchObject({
      replacement: "**강조**",
      from: 2,
      to: 4,
    });
    const unwrapped = toggleInlineStyle("**강조**", { from: 2, to: 4 }, "strong");
    expect(unwrapped).toMatchObject({ replacement: "강조", from: 0, to: 2 });
  });

  it("inserts a complete Markdown link and selects a placeholder label", () => {
    const edit = insertMarkdownLink("", { from: 0, to: 0 }, "https://example.com");
    expect(edit.replacement).toBe("[링크 텍스트](https://example.com)");
    expect(edit.replacement.slice(edit.from, edit.to)).toBe("링크 텍스트");
  });
});
