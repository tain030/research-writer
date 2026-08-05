// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flashEditorInk,
  flashInsertedEditorInk,
  InkFeedback,
} from "./ink-feedback";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
  vi.useRealTimers();
  document.body.replaceChildren();
});

function createEditor(content = "<p></p>"): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  return new Editor({
    element,
    content,
    extensions: [StarterKit, InkFeedback],
  });
}

function insertText(text: string): void {
  if (!editor) return;
  const position = editor.state.selection.head;
  editor.view.dispatch(editor.state.tr.insertText(text, position, position));
}

describe("editor ink feedback", () => {
  it("does not decorate a whitespace-only insertion", () => {
    editor = createEditor("<p>1.</p>");
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    insertText(" ");

    expect(flashInsertedEditorInk(editor.view, " ", "typewriter")).toBe(
      false,
    );
    expect(editor.view.dom.querySelector(".is-typewriter-imprint")).toBeNull();
    expect(editor.state.selection.$from.parent.textContent).toBe("1. ");
    expect(editor.state.selection.$from.parentOffset).toBe(3);
  });

  it("decorates only the visible glyphs in a mixed insertion", () => {
    editor = createEditor();
    insertText(" 가 ");

    expect(flashInsertedEditorInk(editor.view, " 가 ", "typewriter")).toBe(
      true,
    );
    const imprint = editor.view.dom.querySelector(".is-typewriter-imprint");
    expect(imprint?.textContent).toBe("가");
    expect(editor.state.selection.$from.parent.textContent).toBe(" 가 ");
  });

  it("skips feedback when the reported insertion does not match the document", () => {
    editor = createEditor("<p>글</p>");
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);

    expect(flashInsertedEditorInk(editor.view, "다른 글", "literary")).toBe(
      false,
    );
    expect(editor.view.dom.querySelector(".is-settling-ink")).toBeNull();
  });

  it.each(["beforeinput", "compositionstart", "keydown", "pointerdown"])(
    "clears an inline imprint synchronously on %s without moving the model selection",
    (eventName) => {
      vi.useFakeTimers();
      editor = createEditor("<h1>1.</h1>");
      editor.commands.setTextSelection(3);
      flashEditorInk(editor.view, 2, 3, "typewriter");

      expect(
        editor.view.dom.querySelector(".is-typewriter-imprint")?.textContent,
      ).toBe(".");
      editor.view.dom.dispatchEvent(
        new Event(eventName, { bubbles: true, cancelable: true }),
      );

      expect(editor.view.dom.querySelector(".is-typewriter-imprint")).toBeNull();
      expect(editor.state.selection.from).toBe(3);
      expect(editor.state.selection.$from.parent.textContent).toBe("1.");
    },
  );

  it("cancels a stale clear timer before showing the next imprint", () => {
    vi.useFakeTimers();
    editor = createEditor("<p>ab</p>");
    editor.commands.setTextSelection(3);
    flashEditorInk(editor.view, 1, 2, "typewriter");
    vi.advanceTimersByTime(100);
    flashEditorInk(editor.view, 2, 3, "typewriter");

    vi.advanceTimersByTime(40);
    expect(
      editor.view.dom.querySelector(".is-typewriter-imprint")?.textContent,
    ).toBe("b");
    vi.advanceTimersByTime(100);
    expect(editor.view.dom.querySelector(".is-typewriter-imprint")).toBeNull();
  });
});
