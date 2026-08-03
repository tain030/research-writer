// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "./+page.svelte";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(
      (query: string) =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(() => true),
        }) as unknown as MediaQueryList,
    ),
  );
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
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

describe("writing workspace toolbar", () => {
  it("keeps the paginated paper mounted and opens Markdown beside it", async () => {
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

    const formatting = topbar.querySelector(".formatting-toolbar")!;
    const documentTools = topbar.querySelector(".document-toolbar")!;
    expect(formatting.querySelector(".style-select")).not.toBeNull();
    expect(formatting.querySelector(".font-select")).not.toBeNull();
    expect(formatting.querySelector(".writing-style-toggle")).not.toBeNull();
    expect(documentTools.querySelector('[aria-label="삽입 메뉴"]')).not.toBeNull();
    expect(documentTools.querySelector('[aria-label="보기 메뉴"]')).not.toBeNull();
    expect(
      Array.from(
        documentTools.querySelectorAll<HTMLButtonElement>(":scope > button, :scope > .toolbar-menu-host > button"),
        (button) => button.getAttribute("aria-label"),
      ),
    ).toEqual([
      "삽입 메뉴",
      "보기 메뉴",
      "Markdown 원문을 옆에 열기",
      "인쇄 또는 PDF 저장",
    ]);

    const insert = topbar.querySelector<HTMLButtonElement>(
      'button[aria-label="삽입 메뉴"]',
    )!;
    insert.click();
    await tick();
    expect(target.querySelector('[data-menu="insert"]')?.textContent).toContain(
      "링크",
    );

    const view = topbar.querySelector<HTMLButtonElement>(
      'button[aria-label="보기 메뉴"]',
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

    expect(target.querySelector(".paper-pane .paper-editor-shell")).not.toBeNull();
    await vi.waitFor(
      () =>
        expect(
          target.querySelector(".companion-pane .source-shell"),
        ).not.toBeNull(),
      { timeout: 2_000 },
    );
    unmount(component);
  });

  it("switches between paired typewriter and literary writing styles", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(Page, { target });
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();

    const toggle = target.querySelector<HTMLButtonElement>(
      ".formatting-toolbar .writing-style-toggle",
    )!;
    const font = target.querySelector<HTMLSelectElement>(
      ".formatting-toolbar .font-select select",
    )!;
    const paper = target.querySelector<HTMLElement>(".paper-editor-shell")!;

    expect(font.value).toBe("NanumGothicCoding");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe(
      "문학형 집필 스타일로 전환",
    );
    expect(paper.classList.contains("writing-typewriter")).toBe(true);

    toggle.click();
    await tick();
    expect(font.value).toBe("MaruBuri");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe(
      "타자기형 집필 스타일로 전환",
    );
    expect(paper.classList.contains("writing-literary")).toBe(true);
    expect(
      JSON.parse(localStorage.getItem("research-writer.preferences")!)
        .fontFamily,
    ).toBe("MaruBuri");

    font.value = "NanumGothicCoding";
    font.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(paper.classList.contains("writing-typewriter")).toBe(true);
    unmount(component);
  });

  it("toggles the effective theme outside the tools panel", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(Page, { target });
    await tick();

    const theme = target.querySelector<HTMLButtonElement>(
      ".topbar-actions > .theme-toggle",
    )!;
    expect(theme.getAttribute("aria-label")).toBe("어두운 모드로 전환");
    expect(theme.getAttribute("aria-pressed")).toBe("false");

    theme.click();
    await tick();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(theme.getAttribute("aria-label")).toBe("밝은 모드로 전환");
    expect(
      JSON.parse(localStorage.getItem("research-writer.preferences")!).theme,
    ).toBe("dark");

    theme.click();
    await tick();
    expect(document.documentElement.dataset.theme).toBe("light");

    target
      .querySelector<HTMLButtonElement>(
        '.topbar-actions button[aria-controls="right-panel"]',
      )!
      .click();
    await tick();
    const settings = Array.from(
      target.querySelectorAll<HTMLButtonElement>("#right-panel .panel-tabs button"),
    ).find((button) => button.textContent?.trim() === "설정")!;
    settings.click();
    await tick();
    expect(target.querySelector('#right-panel option[value="system"]')).toBeNull();
    unmount(component);
  });

  it("uses the operating-system theme until the first explicit toggle", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(
        (query: string) =>
          ({
            matches: true,
            media: query,
            onchange: null,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            addListener: vi.fn(),
            removeListener: vi.fn(),
            dispatchEvent: vi.fn(() => true),
          }) as unknown as MediaQueryList,
      ),
    );
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(Page, { target });
    await tick();

    const theme = target.querySelector<HTMLButtonElement>(".theme-toggle")!;
    expect(document.documentElement.dataset.theme).toBe("system");
    expect(theme.getAttribute("aria-label")).toBe("밝은 모드로 전환");
    theme.click();
    await tick();
    expect(document.documentElement.dataset.theme).toBe("light");
    unmount(component);
  });
});
