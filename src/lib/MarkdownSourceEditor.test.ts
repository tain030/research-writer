// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorApi } from "./types";
import MarkdownSourceEditor from "./MarkdownSourceEditor.svelte";

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
    window.clearTimeout(handle),
  );
  class FakeResizeObserver {
    observe(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
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

describe("Markdown source editor", () => {
  it("exposes the shared editing and source-scroll API", async () => {
    let api: EditorApi | null = null;
    const changes: string[] = [];
    const target = document.createElement("div");
    target.style.height = "600px";
    document.body.append(target);
    const component = mount(MarkdownSourceEditor, {
      target,
      props: {
        value: "# 제목\n\n본문",
        onready: (value) => (api = value),
        onchange: (value) => changes.push(value),
      },
    });
    await tick();

    expect(api).not.toBeNull();
    api!.replaceRange(6, 8, "새 본문");
    await tick();

    expect(api!.getContent()).toBe("# 제목\n\n새 본문");
    expect(changes.at(-1)).toBe("# 제목\n\n새 본문");
    expect(api!.getScrollAnchor().source).toBe("source");
    expect(target.querySelector(".cm-lineNumbers")).not.toBeNull();

    api!.setSelection(api!.getContent().length, api!.getContent().length);
    api!.setGhostText(" 이어쓰기");
    await tick();
    expect(target.querySelector(".cm-ghost-text")?.textContent).toContain(
      "이어쓰기",
    );
    target.querySelector<HTMLElement>(".cm-content")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    await tick();
    expect(api!.getContent()).toBe("# 제목\n\n새 본문 이어쓰기");
    expect(target.querySelector(".cm-ghost-text")).toBeNull();
    unmount(component);
  });
});
