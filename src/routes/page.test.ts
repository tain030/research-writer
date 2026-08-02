// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "./+page.svelte";

beforeEach(() => {
  localStorage.clear();
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
            contentRect: new DOMRect(0, 0, 1180, 820),
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

describe("writing workspace toolbar", () => {
  it("keeps the manuscript mounted and opens Markdown beside it", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(Page, { target });
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();

    const topbar = target.querySelector(".topbar")!;
    expect(topbar.querySelector('button[aria-label="링크"]')).toBeNull();
    expect(
      Array.from(topbar.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "AI",
      ),
    ).toBe(false);

    const insert = Array.from(topbar.querySelectorAll("button")).find((button) =>
      button.textContent?.startsWith("삽입"),
    )!;
    insert.click();
    await tick();
    expect(target.querySelector('[data-menu="insert"]')?.textContent).toContain(
      "링크",
    );

    const view = Array.from(topbar.querySelectorAll("button")).find((button) =>
      button.textContent?.startsWith("보기"),
    )!;
    view.click();
    await tick();
    const viewItems = Array.from(
      target.querySelectorAll<HTMLButtonElement>('[data-menu="view"] button'),
      (button) => button.textContent?.trim(),
    );
    expect(viewItems).toEqual(["페이지에 맞추기", "페이지 너비에 맞추기"]);

    target
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Markdown 원문을 옆에 열기"]',
      )!
      .click();

    expect(target.querySelector(".manuscript-pane .editor-host")).not.toBeNull();
    await vi.waitFor(
      () =>
        expect(
          target.querySelector(".companion-pane .source-shell"),
        ).not.toBeNull(),
      { timeout: 2_000 },
    );
    unmount(component);
  });
});
