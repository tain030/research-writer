// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownHeading } from "./markdown-heading";
import {
  documentPositionToMarkdownOffset,
  markdownOffsetToDocumentPosition,
  type MarkdownPositionMap,
} from "./markdown-position-map";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

function createEditor(content: string, contentType?: "markdown"): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  return new Editor({
    element,
    content,
    contentType,
    extensions: [
      StarterKit.configure({ heading: false }),
      MarkdownHeading,
      Markdown,
    ],
  });
}

function serializedPrefixLength(value: Editor, position: number): number {
  const fragment = value.state.doc.slice(0, position).content.toJSON();
  return value.markdown!.serialize({ type: "doc", content: fragment }).length;
}

function positionMap(value: Editor, frontmatterLength = 0): MarkdownPositionMap {
  return {
    documentSize: value.state.doc.content.size,
    frontmatterLength,
    serializedPrefixLength: (position) =>
      serializedPrefixLength(value, position),
  };
}

describe("Markdown headings", () => {
  it("serializes and reparses empty ATX headings without dropping their markers", () => {
    editor = createEditor("<h1></h1><h2></h2><h3></h3>");
    const markdown = editor.getMarkdown();

    expect(markdown.split("\n")).toEqual(["# ", "", "## ", "", "### "]);

    editor.commands.setContent(markdown, {
      contentType: "markdown",
      emitUpdate: false,
    });
    expect(
      Array.from({ length: editor.state.doc.childCount }, (_, index) =>
        editor!.state.doc.child(index),
      )
        .filter((node) => node.type.name === "heading")
        .map((node) => node.attrs.level),
    ).toEqual([1, 2, 3]);
    expect(editor.getMarkdown().replace(/\n+$/u, "")).toBe(markdown);
  });

  it("maps empty heading marker offsets back inside the correct heading", () => {
    editor = createEditor("# \n\n## \n\n### \n\n본문", "markdown");
    const markdown = editor.getMarkdown();
    const map = positionMap(editor);

    for (const [marker, level] of [
      ["# ", 1],
      ["## ", 2],
      ["### ", 3],
    ] as const) {
      const markerEnd = markdown.indexOf(marker) + marker.length;
      const position = markdownOffsetToDocumentPosition(markerEnd, map);
      const resolved = editor.state.doc.resolve(position);
      expect(resolved.parent.type.name).toBe("heading");
      expect(resolved.parent.attrs.level).toBe(level);
      expect(resolved.parentOffset).toBe(0);
      expect(documentPositionToMarkdownOffset(position, map)).toBe(markerEnd);
    }

    const bodyOffset = markdown.indexOf("본문");
    const bodyPosition = markdownOffsetToDocumentPosition(bodyOffset, map);
    expect(editor.state.doc.resolve(bodyPosition).parent.type.name).toBe(
      "paragraph",
    );
    expect(editor.state.doc.resolve(bodyPosition).parentOffset).toBe(0);
  });

  it("keeps frontmatter outside the visual document position map", () => {
    editor = createEditor("## ", "markdown");
    const frontmatterLength = "---\ntitle: 문서\n---\n".length;
    const map = positionMap(editor, frontmatterLength);
    const headingStart = 1;

    expect(documentPositionToMarkdownOffset(headingStart, map)).toBe(
      frontmatterLength + 3,
    );
    expect(
      markdownOffsetToDocumentPosition(frontmatterLength + 3, map),
    ).toBe(headingStart);
  });
});
