// @vitest-environment jsdom

import type { Editor as TiptapEditor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PaginatedEditor from "./PaginatedEditor.svelte";
import { setPaperPageBreaks } from "./paper-pagination";
import type {
  EditorApi,
  EditorChangeContext,
  WritingActivity,
} from "./types";

let observedResizeCallback: ResizeObserverCallback | null = null;
let observedResizeTarget: Element | null = null;
let observedResizeInstance: ResizeObserver | null = null;

interface PrintingAdvanceMeasurement {
  sample: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
}

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

function mockPrintingAdvanceMeasurements(
  widthFor: (measurement: PrintingAdvanceMeasurement) => number = ({
    sample,
    fontSize,
  }) => {
    if (sample === "가" || sample === "漢" || sample === "あ" || sample === "ア") {
      return fontSize * 0.88;
    }
    if (sample === "H") return fontSize * 0.68;
    if (sample === "n") return fontSize * 0.56;
    if (sample === "0") return fontSize * 0.6;
    return fontSize;
  },
): {
  measurements: PrintingAdvanceMeasurement[];
  restore: () => void;
} {
  const measurements: PrintingAdvanceMeasurement[] = [];
  const nativeAppend = document.body.append.bind(document.body);
  const appendSpy = vi
    .spyOn(document.body, "append")
    .mockImplementation((...nodes) => {
      for (const node of nodes) {
        if (
          !(node instanceof HTMLElement) ||
          node.style.position !== "fixed" ||
          node.style.visibility !== "hidden"
        ) {
          continue;
        }
        const parsedFontSize = Number.parseFloat(node.style.fontSize);
        const measurement = {
          sample: node.textContent ?? "",
          fontFamily: node.style.fontFamily,
          fontSize: Number.isFinite(parsedFontSize) ? parsedFontSize : 14,
          fontWeight: node.style.fontWeight,
        };
        measurements.push(measurement);
        node.getBoundingClientRect = () =>
          new DOMRect(
            0,
            0,
            widthFor(measurement),
            measurement.fontSize,
          );
      }
      nativeAppend(...nodes);
    });
  return {
    measurements,
    restore: () => appendSpy.mockRestore(),
  };
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
  vi.restoreAllMocks();
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

function mockStationaryTypewriterGeometry(
  target: HTMLElement,
  editable: HTMLElement & { editor: TiptapEditor },
  caretLeft: number | ((position: number) => number) = 400,
): void {
  const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
  const scroller = target.querySelector<HTMLElement>(".paper-scroller")!;
  const machine = target.querySelector<HTMLElement>(".typewriter-machine")!;
  const paperWindow = target.querySelector<HTMLElement>(".paper-window")!;
  const stack = target.querySelector<HTMLElement>(".paper-stack")!;
  vi.spyOn(editable.editor.view, "coordsAtPos").mockImplementation((position) => {
    const strikeBottom = Number.parseFloat(
      shell.style.getPropertyValue("--typewriter-strike-bottom"),
    );
    const center = 600 - strikeBottom;
    const resolvedLeft =
      typeof caretLeft === "function" ? caretLeft(position) : caretLeft;
    return {
      left: resolvedLeft,
      right: resolvedLeft,
      top: center - 12,
      bottom: center + 12,
    };
  });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  machine.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  paperWindow.getBoundingClientRect = () => new DOMRect(100, 80, 794, 1123);
  stack.getBoundingClientRect = () => new DOMRect(100, 80, 794, 1123);
}

describe("paginated editorial editor", () => {
  it("keeps an AI target highlighted independently from editor focus", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    const outside = document.createElement("button");
    document.body.append(target, outside);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "선택 문장입니다.",
        onready: (value) => (api = value),
      },
    });
    await tick();

    api!.setAiSelection(0, 2);
    outside.focus();
    await tick();
    expect(
      target.querySelector(".is-ai-context-selection")?.textContent,
    ).toBe("선택");

    api!.clearAiSelection();
    await tick();
    expect(target.querySelector(".is-ai-context-selection")).toBeNull();
    unmount(component);
  });

  it("applies multiple canonical edits as one undoable transaction", async () => {
    let api: EditorApi | null = null;
    const changes: string[] = [];
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "가나다",
        onready: (value) => (api = value),
        onchange: (value) => changes.push(value),
      },
    });
    await tick();
    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };

    api!.replaceRanges([
      { from: 0, to: 1, text: "A" },
      { from: 2, to: 3, text: "C" },
    ]);
    await tick();
    expect(api!.getContent().trim()).toBe("A나C");
    expect(changes).toHaveLength(1);
    expect(changes[0].trim()).toBe("A나C");

    editable.editor.commands.undo();
    await tick();
    expect(api!.getContent().trim()).toBe("가나다");
    expect(changes.at(-1)?.trim()).toBe("가나다");
    unmount(component);
  });

  it("reparses complete heading edits instead of inserting Markdown fragments", async () => {
    let api: EditorApi | null = null;
    const changes: string[] = [];
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "### 2-2.\n\n## 4. 비교 기준",
        onready: (value) => (api = value),
        onchange: (value) => changes.push(value),
      },
    });
    await tick();

    api!.replaceRanges([
      { from: 0, to: 8, text: "### 2-2. 작동 구조" },
      { from: 10, to: 10, text: "> 작동 흐름\n\n### 2-3. 핵심 용어\n\n" },
    ]);
    await tick();

    expect(api!.getContent()).toContain("### 2-2. 작동 구조");
    expect(api!.getContent()).toContain("### 2-3. 핵심 용어");
    expect(
      Array.from(target.querySelectorAll(".ProseMirror h3"), (heading) =>
        heading.textContent,
      ),
    ).toEqual(["2-2. 작동 구조", "2-3. 핵심 용어"]);
    expect(changes.at(-1)).toBe(api!.getContent());
    unmount(component);
  });

  it("removes stale page gaps when visual-line measurement fails", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "첫 문단입니다.\n\n둘째 문단도 그대로 남아야 합니다.",
        experience: "literary",
        onready: (value) => (api = value),
      },
    });
    await tick();
    await api!.awaitLayout!();

    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    const firstBlockEnd = editable.editor.state.doc.child(0).nodeSize;
    setPaperPageBreaks(editable.editor.view, [
      { pos: firstBlockEnd, restPx: 640 },
    ]);
    expect(target.querySelector(".paper-page-break")).not.toBeNull();

    const measuredRect = HTMLElement.prototype.getBoundingClientRect;
    const measurementFailure = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (
          this.parentElement?.classList.contains("paper-measure-document")
        ) {
          throw new Error("synthetic pagination measurement failure");
        }
        return measuredRect.call(this);
      });
    const insertPosition = editable.editor.state.doc.content.size - 1;
    editable.editor.view.dispatch(
      editable.editor.state.tr.insertText(" 추가", insertPosition),
    );
    await api!.awaitLayout!();

    expect(target.querySelector(".paper-page-break")).toBeNull();
    expect(api!.getPageCount!()).toBe(1);
    expect(api!.getContent()).toContain("첫 문단입니다.");
    expect(api!.getContent()).toContain("둘째 문단도 그대로 남아야 합니다. 추가");
    measurementFailure.mockRestore();
    unmount(component);
  });

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

    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
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

  it("renders a stationary platen and moving Selectric-style print carrier", async () => {
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
    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    const paperWindow = target.querySelector<HTMLElement>(".paper-window")!;
    expect(shell.style.getPropertyValue("--paper-font")).toContain(
      '"Pretendard"',
    );
    expect(shell.style.getPropertyValue("--typewriter-strike-y")).toBe(
      "calc(100% - var(--typewriter-strike-bottom))",
    );
    const strikeBottom = Number.parseFloat(
      shell.style.getPropertyValue("--typewriter-strike-bottom"),
    );
    expect(strikeBottom).toBeGreaterThanOrEqual(43);
    expect(strikeBottom).toBeLessThanOrEqual(61);
    expect(
      shell.style.getPropertyValue("--print-carrier-track-duration"),
    ).toBe("90ms");
    expect(
      shell.style.getPropertyValue("--print-carrier-step-duration"),
    ).toBe("35ms");
    expect(shell.style.getPropertyValue("--typewriter-paper-width")).toMatch(
      /px$/u,
    );
    expect(
      shell.style.getPropertyValue("--print-carrier-return-duration"),
    ).toBe("180ms");
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
    expect(shell.style.getPropertyValue("--carriage-shift")).toBe("");
    expect(paperWindow.style.transform).toBe("");

    const machine = target.querySelector<HTMLElement>(".typewriter-machine")!;
    const frameRear = target.querySelector<HTMLElement>(
      ".typewriter-frame-rear",
    )!;
    const frameFront = target.querySelector<HTMLElement>(
      ".typewriter-frame-front",
    )!;
    const platenAssembly = target.querySelector<HTMLElement>(
      ".typewriter-platen-assembly",
    )!;
    expect(machine).not.toBeNull();
    expect(frameRear).not.toBeNull();
    expect(frameFront).not.toBeNull();
    expect(platenAssembly).not.toBeNull();
    expect(target.querySelector(".typewriter-carriage-layer")).toBeNull();
    expect(shell.style.getPropertyValue("--typewriter-line-aperture")).toMatch(
      /px$/u,
    );
    expect(machine.style.getPropertyValue("--line-aperture")).toBe(
      "var(--typewriter-line-aperture)",
    );
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
      platenAssembly.querySelectorAll(":scope > .typewriter-platen-endcap"),
    ).toHaveLength(2);
    expect(target.querySelectorAll(".typewriter-platen-bearing")).toHaveLength(2);
    expect(target.querySelectorAll(".typewriter-bail-pivot")).toHaveLength(2);
    expect(target.querySelectorAll(".typewriter-bail-arm")).toHaveLength(2);
    expect(target.querySelectorAll(".typewriter-bail-arm > i")).toHaveLength(2);
    expect(target.querySelector(".typewriter-paper-wrap")).not.toBeNull();
    expect(target.querySelector(".typewriter-platen")).not.toBeNull();
    expect(target.querySelector(".typewriter-paper-bail")).not.toBeNull();
    expect(target.querySelectorAll(".typewriter-bail-roller")).toHaveLength(4);
    expect(target.querySelectorAll(".typewriter-platen-knob")).toHaveLength(2);
    expect(target.querySelectorAll(".typewriter-platen-knob > i")).toHaveLength(2);
    expect(target.querySelector(".typewriter-index-wheel")).not.toBeNull();
    expect(target.querySelector(".typewriter-detent-pawl")).toBeNull();
    expect(target.querySelector(".typewriter-carrier-track")).not.toBeNull();

    expect(target.querySelector(".typewriter-typebasket")).toBeNull();
    expect(target.querySelector(".typewriter-return-lever")).toBeNull();
    expect(target.querySelector(".typewriter-strike-rail")).toBeNull();
    expect(target.querySelector(".typewriter-type-guide")).toBeNull();
    expect(target.querySelector(".typewriter-strike-caret")).toBeNull();
    expect(target.querySelector(".typewriter-live-typebar")).toBeNull();
    expect(target.querySelector(".typewriter-print-carrier")).toBeNull();
    expect(machine.classList.contains("active")).toBe(false);

    mockStationaryTypewriterGeometry(target, editable);
    api!.focus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    const carrier = target.querySelector<HTMLElement>(
      ".typewriter-print-carrier",
    )!;
    expect(carrier).not.toBeNull();
    expect(carrier.querySelector(".typewriter-carrier-bearing")).not.toBeNull();
    expect(carrier.querySelector(".typewriter-carrier-body")).not.toBeNull();
    expect(carrier.querySelector(".typewriter-ribbon-gate")).not.toBeNull();
    expect(carrier.querySelector(".typewriter-element-yoke")).not.toBeNull();
    expect(carrier.querySelector(".typewriter-print-element")).not.toBeNull();
    expect(carrier.querySelector(".typewriter-element-shell")).not.toBeNull();
    expect(carrier.querySelector(".typewriter-strike-face")).not.toBeNull();
    expect(carrier.querySelector(".typewriter-element-cap")).toBeNull();
    expect(carrier.querySelector(".typewriter-element-glyph-belt")).toBeNull();
    expect(carrier.querySelector(".typewriter-active-slug")).toBeNull();
    expect(target.querySelector(".typewriter-strike-caret")).toBeNull();
    expect(machine.classList.contains("active")).toBe(true);
    expect(shell.classList.contains("print-carrier-visible")).toBe(true);
    expect(shell.classList.contains("mechanical-caret-active")).toBe(false);
    expect(shell.style.getPropertyValue("--type-strike-width")).toMatch(/px$/u);
    expect(shell.style.getPropertyValue("--type-strike-height")).toMatch(/px$/u);
    expect(shell.style.getPropertyValue("--type-strike-top-offset")).toMatch(
      /px$/u,
    );
    expect(shell.style.getPropertyValue("--type-element-width")).toMatch(/px$/u);
    expect(shell.style.getPropertyValue("--type-element-height")).toMatch(/px$/u);
    expect(target.querySelector(".active-writing-line")).toBeNull();

    api!.setSelection(api!.getContent().length, api!.getContent().length);
    editable.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(target.querySelector(".typewriter-print-carrier")).not.toBeNull();
    expect(shell.classList.contains("impact-enter")).toBe(false);

    api!.setSelection(0, 4);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(target.querySelector(".typewriter-print-carrier")).toBeNull();
    expect(target.querySelector(".typewriter-strike-caret")).toBeNull();
    expect(machine.classList.contains("active")).toBe(false);
    expect(shell.classList.contains("print-carrier-visible")).toBe(false);

    api!.setSelection(4, 4);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(target.querySelector(".typewriter-print-carrier")).not.toBeNull();
    expect(target.querySelector(".typewriter-print-element")).not.toBeNull();
    expect(machine.classList.contains("active")).toBe(true);

    editable.blur();
    await tick();
    expect(target.querySelector(".typewriter-print-carrier")).toBeNull();
    expect(machine.classList.contains("active")).toBe(false);
    unmount(component);
  });

  it("keeps the horizontal strike face centered and adapts it to body and heading type", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "# 큰 제목\n\n본문 문장",
        experience: "typewriter",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    mockStationaryTypewriterGeometry(target, editable);
    api!.focus();

    let headingPosition = 1;
    let paragraphPosition = 1;
    editable.editor.state.doc.descendants((node, position) => {
      if (node.type.name === "heading") headingPosition = position + 1;
      if (node.type.name === "paragraph") paragraphPosition = position + 1;
    });

    editable.editor.commands.setTextSelection(paragraphPosition);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    const bodyStrikeWidth = Number.parseFloat(
      shell.style.getPropertyValue("--type-strike-width"),
    );
    const bodyStrikeHeight = Number.parseFloat(
      shell.style.getPropertyValue("--type-strike-height"),
    );
    const bodyStrikeOffset = Number.parseFloat(
      shell.style.getPropertyValue("--type-strike-top-offset"),
    );
    const bodyElement = Number.parseFloat(
      shell.style.getPropertyValue("--type-element-height"),
    );

    editable.editor.commands.setTextSelection(headingPosition);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    const headingStrikeWidth = Number.parseFloat(
      shell.style.getPropertyValue("--type-strike-width"),
    );
    const headingStrikeHeight = Number.parseFloat(
      shell.style.getPropertyValue("--type-strike-height"),
    );
    const headingStrikeOffset = Number.parseFloat(
      shell.style.getPropertyValue("--type-strike-top-offset"),
    );
    const headingElement = Number.parseFloat(
      shell.style.getPropertyValue("--type-element-height"),
    );

    expect(bodyStrikeWidth).toBeGreaterThanOrEqual(10);
    expect(headingStrikeWidth).toBeGreaterThan(bodyStrikeWidth);
    expect(bodyStrikeHeight).toBeGreaterThanOrEqual(3);
    expect(headingStrikeHeight).toBeGreaterThan(bodyStrikeHeight);
    expect(headingStrikeOffset).toBeGreaterThan(bodyStrikeOffset);
    expect(headingElement).toBeLessThanOrEqual(17);
    expect(headingElement).toBeGreaterThan(bodyElement);
    expect(
      Number.parseFloat(shell.style.getPropertyValue("--print-carrier-offset")),
    ).toBeCloseTo(-111.08);
    unmount(component);
  });

  it("centers the idle strike face on the preceding grapheme and uses a virtual prior cell at line start", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "가나",
        experience: "typewriter",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
      new DOMRect(410, 548, 18, 24),
    ] as unknown as DOMRectList);
    const printingMeasurements = mockPrintingAdvanceMeasurements();
    mockStationaryTypewriterGeometry(target, editable);
    api!.focus();
    api!.setSelection(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();

    expect(
      Number.parseFloat(shell.style.getPropertyValue("--print-carrier-offset")),
    ).toBeCloseTo(419 - (100 + 794 / 2));

    api!.setSelection(0, 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();
    const pageScale = Number.parseFloat(
      shell.style.getPropertyValue("--paper-scale"),
    );
    const bodyFontSize = Number.parseFloat(getComputedStyle(editable).fontSize);
    expect(
      Number.parseFloat(shell.style.getPropertyValue("--print-carrier-offset")),
    ).toBeCloseTo(
      400 - bodyFontSize * 0.88 * pageScale / 2 - (100 + 794 / 2),
    );
    expect(printingMeasurements.measurements.at(-1)?.sample).toBe("가");
    unmount(component);
    printingMeasurements.restore();
  });

  it("uses a virtual prior cell when the preceding glyph belongs to the wrapped line above", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "가나",
        experience: "typewriter",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
      new DOMRect(410, 500, 18, 24),
    ] as unknown as DOMRectList);
    const printingMeasurements = mockPrintingAdvanceMeasurements(() => 18);
    mockStationaryTypewriterGeometry(target, editable);
    api!.focus();
    api!.setSelection(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();

    const pageScale = Number.parseFloat(
      shell.style.getPropertyValue("--paper-scale"),
    );
    expect(
      Number.parseFloat(shell.style.getPropertyValue("--print-carrier-offset")),
    ).toBeCloseTo(400 - 18 * pageScale / 2 - (100 + 794 / 2));
    unmount(component);
    printingMeasurements.restore();
  });

  it("centers virtual prior cells from the active H1, H2, H3, and body styles", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "# 큰 제목!\n\n## 중간 제목!\n\n### 작은 제목!\n\n본문 문장!",
        experience: "typewriter",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    const printingMeasurements = mockPrintingAdvanceMeasurements();
    mockStationaryTypewriterGeometry(target, editable);
    api!.focus();

    const positions: number[] = [];
    editable.editor.state.doc.descendants((node, position) => {
      if (
        node.type.name === "heading" ||
        node.type.name === "paragraph"
      ) {
        positions.push(position + 1);
      }
    });
    const blocks = Array.from(
      target.querySelectorAll<HTMLElement>(
        ".ProseMirror > h1, .ProseMirror > h2, .ProseMirror > h3, .ProseMirror > p",
      ),
    );
    expect(positions).toHaveLength(4);
    expect(blocks).toHaveLength(4);

    const pageScale = Number.parseFloat(
      shell.style.getPropertyValue("--paper-scale"),
    );
    for (let index = 0; index < positions.length; index += 1) {
      editable.editor.commands.setTextSelection(positions[index]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await tick();
      const fontSize = Number.parseFloat(
        getComputedStyle(blocks[index]).fontSize,
      );
      const expectedCenter = 400 - fontSize * 0.88 * pageScale / 2;
      expect(
        Number.parseFloat(
          shell.style.getPropertyValue("--print-carrier-offset"),
        ),
      ).toBeCloseTo(expectedCenter - (100 + 794 / 2));
    }

    expect(
      new Set(blocks.map((block) => getComputedStyle(block).fontSize)).size,
    ).toBeGreaterThanOrEqual(3);
    expect(
      printingMeasurements.measurements.every(({ sample }) => sample === "가"),
    ).toBe(true);
    unmount(component);
    printingMeasurements.restore();
  });

  it("uses the exact preceding glyph center across H1, H2, H3, and body styles", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "# 큰 제목!\n\n## 중간 제목!\n\n### 작은 제목!\n\n본문 문장!",
        experience: "typewriter",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    const glyphLeftByTag: Record<string, number> = {
      H1: 410,
      H2: 440,
      H3: 470,
      P: 500,
    };
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (
      this: Range,
    ) {
      const left =
        glyphLeftByTag[this.startContainer.parentElement?.tagName ?? ""];
      return Number.isFinite(left)
        ? ([new DOMRect(left, 548, 18, 24)] as unknown as DOMRectList)
        : ([] as unknown as DOMRectList);
    });
    mockStationaryTypewriterGeometry(target, editable);
    api!.focus();

    const positions: number[] = [];
    editable.editor.state.doc.descendants((node, position) => {
      if (node.type.name === "heading" || node.type.name === "paragraph") {
        positions.push(position + 1 + node.content.size);
      }
    });
    expect(positions).toHaveLength(4);

    const expectedCenters = [419, 449, 479, 509];
    for (let index = 0; index < positions.length; index += 1) {
      editable.editor.commands.setTextSelection(positions[index]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await tick();
      expect(
        Number.parseFloat(
          shell.style.getPropertyValue("--print-carrier-offset"),
        ),
      ).toBeCloseTo(expectedCenters[index] - (100 + 794 / 2));
    }
    unmount(component);
  });

  it("keeps contextual cell centering through lists, quotes, bold text, and code", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value:
          "- 목록 문장!\n\n> 인용 문장!\n\n**굵은 문장!**\n\n```text\n코드 문장!\n```",
        experience: "typewriter",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    const printingMeasurements = mockPrintingAdvanceMeasurements();
    mockStationaryTypewriterGeometry(target, editable);
    api!.focus();

    const textblockEnds: number[] = [];
    editable.editor.state.doc.descendants((node, position) => {
      if (node.isTextblock && node.textContent) {
        textblockEnds.push(position + 1 + node.content.size);
      }
    });
    expect(textblockEnds).toHaveLength(4);
    for (const position of textblockEnds) {
      editable.editor.commands.setTextSelection(position);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await tick();
    }

    expect(
      printingMeasurements.measurements.every(({ sample }) => sample === "가"),
    ).toBe(true);
    expect(
      printingMeasurements.measurements.some(({ fontWeight }) =>
        fontWeight === "bold" ||
        fontWeight === "bolder" ||
        Number.parseFloat(fontWeight) >= 600,
      ),
    ).toBe(true);
    unmount(component);
    printingMeasurements.restore();
  });

  it("inherits an empty paragraph cell from prior context and defaults an empty document to Korean", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "release notes",
        experience: "typewriter",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    const printingMeasurements = mockPrintingAdvanceMeasurements(
      ({ sample }) => sample === "가" ? 16 : sample === "n" ? 8 : 4,
    );
    mockStationaryTypewriterGeometry(target, editable);
    api!.focus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    editable.editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "release notes" }],
        },
        { type: "paragraph" },
      ],
    });
    editable.editor.commands.setTextSelection(
      editable.editor.state.doc.content.size - 1,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();
    const pageScale = Number.parseFloat(
      shell.style.getPropertyValue("--paper-scale"),
    );
    expect(
      Number.parseFloat(shell.style.getPropertyValue("--print-carrier-offset")),
    ).toBeCloseTo(400 - 8 * pageScale / 2 - (100 + 794 / 2));

    editable.editor.commands.setContent({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    editable.editor.commands.setTextSelection(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();
    expect(
      Number.parseFloat(shell.style.getPropertyValue("--print-carrier-offset")),
    ).toBeCloseTo(400 - 16 * pageScale / 2 - (100 + 794 / 2));
    expect(
      new Set(
        printingMeasurements.measurements.map(({ sample }) => sample),
      ),
    ).toEqual(new Set(["가", "n"]));
    unmount(component);
    printingMeasurements.restore();
  });

  it("moves from the preceding glyph to the inserted glyph and stays there after impact", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "가다",
        experience: "typewriter",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (
      this: Range,
    ) {
      return [
        new DOMRect(400 + this.startOffset * 20, 548, 20, 24),
      ] as unknown as DOMRectList;
    });
    mockStationaryTypewriterGeometry(target, editable);
    api!.focus();
    api!.setSelection(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();
    const impactOffset = Number.parseFloat(
      shell.style.getPropertyValue("--print-carrier-offset"),
    );

    typeCharacters(editable, "나");
    await new Promise((resolve) => setTimeout(resolve, 25));
    await tick();
    expect(shell.classList.contains("printing-element-striking")).toBe(true);
    expect(
      Number.parseFloat(shell.style.getPropertyValue("--print-carrier-offset")),
    ).toBeCloseTo(impactOffset + 20);

    await new Promise((resolve) => setTimeout(resolve, 65));
    await tick();
    expect(
      Number.parseFloat(shell.style.getPropertyValue("--print-carrier-offset")),
    ).toBeCloseTo(impactOffset + 20);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await tick();
    expect(
      Number.parseFloat(shell.style.getPropertyValue("--print-carrier-offset")),
    ).toBeCloseTo(impactOffset + 20);
    expect(shell.classList.contains("print-carrier-stepping")).toBe(false);
    expect(shell.classList.contains("printing-element-striking")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 100));
    await tick();
    expect(shell.classList.contains("print-carrier-stepping")).toBe(false);
    expect(shell.classList.contains("printing-element-striking")).toBe(false);
    unmount(component);
  });

  it("advances without an impact hold when reduced motion is requested", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        media: "(prefers-reduced-motion: reduce)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "가",
        experience: "typewriter",
        onready: (value) => (api = value),
      },
    });
    await tick();

    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    mockStationaryTypewriterGeometry(
      target,
      editable,
      (position) => 300 + position * 12,
    );
    api!.focus();
    api!.setSelection(api!.getContent().length, api!.getContent().length);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const before = Number.parseFloat(
      shell.style.getPropertyValue("--print-carrier-offset"),
    );

    typeCharacters(editable, "나");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(
      Number.parseFloat(shell.style.getPropertyValue("--print-carrier-offset")),
    ).toBeCloseTo(before + 12);
    expect(shell.classList.contains("printing-element-striking")).toBe(false);
    expect(shell.style.getPropertyValue("--printing-element-rotate")).toBe(
      "0deg",
    );
    expect(shell.style.getPropertyValue("--printing-element-tilt")).toBe("0deg");
    unmount(component);
  });

  it("rolls the fixed platen with soft detents while hiding the carrier during free scroll", async () => {
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
    api!.focus();
    api!.setSelection(api!.getContent().length, api!.getContent().length);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();
    const initialOffset = shell.style.getPropertyValue("--print-carrier-offset");
    expect(Number.parseFloat(initialOffset)).toBeCloseTo(-224.04);
    expect(paperWindow.style.transform).toBe("");
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
    expect(shell.style.getPropertyValue("--print-carrier-offset")).toBe(
      initialOffset,
    );
    expect(api!.getSelection()).toEqual(initialSelection);
    expect(shell.classList.contains("print-carrier-visible")).toBe(false);
    expect(target.querySelector(".typewriter-print-carrier")).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 110));
    await tick();
    expect(shell.classList.contains("platen-rolling")).toBe(false);
    expect(shell.classList.contains("platen-detenting")).toBe(false);
    expect(target.querySelector(".typewriter-detent-pawl")).toBeNull();
    expect(shell.style.getPropertyValue("--typewriter-paper-tension")).toBe(
      "0px",
    );
    expect(scroller.scrollTop).toBe(targetTop);
    expect(shell.style.getPropertyValue("--print-carrier-offset")).toBe(
      initialOffset,
    );
    expect(paperWindow.style.transform).toBe("");

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
    expect(shell.classList.contains("print-carrier-visible")).toBe(true);
    expect(shell.classList.contains("printing-element-striking")).toBe(true);
    const strikingOffset = shell.style.getPropertyValue(
      "--print-carrier-offset",
    );
    expect(Number.parseFloat(strikingOffset)).toBeCloseTo(-212.52);

    editable.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -24, bubbles: true }),
    );
    await tick();
    expect(scroller.scrollTop).toBeCloseTo(alignedTop);
    expect(api!.getSelection()).toEqual(initialSelection);
    expect(shell.style.getPropertyValue("--print-carrier-offset")).toBe(
      strikingOffset,
    );
    expect(shell.classList.contains("print-carrier-visible")).toBe(false);
    expect(paperWindow.style.transform).toBe("");
    unmount(component);
  });

  it("holds the paper still while dragging a selection and aligns a click only after release", async () => {
    let api: EditorApi | null = null;
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "첫 문장을 고르고 다음 문장까지 드래그합니다.",
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
    let clickedDocumentCenter = 640;
    vi.spyOn(editable.editor.view, "coordsAtPos").mockImplementation(() => {
      const nearStart = editable.editor.state.selection.head <= 3;
      const center = nearStart ? clickedDocumentCenter : 560;
      const left = nearStart ? 520 : 280;
      return {
        left,
        right: left,
        top: center - scroller.scrollTop - 12,
        bottom: center - scroller.scrollTop + 12,
      };
    });
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    machine.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    paperWindow.getBoundingClientRect = () =>
      new DOMRect(100, 80 - scroller.scrollTop, 794, 1123);
    stack.getBoundingClientRect = () =>
      new DOMRect(100, 80 - scroller.scrollTop, 794, 1123);
    api!.focus();
    api!.setSelection(api!.getContent().length, api!.getContent().length);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();
    const frozenCarrierOffset = shell.style.getPropertyValue(
      "--print-carrier-offset",
    );
    expect(Number.parseFloat(frozenCarrierOffset)).toBeCloseTo(-224.04);
    expect(paperWindow.style.transform).toBe("");

    scroller.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 82, bubbles: true }),
    );
    scroller.scrollTop += 82;
    scroller.dispatchEvent(new Event("scroll"));
    await tick();
    const frozenScrollTop = scroller.scrollTop;
    expect(shell.style.getPropertyValue("--print-carrier-offset")).toBe(
      frozenCarrierOffset,
    );

    editable.dispatchEvent(
      new MouseEvent("pointerdown", { button: 0, bubbles: true }),
    );
    const reverseAnchor = 9;
    const reverseHead = 2;
    editable.editor.view.dispatch(
      editable.editor.state.tr.setSelection(
        TextSelection.create(
          editable.editor.state.doc,
          reverseAnchor,
          reverseHead,
        ),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();

    expect(shell.classList.contains("pointer-selecting")).toBe(true);
    expect(shell.classList.contains("print-carrier-visible")).toBe(
      false,
    );
    expect(scroller.scrollTop).toBe(frozenScrollTop);
    expect(shell.style.getPropertyValue("--print-carrier-offset")).toBe(
      frozenCarrierOffset,
    );
    expect(editable.editor.state.selection.anchor).toBe(reverseAnchor);
    expect(editable.editor.state.selection.head).toBe(reverseHead);

    window.dispatchEvent(new MouseEvent("pointerup", { button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();

    expect(shell.classList.contains("pointer-selecting")).toBe(false);
    expect(scroller.scrollTop).toBe(frozenScrollTop);
    expect(shell.style.getPropertyValue("--print-carrier-offset")).toBe(
      frozenCarrierOffset,
    );
    expect(editable.editor.state.selection.anchor).toBe(reverseAnchor);
    expect(editable.editor.state.selection.head).toBe(reverseHead);

    const strikeBottom = Number.parseFloat(
      shell.style.getPropertyValue("--typewriter-strike-bottom"),
    );
    clickedDocumentCenter =
      scroller.getBoundingClientRect().bottom -
      strikeBottom +
      frozenScrollTop +
      48;
    editable.dispatchEvent(
      new MouseEvent("pointerdown", { button: 0, bubbles: true }),
    );
    editable.editor.view.dispatch(
      editable.editor.state.tr.setSelection(
        TextSelection.create(editable.editor.state.doc, reverseHead),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();

    expect(shell.classList.contains("pointer-selecting")).toBe(true);
    expect(scroller.scrollTop).toBe(frozenScrollTop);
    expect(shell.style.getPropertyValue("--print-carrier-offset")).toBe(
      frozenCarrierOffset,
    );

    window.dispatchEvent(new MouseEvent("pointerup", { button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();

    expect(shell.classList.contains("pointer-selecting")).toBe(false);
    expect(scroller.scrollTop).toBeGreaterThan(frozenScrollTop + 40);
    expect(scroller.scrollTop).toBeLessThanOrEqual(frozenScrollTop + 50);
    expect(
      Number.parseFloat(shell.style.getPropertyValue("--print-carrier-offset")),
    ).toBeCloseTo(15.96);
    expect(shell.classList.contains("print-carrier-visible")).toBe(
      true,
    );
    expect(paperWindow.style.transform).toBe("");
    unmount(component);
  });

  it("ignores non-selection pointers and clears a cancelled mouse selection", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "포인터 취소 뒤에도 선택할 수 있습니다.",
        experience: "typewriter",
      },
    });
    await tick();

    const shell = target.querySelector<HTMLElement>(".paper-editor-shell")!;
    const editable = target.querySelector<HTMLElement>(".ProseMirror")!;
    const touch = new MouseEvent("pointerdown", {
      button: 0,
      bubbles: true,
    });
    Object.defineProperty(touch, "pointerType", { value: "touch" });
    editable.dispatchEvent(touch);
    expect(shell.classList.contains("pointer-selecting")).toBe(false);

    editable.dispatchEvent(
      new MouseEvent("pointerdown", { button: 2, bubbles: true }),
    );
    expect(shell.classList.contains("pointer-selecting")).toBe(false);

    editable.dispatchEvent(
      new MouseEvent("pointerdown", { button: 0, bubbles: true }),
    );
    await tick();
    expect(shell.classList.contains("pointer-selecting")).toBe(true);

    window.dispatchEvent(new Event("pointercancel"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await tick();
    expect(shell.classList.contains("pointer-selecting")).toBe(false);

    editable.dispatchEvent(
      new MouseEvent("pointerdown", { button: 0, bubbles: true }),
    );
    await tick();
    expect(shell.classList.contains("pointer-selecting")).toBe(true);
    window.dispatchEvent(new MouseEvent("pointerup", { button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await tick();
    expect(shell.classList.contains("pointer-selecting")).toBe(false);
    unmount(component);
  });

  it("restarts the compact printing element for every rapid physical or IME character", async () => {
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
    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    const paperWindow = target.querySelector<HTMLElement>(".paper-window")!;
    mockStationaryTypewriterGeometry(target, editable);
    api!.focus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(target.querySelector(".typewriter-print-carrier")).not.toBeNull();
    expect(target.querySelector(".typewriter-element-yoke")).not.toBeNull();
    expect(target.querySelector(".typewriter-print-element")).not.toBeNull();
    expect(target.querySelector(".typewriter-strike-caret")).toBeNull();

    editable.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        code: "KeyA",
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const firstYoke = target.querySelector(
      ".typewriter-element-yoke.is-striking",
    );
    const firstGate = target.querySelector(".typewriter-ribbon-gate.is-striking");
    const firstElement = target.querySelector(".typewriter-print-element");
    expect(firstYoke).not.toBeNull();
    expect(firstGate).not.toBeNull();
    expect(firstElement).not.toBeNull();
    expect(shell.classList.contains("printing-element-striking")).toBe(true);
    expect(shell.style.getPropertyValue("--printing-element-rotate")).toBe(
      "-9deg",
    );
    expect(shell.style.getPropertyValue("--printing-element-tilt")).toBe("1deg");
    expect(paperWindow.style.transform).toBe("");

    await new Promise((resolve) => setTimeout(resolve, 80));

    editable.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Process",
        code: "KeyR",
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondYoke = target.querySelector(
      ".typewriter-element-yoke.is-striking",
    );
    const secondGate = target.querySelector(
      ".typewriter-ribbon-gate.is-striking",
    );
    const secondElement = target.querySelector(".typewriter-print-element");
    expect(secondYoke).not.toBe(firstYoke);
    expect(secondGate).not.toBe(firstGate);
    expect(secondElement).not.toBe(firstElement);
    expect(shell.style.getPropertyValue("--printing-element-rotate")).toBe(
      "-4deg",
    );
    expect(shell.style.getPropertyValue("--printing-element-tilt")).toBe("-1deg");

    await new Promise((resolve) => setTimeout(resolve, 40));
    await tick();
    expect(shell.style.getPropertyValue("--printing-element-rotate")).toBe(
      "-4deg",
    );
    expect(shell.style.getPropertyValue("--printing-element-tilt")).toBe("-1deg");

    await new Promise((resolve) => setTimeout(resolve, 80));
    await tick();
    expect(shell.style.getPropertyValue("--printing-element-rotate")).toBe(
      "0deg",
    );
    expect(shell.style.getPropertyValue("--printing-element-tilt")).toBe("0deg");
    expect(shell.classList.contains("print-carrier-stepping")).toBe(false);
    expect(shell.classList.contains("printing-element-striking")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 230));
    await tick();
    expect(shell.classList.contains("printing-element-striking")).toBe(false);
    expect(
      target.querySelector(".typewriter-element-yoke.is-striking"),
    ).toBeNull();
    expect(target.querySelector(".typewriter-element-yoke")).not.toBeNull();
    expect(target.querySelector(".typewriter-print-element")).not.toBeNull();

    editable.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: "가",
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      target.querySelector(".typewriter-element-yoke.is-striking"),
    ).not.toBeNull();
    expect(
      target.querySelector(".typewriter-ribbon-gate.is-striking"),
    ).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 230));
    await tick();
    editable.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: " ",
        code: "Space",
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();
    expect(shell.classList.contains("printing-element-striking")).toBe(false);
    expect(
      target.querySelector(".typewriter-element-yoke.is-striking"),
    ).toBeNull();

    editable.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    api!.setSelection(2, 2);
    window.dispatchEvent(new Event("pointerup"));
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
    expect(shell.classList.contains("printing-element-striking")).toBe(true);
    expect(
      target.querySelector(".typewriter-element-yoke.is-striking"),
    ).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 230));
    await tick();
    editable.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();
    expect(shell.classList.contains("print-carrier-returning")).toBe(true);
    expect(shell.classList.contains("line-feeding")).toBe(true);
    expect(shell.classList.contains("printing-element-striking")).toBe(false);
    expect(target.querySelector(".typewriter-print-carrier")).not.toBeNull();
    expect(paperWindow.style.transform).toBe("");

    editable.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Backspace",
        code: "Backspace",
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();
    expect(shell.classList.contains("printing-element-striking")).toBe(false);
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
    const editable = target.querySelector<HTMLElement>(".ProseMirror")! as
      HTMLElement & { editor: TiptapEditor };
    mockStationaryTypewriterGeometry(target, editable);
    api!.focus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(shell.classList.contains("typewriter-drafting")).toBe(false);
    expect(shell.classList.contains("typewriter-revision")).toBe(false);
    expect(shell.classList.contains("print-carrier-visible")).toBe(true);

    editable.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    api!.setSelection(6, 6);
    window.dispatchEvent(new Event("pointerup"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(shell.classList.contains("typewriter-revision")).toBe(false);
    expect(shell.classList.contains("print-carrier-visible")).toBe(true);
    expect(target.querySelector(".typewriter-carrier-track")).not.toBeNull();
    expect(target.querySelector(".typewriter-frame-rear")).not.toBeNull();
    expect(target.querySelector(".typewriter-machine.revision")).toBeNull();
    expect(target.querySelector(".typewriter-print-carrier")).not.toBeNull();
    expect(target.querySelector(".typewriter-strike-hammer")).toBeNull();
    expect(target.querySelector(".typewriter-revision-line")).toBeNull();

    typeCharacters(editable, "가");
    expect(api!.getContent()).toContain("가");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tick();
    expect(shell.classList.contains("printing-element-striking")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 230));
    editable.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }),
    );
    editable.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(shell.classList.contains("typewriter-revision")).toBe(false);
    expect(shell.classList.contains("printing-element-striking")).toBe(false);

    api!.setSelection(3, 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(shell.classList.contains("typewriter-drafting")).toBe(false);
    expect(shell.classList.contains("typewriter-revision")).toBe(false);
    expect(shell.classList.contains("print-carrier-visible")).toBe(true);
    typeCharacters(editable, "나");
    expect(api!.getContent()).toContain("나");

    editable.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await tick();
    expect(shell.classList.contains("print-carrier-returning")).toBe(true);
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
    expect(
      Number.parseFloat(shell.style.getPropertyValue("--print-carrier-offset")),
    ).toBeCloseTo(200 + headingEnd * 8 - 14.08 - (100 + 794 / 2));
    expect(paperWindow.style.transform).toBe("");

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

  it("keeps the stationary paper fixed through delayed and explicit free scroll", async () => {
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
    api!.focus();
    api!.setSelection(api!.getContent().length, api!.getContent().length);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();
    expect(scrollTop).toBeGreaterThan(0);
    expect(
      Number.parseFloat(shell.style.getPropertyValue("--print-carrier-offset")),
    ).toBeCloseTo(-224.04);
    expect(shell.classList.contains("print-carrier-visible")).toBe(true);
    expect(paperWindow.style.transform).toBe("");

    scroller.scrollTop = scrollTop + 80;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tick();
    expect(
      Number.parseFloat(shell.style.getPropertyValue("--print-carrier-offset")),
    ).toBeCloseTo(-224.04);
    expect(paperWindow.style.transform).toBe("");

    scroller.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 80, bubbles: true }),
    );
    await tick();
    expect(
      Number.parseFloat(shell.style.getPropertyValue("--print-carrier-offset")),
    ).toBeCloseTo(-224.04);
    expect(shell.classList.contains("print-carrier-visible")).toBe(false);
    expect(target.querySelector(".typewriter-print-carrier")).toBeNull();
    expect(paperWindow.style.transform).toBe("");
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
    window.dispatchEvent(new Event("pointerup"));
    await vi.waitFor(() =>
      expect(
        shell.classList.contains("print-carrier-visible"),
      ).toBe(true),
    );
    await tick();
    expect(shell.classList.contains("typewriter-revision")).toBe(false);
    expect(shell.classList.contains("typewriter-drafting")).toBe(false);
    expect(shell.classList.contains("print-carrier-visible")).toBe(true);
    expect(target.querySelector(".typewriter-carrier-track")).not.toBeNull();
    expect(target.querySelector(".typewriter-print-carrier")).not.toBeNull();
    expect(target.querySelector(".typewriter-strike-hammer")).toBeNull();
    expect(target.querySelector(".typewriter-revision-line")).toBeNull();

    typeCharacters(editable, "### ");
    await new Promise((resolve) => setTimeout(resolve, 40));
    await tick();

    expect(editable.querySelector(":scope > h3")?.textContent).toBe("");
    expect(editable.editor.state.selection.$from.parent.attrs.level).toBe(3);
    expect(editable.editor.state.selection.$from.parentOffset).toBe(0);
    expect(api!.getContent().replace(/\n+$/u, "")).toBe("### ");
    expect(shell.classList.contains("typewriter-drafting")).toBe(false);
    expect(target.querySelector(".typewriter-carrier-track")).not.toBeNull();
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

  it("retargets only the print carrier while the paper and platen stay fixed", async () => {
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
    const stack = target.querySelector<HTMLElement>(".paper-stack")!;
    vi.spyOn(editable.editor.view, "coordsAtPos").mockImplementation(() => {
      const left = editable.editor.state.selection.head <= 2 ? 520 : 280;
      const strikeBottom = Number.parseFloat(
        shell.style.getPropertyValue("--typewriter-strike-bottom"),
      );
      const center = 600 - strikeBottom;
      return {
        left,
        right: left,
        top: center - 10,
        bottom: center + 10,
      };
    });
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    machine.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    paperWindow.getBoundingClientRect = () => new DOMRect(100, 80, 794, 1123);
    stack.getBoundingClientRect = () => new DOMRect(100, 80, 794, 1123);
    api!.focus();
    api!.setSelection(api!.getContent().length, api!.getContent().length);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();
    const initialOffset = shell.style.getPropertyValue(
      "--print-carrier-offset",
    );
    expect(Number.parseFloat(initialOffset)).toBeCloseTo(-224.04);
    expect(shell.style.getPropertyValue("--paper-machine-origin")).toBe("97px");
    expect(paperWindow.style.transform).toBe("");
    expect(target.querySelector(".typewriter-print-carrier")).not.toBeNull();

    editable.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );
    api!.setSelection(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await tick();
    expect(shell.classList.contains("typewriter-revision")).toBe(false);
    expect(shell.classList.contains("typewriter-drafting")).toBe(false);
    expect(
      Number.parseFloat(shell.style.getPropertyValue("--print-carrier-offset")),
    ).toBeCloseTo(15.96);
    expect(shell.style.getPropertyValue("--print-carrier-offset")).not.toBe(
      initialOffset,
    );
    expect(shell.style.getPropertyValue("--paper-machine-origin")).toBe("97px");
    expect(paperWindow.style.transform).toBe("");
    expect(shell.classList.contains("print-carrier-visible")).toBe(true);
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
