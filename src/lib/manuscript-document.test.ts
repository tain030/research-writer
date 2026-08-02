import { describe, expect, it } from "vitest";
import {
  applyQuickFixes,
  parseManuscript,
  updateManuscriptMetadata,
  type ManuscriptMetadata,
} from "./manuscript-document";

describe("manuscript document model", () => {
  it("uses a matching first-level heading as the title without exposing Markdown syntax", () => {
    const source = "# 오래된 방\n\n첫 문단입니다.";
    const parsed = parseManuscript(source, "파일 이름");

    expect(parsed.metadata.title).toBe("오래된 방");
    expect(parsed.metadataSource.kind).toBe("heading");
    expect(parsed.previewMarkdown).toBe("첫 문단입니다.");
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]).toMatchObject({
      kind: "paragraph",
      indent: 1,
    });
    expect(parsed.blocks[0].inlines.map((inline) => inline.text).join("")).toBe(
      "첫 문단입니다.",
    );
  });

  it("does not mistake a later first-level heading for the document title", () => {
    const parsed = parseManuscript(
      "도입 문단입니다.\n\n# 첫 번째 장\n\n본문",
      "파일 이름",
    );

    expect(parsed.metadata.title).toBe("파일 이름");
    expect(parsed.metadataSource.kind).toBe("filename");
    expect(parsed.blocks.map((block) => block.kind)).toEqual([
      "paragraph",
      "heading",
      "paragraph",
    ]);
    expect(parsed.previewMarkdown).toContain("# 첫 번째 장");
  });

  it("reads structured metadata and preserves unknown frontmatter while editing it", () => {
    const source = [
      "---",
      "title: 초고",
      "author: 홍길동",
      "custom_field: 그대로",
      "---",
      "",
      "본문",
    ].join("\n");
    const metadata: ManuscriptMetadata = {
      title: "수정한 제목",
      subtitle: "부제",
      author: "김연구",
      affiliation: "원고지 연구소",
      genre: "평론",
      schema: 1,
      layout: "traditional-ko",
    };
    const updated = updateManuscriptMetadata(source, metadata);
    const parsed = parseManuscript(updated);

    expect(updated).toContain("custom_field: 그대로");
    expect(updated.match(/^---$/gm)).toHaveLength(2);
    expect(parsed.metadata).toMatchObject(metadata);
    expect(parsed.previewMarkdown).toBe("본문");
  });

  it("updates a heading title and adds metadata without duplicating the visible title", () => {
    const source = "# 처음 제목\n\n본문";
    const metadata: ManuscriptMetadata = {
      title: "새 제목",
      subtitle: "",
      author: "쓴이",
      affiliation: "",
      genre: "",
      schema: 1,
      layout: "traditional-ko",
    };
    const updated = updateManuscriptMetadata(source, metadata);
    const parsed = parseManuscript(updated);

    expect(updated).toContain("# 새 제목");
    expect(parsed.metadata.title).toBe("새 제목");
    expect(parsed.titleHeadingRange).not.toBeNull();
    expect(parsed.previewMarkdown).toBe("본문");
  });

  it("recognizes document elements and only collects local image paths", () => {
    const source = [
      "# 자료",
      "",
      "![현장 사진](assets/photo.png)",
      "",
      "| 항목 | 값 |",
      "| --- | --- |",
      "| 가 | 1 |",
      "",
      "$$",
      "x^2",
      "$$",
      "",
      "문장[^1]",
      "",
      "[^1]: 출처",
      "",
      '<script>alert("안 됨")</script>',
      "",
      "![원격](https://example.com/image.png)",
    ].join("\n");
    const parsed = parseManuscript(source);
    const kinds = parsed.blocks.map((block) => block.kind);

    expect(kinds).toEqual(
      expect.arrayContaining([
        "figure",
        "table",
        "math",
        "paragraph",
        "footnote",
        "unsupported",
      ]),
    );
    expect(parsed.imagePaths).toEqual(["assets/photo.png"]);
    expect(parsed.diagnostics.map((item) => item.ruleId)).toEqual(
      expect.arrayContaining(["raw-html", "remote-image", "missing-author"]),
    );
  });

  it("collects and checks images or HTML embedded inside a paragraph", () => {
    const parsed = parseManuscript(
      "앞 ![로컬](assets/inline.png) 뒤 <span>표시</span> ![원격](https://example.com/a.png)",
    );

    expect(parsed.imagePaths).toEqual(["assets/inline.png"]);
    expect(parsed.diagnostics.map((item) => item.ruleId)).toEqual(
      expect.arrayContaining(["raw-html", "remote-image"]),
    );
  });

  it("explains certain manuscript issues and applies only safe fixes in one pass", () => {
    const source = "# 제목\n\n문장  입니다 ... !다음\n같은 문단";
    const parsed = parseManuscript(source);
    const rules = parsed.diagnostics.map((item) => item.ruleId);
    const fixed = applyQuickFixes(source, parsed.diagnostics);

    expect(rules).toEqual(
      expect.arrayContaining([
        "repeated-space",
        "ellipsis",
        "space-before-punctuation",
        "space-after-question",
        "soft-line-break",
      ]),
    );
    expect(fixed).toContain("문장 입니다……! 다음");
    expect(fixed).toContain("\n같은 문단");
    expect(fixed).not.toContain("\n\n같은 문단");
  });

  it("preserves trailing source spaces that Markdown omits from text nodes", () => {
    const plain = parseManuscript("문장  ");
    const styled = parseManuscript("**강조** ");

    expect(plain.blocks[0].inlines.map((inline) => inline.text).join("")).toBe(
      "문장  ",
    );
    expect(plain.blocks[0].inlines.at(-1)).toMatchObject({
      text: "  ",
      from: 2,
      to: 4,
    });
    expect(plain.diagnostics.map((item) => item.ruleId)).toContain(
      "repeated-space",
    );
    expect(styled.blocks[0].inlines.map((inline) => inline.text).join("")).toBe(
      "강조 ",
    );
    expect(styled.blocks[0].inlines.at(-1)).toMatchObject({
      text: " ",
      from: 6,
      to: 7,
    });
  });

  it("can skip diagnostics without changing structure or embedded resources", () => {
    const source = "문장  입니다 !다음 ![그림](assets/a.png)";
    const full = parseManuscript(source);
    const fast = parseManuscript(source, "제목", { diagnostics: false });

    expect(full.diagnostics.length).toBeGreaterThan(0);
    expect(fast.diagnostics).toEqual([]);
    expect(fast.blocks).toEqual(full.blocks);
    expect(fast.imagePaths).toEqual(full.imagePaths);
  });
});
