// @vitest-environment jsdom

import type { Editor as TiptapEditor } from "@tiptap/core";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PaginatedEditor from "./PaginatedEditor.svelte";
import type {
  EditorApi,
  EditorChangeContext,
  WritingActivity,
} from "./types";

let observedResizeCallback: ResizeObserverCallback | null = null;
let observedResizeTarget: Element | null = null;
let observedResizeInstance: ResizeObserver | null = null;

function triggerObservedResize(width: number, height: number): void {
  if (!observedResizeCallback || !observedResizeTarget || !observedResizeInstance) {
    throw new Error("ResizeObserver가 편집기를 관찰하지 않습니다.");
  }
  observedResizeCallback(
    [
      {
        target: observedResizeTarget,
        contentRect: new DOMRect(0, 0, width, height),
      } as ResizeObserverEntry,
    ],
    observedResizeInstance,
  );
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
    window.clearTimeout(handle),
  );
  class FakeResizeObserver {
    constructor(private callback: ResizeObserverCallback) {
      observedResizeCallback = callback;
      observedResizeInstance = this as unknown as ResizeObserver;
    }
    observe(target: Element): void {
      observedResizeTarget = target;
      this.callback(
        [
          {
            target,
            contentRect: new DOMRect(0, 0, 1000, 780),
          } as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    }
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(window, "scrollBy", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(0, 0, 0, 0),
  });
});

afterEach(() => {
  document.body.replaceChildren();
  observedResizeCallback = null;
  observedResizeTarget = null;
  observedResizeInstance = null;
  vi.unstubAllGlobals();
});

function typeCharacters(editable: HTMLElement, text: string): void {
  const tiptap = editable as HTMLElement & { editor: TiptapEditor };
  for (const character of text) {
    editable.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: character,
        bubbles: true,
        cancelable: true,
      }),
    );
    editable.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: character,
        bubbles: true,
        cancelable: true,
      }),
    );
    const position = tiptap.editor.state.selection.from;
    const handled = Boolean(
      tiptap.editor.view.someProp("handleTextInput", (handler) =>
        handler(
          tiptap.editor.view,
          position,
          position,
          character,
          () =>
            tiptap.editor.state.tr.insertText(
              character,
              position,
              position,
            ),
        ),
      ),
    );
    if (!handled) {
      tiptap.editor.view.dispatch(
        tiptap.editor.state.tr.insertText(character, position, position),
      );
    }
  }
}

describe("paginated editorial editor", () => {
  it("marks an empty document title with its title placeholder", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: { value: "# ", onready: (value) => (api = value) },
    });
    await tick();

    const title = target.querySelector<HTMLElement>(
      ".ProseMirror h1.is-empty",
    );
    expect(title).not.toBeNull();
    expect(title?.dataset.placeholder).toBe("제목을 입력하세요");
    expect(api!.getContent().replace(/\n+$/u, "")).toBe("# ");
    unmount(component);
  });

  it("round-trips empty heading offsets inside their original blocks", async () => {
    const source = "# \n\n## \n\n### \n\n본문";
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: { value: source, onready: (value) => (api = value) },
    });
    await tick();

    for (const [marker, level] of [
      ["# ", 1],
      ["## ", 2],
      ["### ", 3],
    ] as const) {
      const offset = source.indexOf(marker) + marker.length;
      api!.setSelection(offset, offset);
      await tick();

      expect(api!.getSelection()).toMatchObject({ from: offset, to: offset });
      expect(
        target.querySelector(`.ProseMirror h${level}.is-active-writing-block`),
      ).not.toBeNull();
    }
    unmount(component);
  });

  it("creates an H2 after Enter ends Korean title composition", async () => {
    const source = "# 제목";
    let api: EditorApi | null = null;
    const changes: Array<{
      value: string;
      context: EditorChangeContext;
    }> = [];
    const activities: WritingActivity[] = [];
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: source,
        onready: (value) => (api = value),
        onchange: (value, context) => changes.push({ value, context }),
        onactivity: (activity) => activities.push(activity),
      },
    });
    await tick();

    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    api!.focus();
    api!.setSelection(source.length, source.length);

    editable.dispatchEvent(
      new CompositionEvent("compositionstart", {
        bubbles: true,
        cancelable: true,
        data: "한",
      }),
    );
    expect(editable.editor.view.composing).toBe(true);
    editable.dispatchEvent(
      new CompositionEvent("compositionend", {
        bubbles: true,
        cancelable: true,
        data: "한",
      }),
    );
    expect(editable.editor.view.composing).toBe(false);
    await Promise.resolve();
    await tick();

    const enter = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Enter",
      key: "Enter",
    });
    Object.defineProperty(enter, "keyCode", { value: 13 });
    editable.dispatchEvent(enter);
    expect(editable.editor.state.selection.$from.parent.type.name).toBe(
      "paragraph",
    );

    typeCharacters(editable, "## ");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();

    expect(editable.querySelector(":scope > h1")?.textContent).toBe("제목");
    expect(editable.querySelector(":scope > h2")?.textContent).toBe("");
    expect(editable.editor.state.selection.$from.parent.type.name).toBe(
      "heading",
    );
    expect(editable.editor.state.selection.$from.parent.attrs.level).toBe(2);
    expect(editable.editor.state.selection.$from.parentOffset).toBe(0);
    expect(api!.getContent().replace(/\n+$/u, "")).toBe(
      "# 제목\n\n## ",
    );
    expect(changes.at(-1)?.context.composing).toBe(false);
    expect(activities).toContainEqual(
      expect.objectContaining({
        kind: "enter",
        origin: "keyboard",
        paragraphDelta: 1,
      }),
    );
    unmount(component);
  });

  it("preserves research Markdown while presenting real A4 typography", async () => {
    const source = [
      "---",
      "title: 재현 가능한 문서",
      "---",
      "# 한글과 English가 자연스러운 제목",
      "",
      "본문의 수식 $E = mc^2$과 각주[^chain]를 함께 쓴다.",
      "",
      "$$",
      "x = y + z",
      "$$",
      "",
      "[^chain]: 검증 가능한 연구 출처",
    ].join("\n");
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    target.style.height = "780px";
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: { value: source, onready: (value) => (api = value) },
    });
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const markdown = api!.getContent();
    expect(markdown).toContain("title: 재현 가능한 문서");
    expect(markdown).toContain("# 한글과 English가 자연스러운 제목");
    expect(markdown).toContain("$E = mc^2$");
    expect(markdown).toContain("[^chain]");
    expect(markdown).toContain("[^chain]: 검증 가능한 연구 출처");
    expect(markdown).toContain("$$\nx = y + z\n$$");
    expect(target.querySelector(".paper-sheet")).not.toBeNull();
    expect(target.querySelector(".ProseMirror h1")?.textContent).toContain(
      "English",
    );
    expect(target.querySelector(".katex")).not.toBeNull();
    expect(target.querySelector(".manuscript-cell")).toBeNull();
    unmount(component);
  });

  it("applies spaces immediately and leaves the caret in the new paragraph", async () => {
    let api: EditorApi | null = null;
    const changes: string[] = [];
    const activities: WritingActivity[] = [];
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "앞뒤",
        onready: (value) => (api = value),
        onchange: (value) => changes.push(value),
        onactivity: (activity) => activities.push(activity),
      },
    });
    await tick();

    expect(target.querySelector(".ProseMirror > p")?.textContent).toBe("앞뒤");
    expect(api!.getContent()).toBe("앞뒤");
    api!.setSelection(1, 1);
    api!.insertAtCursor(" ");
    await tick();
    expect(api!.getContent()).toBe("앞 뒤");
    expect(changes.at(-1)).toBe("앞 뒤");

    const editable = target.querySelector<HTMLElement>(".ProseMirror")!;
    api!.setSelection(api!.getContent().length, api!.getContent().length);
    editable.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await tick();
    expect(editable.querySelectorAll(":scope > p")).toHaveLength(2);
    expect(api!.getSelection().line).toBe(3);
    expect(activities.at(-1)).toMatchObject({
      origin: "keyboard",
      kind: "enter",
      paragraphDelta: 1,
    });
    unmount(component);
  });

  it("keeps rapid numbered text and its caret after a title-space input", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "# ",
        experience: "typewriter",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    api!.focus();
    api!.setSelection(2, 2);
    typeCharacters(editable, "1. ");
    await tick();

    expect(editable.querySelector(":scope > h1")?.textContent).toBe("1. ");
    expect(editable.querySelector(":scope > ol")).toBeNull();
    expect(editable.editor.state.selection.$from.parent.type.name).toBe(
      "heading",
    );
    expect(editable.editor.state.selection.$from.parentOffset).toBe(3);
    expect(api!.getContent().replace(/\n+$/u, "")).toBe("# 1. ");
    unmount(component);
  });

  it("renders a connected carriage over a minimal 18px rail bed", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "첫 문장과 다음 문장을 이어서 씁니다.",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    const editable = target.querySelector<HTMLElement>(".ProseMirror")!;
    expect(shell.style.getPropertyValue("--paper-font")).toContain(
      '"Goorm Sans Code"',
    );
    expect(shell.style.getPropertyValue("--typewriter-strike-y")).toBe(
      "calc(100% - var(--typewriter-strike-bottom))",
    );
    const strikeBottom = Number.parseFloat(
      shell.style.getPropertyValue("--typewriter-strike-bottom"),
    );
    expect(strikeBottom).toBeGreaterThanOrEqual(42);
    expect(strikeBottom).toBeLessThanOrEqual(60);
    expect(shell.style.getPropertyValue("--carriage-track-duration")).toBe(
      "90ms",
    );
    expect(shell.style.getPropertyValue("--carriage-step-duration")).toBe(
      "48ms",
    );
    expect(shell.style.getPropertyValue("--typewriter-paper-width")).toMatch(
      /px$/u,
    );
    expect(shell.style.getPropertyValue("--carriage-return-duration")).toBe(
      "180ms",
    );
    expect(shell.style.getPropertyValue("--typewriter-platen-angle")).toBe(
      "0deg",
    );
    expect(
      Number.parseFloat(
        shell.style.getPropertyValue("--typewriter-platen-pitch"),
      ),
    ).toBeGreaterThan(12);
    expect(observedResizeTarget).toBe(
      target.querySelector(".paper-scroller"),
    );
    expect(shell.classList.contains("writing-typewriter")).toBe(true);
    const machine = target.querySelector<HTMLElement>(".typewriter-machine")!;
    const carriageLayers = target.querySelectorAll<HTMLElement>(
      ".typewriter-carriage-layer",
    );
    const carriageUnderlay = target.querySelector<HTMLElement>(
      ".typewriter-carriage-underlay",
    )!;
    const carriageUpper = target.querySelector<HTMLElement>(
      ".typewriter-carriage-upper",
    )!;
    const frameRear = target.querySelector<HTMLElement>(
      ".typewriter-frame-rear",
    )!;
    const frameFront = target.querySelector<HTMLElement>(
      ".typewriter-frame-front",
    )!;
    expect(machine).not.toBeNull();
    expect(frameRear).not.toBeNull();
    expect(frameFront).not.toBeNull();
    expect(carriageLayers).toHaveLength(2);
    expect(shell.style.getPropertyValue("--typewriter-line-aperture")).toMatch(
      /px$/u,
    );
    expect(machine.style.getPropertyValue("--line-aperture")).toBe(
      "var(--typewriter-line-aperture)",
    );
    expect(
      frameRear.querySelector(":scope > .typewriter-deck-plane"),
    ).toBeNull();
    expect(
      frameRear.querySelector(":scope > .typewriter-rail-recess"),
    ).not.toBeNull();
    expect(
      frameRear.querySelector(":scope > .typewriter-fixed-guide-rail"),
    ).not.toBeNull();
    expect(
      frameFront.querySelector(":scope > .typewriter-front-bevel"),
    ).not.toBeNull();
    expect(
      frameFront.querySelector(":scope > .typewriter-typing-well"),
    ).not.toBeNull();
    expect(
      carriageUnderlay.querySelector(":scope > .typewriter-moving-channel"),
    ).not.toBeNull();
    expect(
      carriageUnderlay.querySelectorAll(":scope > .typewriter-bearing-shoe"),
    ).toHaveLength(2);
    expect(
      carriageUnderlay.querySelectorAll(":scope > .typewriter-bearing-shoe > i"),
    ).toHaveLength(2);
    expect(
      carriageUpper.querySelectorAll(":scope > .typewriter-carriage-side-plate"),
    ).toHaveLength(2);
    expect(target.querySelectorAll(".typewriter-platen-bearing")).toHaveLength(2);
    expect(target.querySelectorAll(".typewriter-bail-pivot")).toHaveLength(2);
    expect(target.querySelectorAll(".typewriter-bail-arm")).toHaveLength(2);
    expect(target.querySelectorAll(".typewriter-bail-arm > i")).toHaveLength(2);
    expect(target.querySelector(".typewriter-paper-shield")).toBeNull();
    expect(target.querySelector(".typewriter-ribbon-cover")).toBeNull();
    expect(target.querySelector(".typewriter-chassis-fastener")).toBeNull();
    expect(target.querySelector(".typewriter-chassis")).toBeNull();
    expect(target.querySelector(".typewriter-carriage-bed")).toBeNull();
    expect(target.querySelector(".typewriter-bearing-race")).toBeNull();
    expect(target.querySelector(".typewriter-carriage-support")).toBeNull();
    expect(target.querySelector(".typewriter-carriage-cradle")).toBeNull();
    expect(target.querySelector(".typewriter-typebasket")).not.toBeNull();
    expect(target.querySelector(".typewriter-paper-wrap")).not.toBeNull();
    expect(target.querySelector(".typewriter-carriage-bearing")).toBeNull();
    expect(target.querySelector(".typewriter-ribbon-window")).toBeNull();
    expect(target.querySelector(".typewriter-platen")).not.toBeNull();
    expect(target.querySelector(".typewriter-paper-bail")).not.toBeNull();
    expect(target.querySelectorAll(".typewriter-bail-roller")).toHaveLength(4);
    expect(target.querySelectorAll(".typewriter-carriage-knob")).toHaveLength(2);
    expect(target.querySelectorAll(".typewriter-carriage-knob > i")).toHaveLength(2);
    expect(target.querySelector(".typewriter-index-wheel")).not.toBeNull();
    expect(target.querySelector(".typewriter-detent-pawl")).toBeNull();
    expect(target.querySelector(".typewriter-return-lever")).not.toBeNull();
    expect(target.querySelector(".typewriter-strike-rail")).not.toBeNull();
    expect(target.querySelector(".typewriter-segment")).not.toBeNull();
    expect(target.querySelector(".typewriter-type-guide")).not.toBeNull();
    expect(target.querySelector(".typewriter-strike-pulse")).not.toBeNull();
    for (const layer of carriageLayers) {
      expect(layer.style.getPropertyValue("--carriage-shift")).toBe("");
    }
    expect(target.querySelector(".typewriter-keycap")).toBeNull();
    expect(machine.classList.contains("active")).toBe(false);

    api!.focus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(target.querySelector(".typewriter-strike-rail")).not.toBeNull();
    expect(target.querySelector(".typewriter-strike-caret")).not.toBeNull();
    expect(machine.classList.contains("active")).toBe(true);
    expect(shell.classList.contains("typewriter-caret-visible")).toBe(true);
    expect(target.querySelector(".active-writing-line")).toBeNull();

    api!.setSelection(api!.getContent().length, api!.getContent().length);
    editable.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(target.querySelector(".typewriter-strike-rail")).not.toBeNull();
    expect(shell.classList.contains("impact-enter")).toBe(false);

    api!.setSelection(0, 4);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(target.querySelector(".typewriter-strike-rail")).not.toBeNull();
    expect(target.querySelector(".typewriter-strike-caret")).toBeNull();
    expect(machine.classList.contains("active")).toBe(false);
    expect(shell.classList.contains("typewriter-caret-visible")).toBe(false);

    api!.setSelection(4, 4);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(target.querySelector(".typewriter-strike-rail")).not.toBeNull();
    expect(target.querySelector(".typewriter-strike-caret")).not.toBeNull();
    expect(machine.classList.contains("active")).toBe(true);

    editable.blur();
    await tick();
    expect(target.querySelector(".typewriter-strike-rail")).not.toBeNull();
    expect(target.querySelector(".typewriter-strike-caret")).toBeNull();
    expect(machine.classList.contains("active")).toBe(false);
    unmount(component);
  });

  it("rolls the platen with soft detents while centering free-scroll paper and carriage", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "플래튼의 회전과 캐리지 위치를 각각 검증합니다.",
        experience: "typewriter",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    const machine = target.querySelector<HTMLElement>(".typewriter-machine")!;
    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    const scroller = target.querySelector<HTMLElement>(".paper-scroller")!;
    const paperWindow = target.querySelector<HTMLElement>(".paper-window")!;
    const stack = target.querySelector<HTMLElement>(".paper-stack")!;
    vi.spyOn(editable.editor.view, "coordsAtPos").mockImplementation(() => ({
      left: 280,
      right: 280,
      top: 548 - scroller.scrollTop,
      bottom: 572 - scroller.scrollTop,
    }));
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    machine.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    paperWindow.getBoundingClientRect = () =>
      new DOMRect(100, 80 - scroller.scrollTop, 794, 1123);
    stack.getBoundingClientRect = () =>
      new DOMRect(100, 80 - scroller.scrollTop, 794, 1123);
    paperWindow.style.transform = "matrix(1, 0, 0, 1, 0, 0)";

    api!.focus();
    api!.setSelection(api!.getContent().length, api!.getContent().length);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();
    const initialShift = shell.style.getPropertyValue("--carriage-shift");
    expect(initialShift).not.toBe("0px");
    const initialSelection = api!.getSelection();
    const alignedTop = scroller.scrollTop;

    const targetTop = scroller.scrollTop + 82;
    scroller.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 82, bubbles: true }),
    );
    scroller.scrollTop = targetTop;
    scroller.dispatchEvent(new Event("scroll"));
    await tick();

    expect(scroller.scrollTop).toBe(targetTop);
    expect(shell.classList.contains("platen-rolling")).toBe(true);
    expect(shell.classList.contains("platen-detenting")).toBe(true);
    expect(Number(machine.dataset.platenDetent)).toBeGreaterThan(0);
    expect(target.querySelector(".typewriter-detent-pawl")).not.toBeNull();
    expect(
      Number.parseFloat(
        shell.style.getPropertyValue("--typewriter-platen-angle"),
      ),
    ).toBeGreaterThan(0);
    expect(
      Number.parseFloat(
        shell.style.getPropertyValue("--typewriter-paper-tension"),
      ),
    ).toBeLessThan(0);
    expect(shell.style.getPropertyValue("--carriage-shift")).toBe("0px");
    expect(api!.getSelection()).toEqual(initialSelection);
    expect(shell.classList.contains("typewriter-caret-visible")).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 110));
    await tick();
    expect(shell.classList.contains("platen-rolling")).toBe(false);
    expect(shell.classList.contains("platen-detenting")).toBe(false);
    expect(target.querySelector(".typewriter-detent-pawl")).toBeNull();
    expect(shell.style.getPropertyValue("--typewriter-paper-tension")).toBe(
      "0px",
    );
    expect(scroller.scrollTop).toBe(targetTop);
    expect(shell.style.getPropertyValue("--carriage-shift")).toBe("0px");

    editable.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        code: "KeyA",
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(scroller.scrollTop).toBeCloseTo(alignedTop);
    expect(api!.getSelection()).toEqual(initialSelection);
    expect(shell.classList.contains("typewriter-caret-visible")).toBe(true);
    expect(shell.classList.contains("typebar-striking")).toBe(true);
    expect(shell.style.getPropertyValue("--carriage-shift")).toBe(initialShift);

    editable.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -24, bubbles: true }),
    );
    await tick();
    expect(scroller.scrollTop).toBeCloseTo(alignedTop);
    expect(api!.getSelection()).toEqual(initialSelection);
    expect(shell.style.getPropertyValue("--carriage-shift")).toBe("0px");
    expect(shell.classList.contains("typewriter-caret-visible")).toBe(false);
    unmount(component);
  });

  it("raises an independent typebar for every rapid physical or IME key", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "키 반응을 확인합니다.",
        experience: "typewriter",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    const editable = target.querySelector<HTMLElement>(".ProseMirror")!;
    api!.focus();
    await new Promise((resolve) => setTimeout(resolve, 20));

    editable.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        code: "KeyA",
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(target.querySelector(".typewriter-strike-pulse")).not.toBeNull();
    expect(shell.classList.contains("typebar-striking")).toBe(true);
    expect(target.querySelectorAll(".typewriter-live-typebar")).toHaveLength(1);

    editable.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Process",
        code: "KeyR",
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(target.querySelectorAll(".typewriter-live-typebar")).toHaveLength(2);

    await new Promise((resolve) => setTimeout(resolve, 110));
    expect(shell.classList.contains("typebar-striking")).toBe(false);
    expect(target.querySelector(".typewriter-live-typebar")).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 85));
    editable.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: "가",
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(target.querySelectorAll(".typewriter-live-typebar")).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 110));

    editable.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: " ",
        code: "Space",
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();
    expect(shell.classList.contains("typebar-striking")).toBe(false);
    expect(target.querySelector(".typewriter-live-typebar")).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 100));
    editable.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    api!.setSelection(2, 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    editable.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "b",
        code: "KeyB",
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(shell.classList.contains("typewriter-revision")).toBe(false);
    expect(shell.classList.contains("typewriter-drafting")).toBe(false);
    expect(shell.classList.contains("typebar-striking")).toBe(true);
    expect(target.querySelectorAll(".typewriter-live-typebar")).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 100));
    editable.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();
    expect(shell.classList.contains("carriage-returning")).toBe(true);
    expect(shell.classList.contains("line-feeding")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 100));
    editable.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Backspace",
        code: "Backspace",
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();
    expect(shell.classList.contains("typebar-striking")).toBe(false);
    unmount(component);
  });

  it("edits immediately after click or cursor movement without a mode switch", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "원하는 위치를 눌러 문장을 고칩니다.",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    const editable = target.querySelector<HTMLElement>(".ProseMirror")!;
    api!.focus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(shell.classList.contains("typewriter-drafting")).toBe(false);
    expect(shell.classList.contains("typewriter-revision")).toBe(false);
    expect(shell.classList.contains("typewriter-caret-visible")).toBe(true);

    editable.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    api!.setSelection(6, 6);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(shell.classList.contains("typewriter-revision")).toBe(false);
    expect(shell.classList.contains("typewriter-caret-visible")).toBe(true);
    expect(target.querySelector(".typewriter-strike-rail")).not.toBeNull();
    expect(target.querySelector(".typewriter-frame-rear")).not.toBeNull();
    expect(target.querySelector(".typewriter-machine.revision")).toBeNull();
    expect(target.querySelector(".typewriter-strike-caret")).not.toBeNull();
    expect(target.querySelector(".typewriter-revision-line")).toBeNull();

    typeCharacters(editable, "가");
    expect(api!.getContent()).toContain("가");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tick();
    expect(shell.classList.contains("typebar-striking")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    editable.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }),
    );
    editable.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(shell.classList.contains("typewriter-revision")).toBe(false);
    expect(shell.classList.contains("typebar-striking")).toBe(false);

    api!.setSelection(3, 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(shell.classList.contains("typewriter-drafting")).toBe(false);
    expect(shell.classList.contains("typewriter-revision")).toBe(false);
    expect(shell.classList.contains("typewriter-caret-visible")).toBe(true);
    typeCharacters(editable, "나");
    expect(api!.getContent()).toContain("나");

    editable.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await tick();
    expect(shell.classList.contains("carriage-returning")).toBe(true);
    expect(shell.classList.contains("line-feeding")).toBe(true);
    unmount(component);
  });

  it("moves typewriter H1 Home and End to the real title boundaries", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "# 가운데 정렬된 제목 문장의 실제 끝\n\n## 소제목\n\n본문",
        experience: "typewriter",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    const machine = target.querySelector<HTMLElement>(".typewriter-machine")!;
    const scroller = target.querySelector<HTMLElement>(".paper-scroller")!;
    const paperWindow = target.querySelector<HTMLElement>(".paper-window")!;
    const stack = target.querySelector<HTMLElement>(".paper-stack")!;
    const heading = editable.editor.state.doc.firstChild!;
    const headingStart = 1;
    const headingEnd = headingStart + heading.content.size;
    const headingMiddle = headingStart + Math.floor(heading.content.size / 2);
    vi.spyOn(editable.editor.view, "coordsAtPos").mockImplementation(
      (position) => ({
        left: 200 + position * 8,
        right: 200 + position * 8,
        top: 548 - scroller.scrollTop,
        bottom: 572 - scroller.scrollTop,
      }),
    );
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    machine.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    paperWindow.getBoundingClientRect = () =>
      new DOMRect(100, 80 - scroller.scrollTop, 794, 1123);
    stack.getBoundingClientRect = () =>
      new DOMRect(100, 80 - scroller.scrollTop, 794, 1123);
    paperWindow.style.transform = "matrix(1, 0, 0, 1, 0, 0)";

    api!.focus();
    editable.editor.commands.setTextSelection(headingMiddle);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const endEvent = new KeyboardEvent("keydown", {
      key: "End",
      code: "End",
      bubbles: true,
      cancelable: true,
    });
    editable.dispatchEvent(endEvent);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();
    expect(endEvent.defaultPrevented).toBe(true);
    expect(editable.editor.state.selection.head).toBe(headingEnd);
    expect(editable.editor.state.selection.$from.parentOffset).toBe(
      heading.content.size,
    );
    expect(shell.style.getPropertyValue("--carriage-shift")).toBe(
      `${400 - (200 + headingEnd * 8)}px`,
    );

    const shiftHomeEvent = new KeyboardEvent("keydown", {
      key: "Home",
      code: "Home",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    editable.dispatchEvent(shiftHomeEvent);
    await tick();
    expect(shiftHomeEvent.defaultPrevented).toBe(true);
    expect(editable.editor.state.selection.anchor).toBe(headingEnd);
    expect(editable.editor.state.selection.head).toBe(headingStart);

    const homeEvent = new KeyboardEvent("keydown", {
      key: "Home",
      code: "Home",
      bubbles: true,
      cancelable: true,
    });
    editable.dispatchEvent(homeEvent);
    await tick();
    expect(homeEvent.defaultPrevented).toBe(true);
    expect(editable.editor.state.selection.from).toBe(headingStart);
    expect(editable.editor.state.selection.empty).toBe(true);

    editable.editor.commands.setTextSelection(headingMiddle);
    const modifiedEnd = new KeyboardEvent("keydown", {
      key: "End",
      code: "End",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    editable.dispatchEvent(modifiedEnd);
    expect(modifiedEnd.defaultPrevented).toBe(false);
    expect(editable.editor.state.selection.head).toBe(headingMiddle);

    let subheadingPosition = 0;
    editable.editor.state.doc.descendants((node, position) => {
      if (node.type.name === "heading" && Number(node.attrs.level) === 2) {
        subheadingPosition = position + 1;
        return false;
      }
      return true;
    });
    editable.editor.commands.setTextSelection(subheadingPosition);
    const subheadingEnd = new KeyboardEvent("keydown", {
      key: "End",
      code: "End",
      bubbles: true,
      cancelable: true,
    });
    editable.dispatchEvent(subheadingEnd);
    expect(subheadingEnd.defaultPrevented).toBe(false);
    expect(editable.editor.state.selection.head).toBe(subheadingPosition);
    unmount(component);
  });

  it("keeps delayed native scroll events shifted and centers explicit free-scroll intent", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "프로그램 스크롤과 자유 스크롤을 구분합니다.",
        experience: "typewriter",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    const machine = target.querySelector<HTMLElement>(".typewriter-machine")!;
    const scroller = target.querySelector<HTMLElement>(".paper-scroller")!;
    const paperWindow = target.querySelector<HTMLElement>(".paper-window")!;
    const stack = target.querySelector<HTMLElement>(".paper-stack")!;
    let scrollTop = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Number(value);
        queueMicrotask(() => {
          scroller.dispatchEvent(new Event("scroll"));
          scroller.dispatchEvent(new Event("scroll"));
        });
      },
    });
    vi.spyOn(editable.editor.view, "coordsAtPos").mockImplementation(() => ({
      left: 280,
      right: 280,
      top: 548 - scrollTop,
      bottom: 572 - scrollTop,
    }));
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    machine.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    paperWindow.getBoundingClientRect = () =>
      new DOMRect(100, 80 - scrollTop, 794, 1123);
    stack.getBoundingClientRect = () =>
      new DOMRect(100, 80 - scrollTop, 794, 1123);
    paperWindow.style.transform = "matrix(1, 0, 0, 1, 0, 0)";

    api!.focus();
    api!.setSelection(api!.getContent().length, api!.getContent().length);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();
    expect(scrollTop).toBeGreaterThan(0);
    expect(shell.style.getPropertyValue("--carriage-shift")).toBe("120px");
    expect(shell.classList.contains("typewriter-caret-visible")).toBe(true);

    scroller.scrollTop = scrollTop + 80;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tick();
    expect(shell.style.getPropertyValue("--carriage-shift")).toBe("120px");

    scroller.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 80, bubbles: true }),
    );
    await tick();
    expect(shell.style.getPropertyValue("--carriage-shift")).toBe("0px");
    expect(shell.classList.contains("typewriter-caret-visible")).toBe(false);
    unmount(component);
  });

  it("reserves the measured scrollbar gutter for the typewriter layer", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: { value: "스크롤바 경계를 맞춥니다.", experience: "typewriter" },
    });
    await tick();

    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    const scroller = target.querySelector<HTMLElement>(".paper-scroller")!;
    Object.defineProperties(scroller, {
      offsetWidth: { configurable: true, value: 800 },
      clientWidth: { configurable: true, value: 785 },
      clientHeight: { configurable: true, value: 600 },
    });
    triggerObservedResize(800, 600);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(
      shell.style.getPropertyValue("--typewriter-scrollbar-gutter"),
    ).toBe("15px");

    Object.defineProperty(scroller, "clientWidth", {
      configurable: true,
      value: 800,
    });
    triggerObservedResize(800, 600);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(
      shell.style.getPropertyValue("--typewriter-scrollbar-gutter"),
    ).toBe("0px");
    unmount(component);
  });

  it("converts a clicked empty title to H3 and realigns the full carriage", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "# ",
        experience: "typewriter",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    const scroller = target.querySelector<HTMLElement>(".paper-scroller")!;
    const paperWindow = target.querySelector<HTMLElement>(".paper-window")!;
    const stack = target.querySelector<HTMLElement>(".paper-stack")!;
    let scrollerHeight = 600;
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: {
        configurable: true,
        get: () => scrollerHeight,
      },
    });
    scroller.getBoundingClientRect = () =>
      new DOMRect(0, 0, 800, scrollerHeight);
    paperWindow.getBoundingClientRect = () =>
      new DOMRect(100, 80 - scroller.scrollTop, 794, 1123);
    stack.getBoundingClientRect = () =>
      new DOMRect(100, 80 - scroller.scrollTop, 794, 1123);
    paperWindow.style.transform = "matrix(1, 0, 0, 1, 0, 0)";
    vi.spyOn(editable.editor.view, "coordsAtPos").mockImplementation(() => {
      const strikeBottom = Number.parseFloat(
        shell.style.getPropertyValue("--typewriter-strike-bottom"),
      );
      const documentCenter =
        scrollerHeight - strikeBottom + (editable.querySelector("h3") ? 23 : 17);
      const center = documentCenter - scroller.scrollTop;
      return {
        left: 400,
        right: 400,
        top: center - 12,
        bottom: center + 12,
      };
    });

    api!.focus();
    editable.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    api!.setSelection(2, 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(shell.classList.contains("typewriter-revision")).toBe(false);
    expect(shell.classList.contains("typewriter-drafting")).toBe(false);
    expect(shell.classList.contains("typewriter-caret-visible")).toBe(true);
    expect(target.querySelector(".typewriter-strike-rail")).not.toBeNull();
    expect(target.querySelector(".typewriter-strike-caret")).not.toBeNull();
    expect(target.querySelector(".typewriter-revision-line")).toBeNull();

    typeCharacters(editable, "### ");
    await new Promise((resolve) => setTimeout(resolve, 40));
    await tick();

    expect(editable.querySelector(":scope > h3")?.textContent).toBe("");
    expect(editable.editor.state.selection.$from.parent.attrs.level).toBe(3);
    expect(editable.editor.state.selection.$from.parentOffset).toBe(0);
    expect(api!.getContent().replace(/\n+$/u, "")).toBe("### ");
    expect(shell.classList.contains("typewriter-drafting")).toBe(false);
    expect(target.querySelector(".typewriter-strike-rail")).not.toBeNull();
    expect(target.querySelector(".typewriter-revision-line")).toBeNull();

    const caret = editable.editor.view.coordsAtPos(
      editable.editor.state.selection.head,
    );
    const strikeBottom = Number.parseFloat(
      shell.style.getPropertyValue("--typewriter-strike-bottom"),
    );
    expect((caret.top + caret.bottom) / 2).toBeCloseTo(600 - strikeBottom);

    scrollerHeight = 480;
    triggerObservedResize(800, 480);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();
    const resizedCaret = editable.editor.view.coordsAtPos(
      editable.editor.state.selection.head,
    );
    const resizedStrikeBottom = Number.parseFloat(
      shell.style.getPropertyValue("--typewriter-strike-bottom"),
    );
    expect((resizedCaret.top + resizedCaret.bottom) / 2).toBeCloseTo(
      480 - resizedStrikeBottom,
    );
    unmount(component);
  });

  it("retargets the paper and carriage artwork from every selection change", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "제목\n\n본문",
        experience: "typewriter",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    const machine = target.querySelector<HTMLElement>(".typewriter-machine")!;
    const scroller = target.querySelector<HTMLElement>(".paper-scroller")!;
    const paperWindow = target.querySelector<HTMLElement>(".paper-window")!;
    const carriageLayers = target.querySelectorAll<HTMLElement>(
      ".typewriter-carriage-layer",
    );
    const stack = target.querySelector<HTMLElement>(".paper-stack")!;
    vi.spyOn(editable.editor.view, "coordsAtPos").mockImplementation(() => {
      const left = editable.editor.state.selection.head <= 2 ? 520 : 280;
      return {
        left,
        right: left,
        top: 540 - scroller.scrollTop,
        bottom: 560 - scroller.scrollTop,
      };
    });
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    machine.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    paperWindow.getBoundingClientRect = () => new DOMRect(100, 80, 794, 1123);
    stack.getBoundingClientRect = () => new DOMRect(100, 80, 794, 1123);
    paperWindow.style.transform = "matrix(1, 0, 0, 1, 0, 0)";

    api!.focus();
    api!.setSelection(api!.getContent().length, api!.getContent().length);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();
    const initialShift = shell.style.getPropertyValue("--carriage-shift");
    expect(initialShift).toBe("120px");
    expect(shell.style.getPropertyValue("--carriage-origin")).toBe("97px");
    for (const layer of carriageLayers) {
      expect(layer.style.getPropertyValue("--carriage-shift")).toBe("");
    }

    editable.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );
    api!.setSelection(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();
    expect(shell.classList.contains("typewriter-revision")).toBe(false);
    expect(shell.classList.contains("typewriter-drafting")).toBe(false);
    expect(shell.style.getPropertyValue("--carriage-shift")).toBe("-120px");
    expect(shell.style.getPropertyValue("--carriage-shift")).not.toBe(
      initialShift,
    );
    expect(shell.style.getPropertyValue("--carriage-origin")).toBe("97px");
    for (const layer of carriageLayers) {
      expect(layer.style.getPropertyValue("--carriage-shift")).toBe("");
    }
    unmount(component);
  });

  it("keeps Markdown in the source while showing only a semantic heading label", async () => {
    const source = "앞 문단\n\n## 둘째 제목\n\n뒤 문단";
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: source,
        onready: (value) => (api = value),
      },
    });
    await tick();

    const headingOffset = source.indexOf("둘째");
    api!.setSelection(headingOffset, headingOffset);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();

    expect(api!.getContent()).toContain("## 둘째 제목");
    const note = target.querySelector(".paper-toolbar-note")?.textContent ?? "";
    expect(note).toContain("2단계 제목");
    expect(note).not.toContain("## 제목");
    expect(target.querySelector(".ProseMirror h2")?.textContent).toBe("둘째 제목");
    unmount(component);
  });

  it("centers one blockquote rail around multiple Markdown paragraphs", async () => {
    const source = "> 첫 문단\n>\n> 둘째 문단";
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: source,
        experience: "typewriter",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const quote = target.querySelector<HTMLElement>(
      ".ProseMirror > blockquote",
    )!;
    const paragraphs = quote.querySelectorAll<HTMLElement>(":scope > p");
    expect(paragraphs).toHaveLength(2);
    expect(getComputedStyle(quote).paddingTop).toBe(
      getComputedStyle(quote).paddingBottom,
    );
    expect(Number.parseFloat(getComputedStyle(paragraphs[0]).marginTop)).toBe(0);
    expect(Number.parseFloat(getComputedStyle(paragraphs[1]).marginBottom)).toBe(0);
    expect(api!.getContent().trimEnd()).toMatch(
      /^> 첫 문단\n>\s*\n> 둘째 문단$/u,
    );
    unmount(component);
  });

  it("renders the literary style with its paired font and guide", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "문학형 원고를 차분하게 이어 씁니다.",
        fontFamily: "MaruBuri",
        experience: "literary",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    expect(shell.style.getPropertyValue("--paper-font")).toContain('"MaruBuri"');
    expect(shell.classList.contains("writing-literary")).toBe(true);
    expect(shell.classList.contains("writing-typewriter")).toBe(false);

    api!.focus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(target.querySelector(".literary-caret-mark")).not.toBeNull();
    expect(target.querySelector(".typewriter-strike-rail")).toBeNull();
    unmount(component);
  });

  it("renders calm session progress in the flow experience", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "첫 문장을 씁니다.",
        fontFamily: "Pretendard",
        experience: "flow",
        sessionWords: 8,
        sessionSentences: 2,
        sessionParagraphs: 1,
        sessionMarks: ["sentence", "sentence", "paragraph"],
      },
    });
    await tick();

    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    expect(shell.classList.contains("writing-flow")).toBe(true);
    expect(shell.style.getPropertyValue("--paper-font")).toContain(
      '"Pretendard"',
    );
    const dockText = target
      .querySelector(".flow-session-dock")
      ?.textContent?.replace(/\s+/gu, "");
    expect(dockText).toContain("8단어");
    expect(dockText).toContain("2문장");
    expect(dockText).toContain("1문단");
    expect(target.querySelectorAll(".flow-session-trace span")).toHaveLength(3);
    expect(
      target.querySelector(".flow-session-trace span.paragraph"),
    ).not.toBeNull();
    expect(target.querySelector(".paper-sheet-layer")?.clientHeight).toBe(0);
    unmount(component);
  });

  it("shows AI continuation as ghost text and accepts it with Tab", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "연구는",
        onready: (value) => (api = value),
      },
    });
    await tick();

    api!.setSelection(api!.getContent().length, api!.getContent().length);
    api!.setGhostText(" 계속된다");
    await tick();
    expect(target.querySelector(".editor-ghost-text")?.textContent).toContain(
      "계속된다",
    );

    target.querySelector<HTMLElement>(".ProseMirror")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    await tick();
    expect(api!.getContent()).toBe("연구는 계속된다");
    expect(target.querySelector(".editor-ghost-text")).toBeNull();
    unmount(component);
  });

  it("renders validated repository images without rewriting their Markdown paths", async () => {
    let api: EditorApi | null = null;
    const changes: string[] = [];
    const source = "![검증 그림](assets/figure.png)\n";
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    let finishImage!: (value: string) => void;
    const imageResponse = new Promise<string>((resolve) => {
      finishImage = resolve;
    });
    const resolveImage = vi.fn(() => imageResponse);
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: source,
        documentPath: "/research/draft.md",
        resolveImage,
        onready: (value) => (api = value),
        onchange: (value) => changes.push(value),
      },
    });
    await tick();
    let layoutFinished = false;
    const layout = api!.awaitLayout!().then(() => {
      layoutFinished = true;
    });
    await Promise.resolve();
    expect(layoutFinished).toBe(false);
    finishImage(dataUrl);
    await layout;

    expect(resolveImage).toHaveBeenCalledWith("assets/figure.png");
    expect(
      target.querySelector<HTMLImageElement>(".editorial-image img")?.getAttribute("src"),
    ).toBe(dataUrl);
    expect(
      target.querySelector<HTMLElement>(".editorial-image-placeholder")?.hidden,
    ).toBe(true);
    expect(api!.getContent()).toContain("![검증 그림](assets/figure.png)");
    expect(api!.getContent()).not.toContain(dataUrl);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changes).toEqual([]);
    unmount(component);
  });
});
