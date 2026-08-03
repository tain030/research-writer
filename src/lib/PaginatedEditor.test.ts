// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PaginatedEditor from "./PaginatedEditor.svelte";
import type { EditorApi } from "./types";

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
    window.clearTimeout(handle),
  );
  class FakeResizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element): void {
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
  vi.unstubAllGlobals();
});

describe("paginated editorial editor", () => {
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
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(PaginatedEditor, {
      target,
      props: {
        value: "앞뒤",
        onready: (value) => (api = value),
        onchange: (value) => changes.push(value),
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
