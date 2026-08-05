// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { HeadingInputGuard } from "./heading-input-guard";
import { MarkdownHeading } from "./markdown-heading";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

function createEditor(content: string): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  return new Editor({
    element,
    content,
    extensions: [
      HeadingInputGuard,
      StarterKit.configure({ heading: false }),
      MarkdownHeading,
      Markdown,
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
  });
}

function typeAt(position: number, text: string): boolean {
  if (!editor) return false;
  editor.commands.setTextSelection(position);
  return Boolean(
    editor.view.someProp("handleTextInput", (handler) =>
      handler(
        editor!.view,
        position,
        position,
        text,
        () => editor!.state.tr.insertText(text, position, position),
      ),
    ),
  );
}

function typeCharacters(text: string): void {
  if (!editor) return;
  for (const character of text) {
    const position = editor.state.selection.from;
    const handled = typeAt(position, character);
    if (!handled) {
      editor.view.dispatch(
        editor.state.tr.insertText(character, position, position),
      );
    }
  }
}

function pressEnter(): boolean {
  if (!editor) return false;
  return Boolean(
    editor.view.someProp("handleKeyDown", (handler) =>
      handler(
        editor!.view,
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    ),
  );
}

function dispatchComposition(
  type: "compositionstart" | "compositionend",
): void {
  editor?.view.dom.dispatchEvent(
    new CompositionEvent(type, {
      bubbles: true,
      cancelable: true,
      data: "한",
    }),
  );
}

function dispatchEnter(): void {
  if (!editor) return;
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    code: "Enter",
    key: "Enter",
  });
  Object.defineProperty(event, "keyCode", { value: 13 });
  editor.view.dom.dispatchEvent(event);
}

function waitForInputRules(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe("visual editor Markdown input rules", () => {
  it.each([
    ["H1", "#", 1],
    ["H2", "##", 2],
    ["H3", "###", 3],
    ["H4", "####", 4],
    ["H5", "#####", 5],
    ["H6", "######", 6],
  ])(
    "converts a character-by-character %s shortcut with one atomic rule",
    (_label, shortcut, level) => {
      editor = createEditor("<p></p>");
      editor.commands.setTextSelection(1);

      typeCharacters(`${shortcut} `);

      expect(editor.state.doc.firstChild?.type.name).toBe("heading");
      expect(editor.state.doc.firstChild?.attrs.level).toBe(level);
      expect(editor.state.doc.firstChild?.textContent).toBe("");
      expect(editor.state.selection.$from.parentOffset).toBe(0);
      expect(editor.getMarkdown().replace(/\n+$/u, "")).toBe(
        `${shortcut} `,
      );
    },
  );

  it("converts a character-by-character H3 shortcut inside an existing title", () => {
    editor = createEditor("<h1></h1>");
    editor.commands.setTextSelection(1);

    typeCharacters("### ");

    expect(editor.state.doc.firstChild?.type.name).toBe("heading");
    expect(editor.state.doc.firstChild?.attrs.level).toBe(3);
    expect(editor.state.doc.firstChild?.textContent).toBe("");
    expect(editor.state.selection.$from.parentOffset).toBe(0);
    expect(editor.getMarkdown().replace(/\n+$/u, "")).toBe("### ");
  });

  it("keeps ## literal until a following space converts it to an H2", () => {
    editor = createEditor("<p>##</p>");
    const position = editor.state.doc.content.size - 1;

    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.firstChild?.textContent).toBe("##");
    expect(typeAt(position, " ")).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe("heading");
    expect(editor.state.doc.firstChild?.attrs.level).toBe(2);
    expect(editor.state.doc.firstChild?.textContent).toBe("");
    expect(editor.state.selection.$from.parent.type.name).toBe("heading");

    editor.commands.insertContent("제목");
    expect(editor.getMarkdown().trimEnd()).toBe("## 제목");
  });

  it("keeps the converted heading selection in its original middle block", () => {
    editor = createEditor("<p>앞 문단</p><p>##</p><p>뒤 문단</p>");
    const firstBlockSize = editor.state.doc.firstChild?.nodeSize ?? 0;
    const secondBlockEnd = firstBlockSize + (editor.state.doc.child(1)?.nodeSize ?? 0) - 1;

    expect(typeAt(secondBlockEnd, " ")).toBe(true);
    expect(editor.state.selection.head).toBeGreaterThan(firstBlockSize);
    expect(editor.state.selection.$from.parent.type.name).toBe("heading");
    expect(editor.state.doc.child(0).textContent).toBe("앞 문단");
    expect(editor.state.doc.child(2).textContent).toBe("뒤 문단");
  });

  it.each([
    ["ordered list", "1.", " ", "1. "],
    ["bullet list", "-", " ", "- "],
    ["alternate bullet list", "+", " ", "+ "],
    ["asterisk bullet list", "*", " ", "* "],
    ["task list", "[ ]", " ", "[ ] "],
    ["checked task list", "[x]", " ", "[x] "],
    ["blockquote", ">", " ", "> "],
    ["backtick code fence", "```", " ", "``` "],
    ["tilde code fence", "~~~", " ", "~~~ "],
    ["dash horizontal rule", "--", "-", "---"],
    ["underscore horizontal rule", "__", "_ ", "___ "],
    ["asterisk horizontal rule", "**", "* ", "*** "],
  ])(
    "keeps a %s shortcut literal inside a heading",
    (_label, before, inserted, expected) => {
      editor = createEditor(`<h2>${before.replace(">", "&gt;")}</h2>`);
      const position = editor.state.doc.content.size - 1;

      expect(typeAt(position, inserted)).toBe(true);
      expect(editor.state.doc.firstChild?.type.name).toBe("heading");
      expect(editor.state.doc.firstChild?.attrs.level).toBe(2);
      expect(editor.state.doc.firstChild?.textContent).toBe(expected);
      expect(editor.state.selection.$from.parent.type.name).toBe("heading");
      expect(editor.state.selection.$from.parentOffset).toBe(expected.length);
    },
  );

  it.each([
    ["H1", "#", 1],
    ["H2", "##", 2],
    ["H3", "###", 3],
  ])(
    "changes an existing heading to %s from a leading Markdown shortcut",
    (_label, shortcut, level) => {
      editor = createEditor(`<h1>${shortcut}기존 제목</h1>`);
      const position = 1 + shortcut.length;

      expect(typeAt(position, " ")).toBe(true);
      expect(editor!.state.doc.firstChild?.type.name).toBe("heading");
      expect(editor!.state.doc.firstChild?.attrs.level).toBe(level);
      expect(editor!.state.doc.firstChild?.textContent).toBe("기존 제목");
      expect(editor!.state.selection.$from.parentOffset).toBe(0);
    },
  );

  it("changes an empty existing heading without leaving marker text", () => {
    editor = createEditor("<h1></h1>");
    editor.commands.insertContent("###");
    const position = editor.state.selection.from;

    expect(typeAt(position, " ")).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.level).toBe(3);
    expect(editor.state.doc.firstChild?.textContent).toBe("");
    expect(editor.state.selection.$from.parent.type.name).toBe("heading");
    expect(editor.state.selection.$from.parentOffset).toBe(0);
  });

  it.each([
    ["orderedList", "1.", " "],
    ["bulletList", "-", " "],
    ["taskList", "[ ]", " "],
    ["blockquote", ">", " "],
    ["heading", "##", " "],
    ["codeBlock", "```", " "],
    ["horizontalRule", "--", "-"],
  ])(
    "still converts a paragraph shortcut to %s",
    (expectedType, before, inserted) => {
      editor = createEditor(`<p>${before.replace(">", "&gt;")}</p>`);
      const position = editor.state.doc.content.size - 1;

      expect(typeAt(position, inserted)).toBe(true);
      expect(editor.state.doc.firstChild?.type.name).toBe(expectedType);
    },
  );

  it("keeps inline Markdown input rules available inside headings", () => {
    editor = createEditor("<h2>**강조*</h2>");
    const position = editor.state.doc.content.size - 1;

    expect(typeAt(position, "*")).toBe(true);
    expect(editor.state.doc.firstChild?.textContent).toBe("강조");
    expect(editor.state.doc.firstChild?.firstChild?.marks[0]?.type.name).toBe(
      "bold",
    );
  });

  it("keeps a code fence literal when Enter exits a heading", () => {
    editor = createEditor("<h2>```</h2>");
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);

    expect(pressEnter()).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe("heading");
    expect(editor.state.doc.firstChild?.textContent).toBe("```");
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("ends Korean heading composition before Enter and converts the next shortcut to H2", () => {
    editor = createEditor("<h1>제목</h1>");
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);

    dispatchComposition("compositionstart");
    expect(editor.view.composing).toBe(true);
    dispatchComposition("compositionend");
    expect(editor.view.composing).toBe(false);

    dispatchEnter();
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");

    typeCharacters("## ");

    expect(editor.state.doc.child(0).type.name).toBe("heading");
    expect(editor.state.doc.child(0).attrs.level).toBe(1);
    expect(editor.state.doc.child(0).textContent).toBe("제목");
    expect(editor.state.doc.child(1).type.name).toBe("heading");
    expect(editor.state.doc.child(1).attrs.level).toBe(2);
    expect(editor.state.doc.child(1).textContent).toBe("");
    expect(editor.state.selection.$from.parent).toBe(editor.state.doc.child(1));
    expect(editor.state.selection.$from.parentOffset).toBe(0);
    expect(editor.getMarkdown().replace(/\n+$/u, "")).toBe(
      "# 제목\n\n## ",
    );
  });

  it.each([
    ["ordered list", "1. "],
    ["blockquote", "> "],
    ["code fence", "``` "],
    ["horizontal rule", "---"],
  ])(
    "keeps a %s shortcut literal when input rules replay after composition",
    async (_label, shortcut) => {
      editor = createEditor("<h2></h2>");
      editor.commands.setTextSelection(1);
      editor.commands.insertContent(shortcut);

      dispatchComposition("compositionstart");
      dispatchComposition("compositionend");
      await waitForInputRules();

      expect(editor.state.doc.firstChild?.type.name).toBe("heading");
      expect(editor.state.doc.firstChild?.attrs.level).toBe(2);
      expect(editor.state.doc.firstChild?.textContent).toBe(shortcut);
    },
  );

  it("allows a heading-level input rule to replay after composition", async () => {
    editor = createEditor("<h1></h1>");
    editor.commands.setTextSelection(1);
    editor.commands.insertContent("### ");

    dispatchComposition("compositionstart");
    dispatchComposition("compositionend");
    await waitForInputRules();

    expect(editor.state.doc.firstChild?.type.name).toBe("heading");
    expect(editor.state.doc.firstChild?.attrs.level).toBe(3);
    expect(editor.state.doc.firstChild?.textContent).toBe("");
    expect(editor.state.selection.$from.parentOffset).toBe(0);
  });
});
