// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Editor from "./Editor.svelte";
import type { EditorChangeContext } from "./types";

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
    window.clearTimeout(handle),
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("manuscript editor input", () => {
  it("emits a trailing space without an input debounce", async () => {
    const changes: Array<[string, EditorChangeContext]> = [];
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(Editor, {
      target,
      props: {
        value: "가",
        fallbackTitle: "제목",
        onchange: (value, context) => changes.push([value, context]),
      },
    });
    await tick();

    const input = target.querySelector("textarea");
    expect(input).not.toBeNull();
    input!.setSelectionRange(1, 1);
    input!.value = "가 ";
    input!.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: " ",
        inputType: "insertText",
      }),
    );
    await tick();

    expect(changes.at(-1)).toEqual(["가 ", { composing: false }]);
    unmount(component);
  });

  it("does not intercept Enter while the Korean IME is composing", async () => {
    const changes: Array<[string, EditorChangeContext]> = [];
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(Editor, {
      target,
      props: {
        value: "",
        fallbackTitle: "제목",
        onchange: (value, context) => changes.push([value, context]),
      },
    });
    await tick();

    const input = target.querySelector("textarea")!;
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input.value = "한";
    const composingInput = new InputEvent("input", {
      bubbles: true,
      data: "한",
      inputType: "insertCompositionText",
    });
    Object.defineProperty(composingInput, "isComposing", { value: true });
    input.dispatchEvent(composingInput);
    const enter = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    });

    expect(input.dispatchEvent(enter)).toBe(true);
    expect(input.value).toBe("한");
    expect(changes.at(-1)).toEqual(["한", { composing: true }]);

    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(changes.at(-1)).toEqual(["한", { composing: false }]);
    unmount(component);
  });
});
