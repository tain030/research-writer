// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AiChatPanel from "./AiChatPanel.svelte";
import type { AiConversation } from "./types";

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function conversation(): AiConversation {
  return {
    id: "conversation-1",
    documentPath: "/tmp/draft.md",
    title: "문장을 다듬어줘",
    targetKind: "selection",
    targetFrom: 4,
    targetTo: 8,
    targetText: "기존 문장",
    createdAt: "2026-08-06T00:00:00Z",
    updatedAt: "2026-08-06T00:00:01Z",
    messages: [
      {
        id: "assistant-1",
        conversationId: "conversation-1",
        role: "assistant",
        content: "더 명확한 문장으로 바꿨습니다.",
        responseKind: "edit",
        createdAt: "2026-08-06T00:00:01Z",
        metadata: {
          proposal: {
            baseHash: "hash",
            baseText: "기존 문장",
            targetKind: "selection",
            targetFrom: 4,
            targetTo: 9,
            revisedText: "새 문장",
            hunks: [
              {
                id: "edit-1",
                from: 4,
                to: 9,
                original: "기존 문장",
                replacement: "새 문장",
                status: "pending",
              },
            ],
          },
        },
      },
    ],
  };
}

function callbacks() {
  return {
    onclose: vi.fn(),
    onexpandedchange: vi.fn(),
    onnewconversation: vi.fn(),
    onselectconversation: vi.fn(),
    ondeleteconversation: vi.fn(),
    onnewselection: vi.fn(),
    oncleartarget: vi.fn(),
    onopenlink: vi.fn(),
    onsend: vi.fn(async () => true),
    onapplyhunk: vi.fn(),
    onrejecthunk: vi.fn(),
    onapplyall: vi.fn(),
    onrejectall: vi.fn(),
    onlogin: vi.fn(),
    onrefreshlogin: vi.fn(),
    onchoosestyle: vi.fn(),
    onautocompletechange: vi.fn(),
  };
}

describe("AI chat panel", () => {
  it("renders assistant Markdown, opens safe links, and clears a pinned target", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const handlers = callbacks();
    const current = conversation();
    current.messages[0].content = [
      "## 결론",
      "",
      "**핵심**입니다.",
      "",
      "- 항목",
      "",
      "[근거](https://example.com/source)",
    ].join("\n");
    const component = mount(AiChatPanel, {
      target,
      props: {
        account: {
          codexInstalled: true,
          codexVersion: "1.0",
          authenticated: true,
          accountType: "chatgpt",
          email: null,
          planType: "plus",
          message: "연결됨",
        },
        login: null,
        conversation: current,
        conversations: [current],
        busy: false,
        expanded: true,
        readOnly: false,
        pendingSelection: null,
        styleReferenceName: "",
        sourceCount: 0,
        autoComplete: false,
        ...handlers,
      },
    });
    await tick();

    expect(target.querySelector(".current-response h2")?.textContent).toBe("결론");
    expect(target.querySelector(".current-response strong")?.textContent).toBe("핵심");
    expect(target.querySelector(".current-response li")?.textContent).toBe("항목");
    target.querySelector<HTMLAnchorElement>(".current-response a")!.click();
    expect(handlers.onopenlink).toHaveBeenCalledWith(
      "https://example.com/source",
    );
    target
      .querySelector<HTMLButtonElement>(
        'button[aria-label="선택 영역 AI 문맥 해제"]',
      )!
      .click();
    expect(handlers.oncleartarget).toHaveBeenCalledOnce();
    unmount(component);
  });

  it("keeps a changed selection explicit instead of silently retargeting", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const handlers = callbacks();
    const current = conversation();
    const component = mount(AiChatPanel, {
      target,
      props: {
        account: {
          codexInstalled: true,
          codexVersion: "1.0",
          authenticated: true,
          accountType: "chatgpt",
          email: null,
          planType: "plus",
          message: "연결됨",
        },
        login: null,
        conversation: current,
        conversations: [current],
        busy: false,
        expanded: true,
        readOnly: false,
        pendingSelection: {
          from: 20,
          to: 25,
          text: "새 선택",
          line: 2,
        },
        styleReferenceName: "",
        sourceCount: 0,
        autoComplete: false,
        ...handlers,
      },
    });
    await tick();

    expect(target.textContent).toContain("새 선택 사용");
    target
      .querySelector<HTMLButtonElement>(".new-selection-button")!
      .click();
    expect(handlers.onnewselection).toHaveBeenCalledOnce();
    unmount(component);
  });

  it("renders reviewable hunks and delegates individual or atomic apply", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const handlers = callbacks();
    const current = conversation();
    const component = mount(AiChatPanel, {
      target,
      props: {
        account: {
          codexInstalled: true,
          codexVersion: "1.0",
          authenticated: true,
          accountType: "chatgpt",
          email: null,
          planType: "plus",
          message: "연결됨",
        },
        login: null,
        conversation: current,
        conversations: [current],
        busy: false,
        expanded: true,
        readOnly: false,
        pendingSelection: null,
        styleReferenceName: "",
        sourceCount: 0,
        autoComplete: false,
        ...handlers,
      },
    });
    await tick();

    expect(target.querySelector(".diff-row.before code")?.textContent).toBe("기존 문장");
    expect(target.querySelector(".diff-row.after code")?.textContent).toBe("새 문장");
    expect(target.querySelector(".hunk-labels")?.textContent).toContain("본문 수정");
    const applyButtons = Array.from(
      target.querySelectorAll<HTMLButtonElement>(".proposal-card button.apply"),
    );
    applyButtons.at(-1)!.click();
    expect(handlers.onapplyhunk).toHaveBeenCalledWith("assistant-1", "edit-1");
    applyButtons[0]!.click();
    expect(handlers.onapplyall).toHaveBeenCalledWith("assistant-1");
    unmount(component);
  });

  it("shows only the current turn until the history view is opened", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const handlers = callbacks();
    const current = conversation();
    current.messages.unshift(
      {
        id: "user-old",
        conversationId: current.id,
        role: "user",
        content: "예전 질문",
        responseKind: null,
        metadata: {},
        createdAt: "2026-08-05T00:00:00Z",
      },
      {
        id: "assistant-old",
        conversationId: current.id,
        role: "assistant",
        content: "예전 답변",
        responseKind: "answer",
        metadata: {},
        createdAt: "2026-08-05T00:00:01Z",
      },
      {
        id: "user-current",
        conversationId: current.id,
        role: "user",
        content: "현재 질문",
        responseKind: null,
        metadata: {},
        createdAt: "2026-08-06T00:00:00Z",
      },
    );
    const component = mount(AiChatPanel, {
      target,
      props: {
        account: {
          codexInstalled: true,
          codexVersion: "1.0",
          authenticated: true,
          accountType: "chatgpt",
          email: null,
          planType: "plus",
          message: "연결됨",
        },
        login: null,
        conversation: current,
        conversations: [current],
        busy: false,
        expanded: true,
        readOnly: false,
        pendingSelection: null,
        styleReferenceName: "",
        sourceCount: 0,
        autoComplete: false,
        ...handlers,
      },
    });
    await tick();

    expect(target.querySelector(".current-task")?.textContent).toContain(
      "현재 질문",
    );
    expect(target.querySelector(".current-task")?.textContent).not.toContain(
      "예전 질문",
    );
    expect(target.textContent).not.toContain("원고를 보면서 이야기하세요");
    expect(target.textContent).not.toContain("Enter 전송");
    target
      .querySelector<HTMLButtonElement>('button[aria-label="AI 대화 기록"]')!
      .click();
    await tick();
    expect(target.querySelector(".history-transcript")?.textContent).toContain(
      "예전 질문",
    );
    expect(target.querySelector(".history-transcript")?.textContent).toContain(
      "현재 질문",
    );
    unmount(component);
  });

  it("expands the compact surface when a prompt is submitted", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const handlers = callbacks();
    const current = conversation();
    current.messages = [];
    const component = mount(AiChatPanel, {
      target,
      props: {
        account: {
          codexInstalled: true,
          codexVersion: "1.0",
          authenticated: true,
          accountType: "chatgpt",
          email: null,
          planType: "plus",
          message: "연결됨",
        },
        login: null,
        conversation: current,
        conversations: [current],
        busy: false,
        expanded: false,
        readOnly: false,
        pendingSelection: null,
        styleReferenceName: "",
        sourceCount: 0,
        autoComplete: false,
        ...handlers,
      },
    });
    await tick();

    const input = target.querySelector<HTMLTextAreaElement>(
      ".floating-composer textarea",
    )!;
    input.value = "더 명확하게 고쳐줘";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    target
      .querySelector<HTMLFormElement>(".floating-composer")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() =>
      expect(handlers.onsend).toHaveBeenCalledWith("더 명확하게 고쳐줘"),
    );
    expect(handlers.onexpandedchange).toHaveBeenCalledWith(true);
    unmount(component);
  });
});
