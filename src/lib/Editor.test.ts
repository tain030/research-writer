// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Editor from "./Editor.svelte";
import { layoutManuscript } from "./manuscript-layout";
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

  it("moves repeated Enter breaks to distinct manuscript rows", async () => {
    const changes: string[] = [];
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(Editor, {
      target,
      props: {
        value: "가",
        fallbackTitle: "제목",
        onchange: (value) => changes.push(value),
      },
    });
    await tick();

    const input = target.querySelector("textarea")!;
    input.focus();
    input.setSelectionRange(1, 1);
    input.dispatchEvent(new Event("select", { bubbles: true }));
    for (let index = 0; index < 2; index += 1) {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        }),
      );
    }

    expect(input.value).toBe("가\n\n\n");
    expect(input.selectionStart).toBe(input.value.length);
    expect(changes.at(-1)).toBe("가\n\n\n");
    unmount(component);
  });

  it("moves through both positions in a compact Latin cell", async () => {
    const source = "# 제목\n\nab";
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(Editor, {
      target,
      props: { value: source, fallbackTitle: "제목" },
    });
    await tick();

    const input = target.querySelector("textarea")!;
    input.focus();
    input.setSelectionRange(source.length, source.length);
    input.dispatchEvent(new Event("select", { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowLeft",
      }),
    );
    await tick();

    expect(input.selectionStart).toBe(source.length - 1);
    const caret = target.querySelector<HTMLElement>("[data-caret='true']")!;
    expect(caret.style.getPropertyValue("--caret-x")).toBe("50%");
    unmount(component);
  });

  it("sends only the latest long-manuscript layout while the worker is busy", async () => {
    interface Request {
      revision: number;
      source: string;
      fallbackTitle: string;
    }
    class FakeWorker {
      static instance: FakeWorker;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      requests: Request[] = [];

      constructor() {
        FakeWorker.instance = this;
      }

      postMessage(request: Request): void {
        this.requests.push(request);
      }

      terminate(): void {}
    }
    vi.stubGlobal("Worker", FakeWorker);

    const initial = "가".repeat(4_100);
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(Editor, {
      target,
      props: { value: initial, fallbackTitle: "긴 원고" },
    });
    await tick();

    const worker = FakeWorker.instance;
    expect(worker.requests).toHaveLength(1);
    const input = target.querySelector("textarea")!;
    input.setSelectionRange(initial.length, initial.length);
    for (const character of ["나", "다"]) {
      input.value += character;
      input.setSelectionRange(input.value.length, input.value.length);
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: character,
          inputType: "insertText",
        }),
      );
    }
    expect(worker.requests).toHaveLength(1);

    const first = worker.requests[0];
    worker.onmessage?.({
      data: {
        ...first,
        layout: layoutManuscript(first.source, first.fallbackTitle),
      },
    } as MessageEvent);

    expect(worker.requests).toHaveLength(2);
    expect(worker.requests[1].source).toBe(`${initial}나다`);
    unmount(component);
  });
});
