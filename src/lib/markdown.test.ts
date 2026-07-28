import { describe, expect, it } from "vitest";
import {
  appendFootnoteDefinition,
  extractOutline,
  findFootnoteByIdentity,
  nextFootnoteId,
  sentenceRange,
} from "./markdown";

describe("Markdown helpers", () => {
  it("ignores headings inside fenced code", () => {
    const outline = extractOutline("# 제목\n\n```\n## 코드\n```\n\n## 본문");
    expect(outline.map((item) => item.title)).toEqual(["제목", "본문"]);
  });

  it("reuses a matching portable footnote", () => {
    const source =
      "문장[^1]\n\n[^1]: 저자, 제목, https://doi.org/10.1000/example\n";
    expect(findFootnoteByIdentity(source, ["10.1000/example"])).toBe("1");
    expect(nextFootnoteId(source)).toBe("2");
  });

  it("appends a complete Markdown definition", () => {
    expect(appendFootnoteDefinition("문장", "1", "출처")).toBe(
      "문장\n\n[^1]: 출처\n",
    );
  });

  it("finds the Korean sentence around the caret", () => {
    const source = "첫 문장이다. 두 번째 문장이다![^1]\n다음 문단";
    expect(sentenceRange(source, source.indexOf("번째"))).toEqual({
      from: source.indexOf("두"),
      to: source.indexOf("\n"),
    });
  });

  it("keeps the preceding sentence active at its end", () => {
    const source = "A sentence. Next.";
    expect(sentenceRange(source, source.indexOf(" Next"))).toEqual({
      from: 0,
      to: source.indexOf(" Next"),
    });
  });
});
