import { describe, expect, it } from "vitest";
import {
  applyTextEdits,
  conversationHistoryContext,
  createEditHunks,
  pendingProposalEdits,
  updateProposalAfterHunk,
} from "./ai-chat";
import type { AiChatMessage, AiEditProposal } from "./types";

describe("AI chat edit proposals", () => {
  it("creates canonical non-overlapping hunks and reconstructs the revision", () => {
    const original = "첫 문장입니다.\n\n둘째 문장은 조금 깁니다.";
    const revised = "첫 문장입니다.\n\n둘째 문장은 짧습니다.\n\n새 문단입니다.";
    const hunks = createEditHunks(original, revised, 7);
    const edits = hunks.map((hunk) => ({
      from: hunk.from - 7,
      to: hunk.to - 7,
      text: hunk.replacement,
    }));

    expect(hunks.length).toBeGreaterThan(0);
    expect(applyTextEdits(original, edits)).toBe(revised);
  });

  it("refuses stale text and rebases later hunks after an individual apply", () => {
    const proposal: AiEditProposal = {
      baseHash: "hash",
      baseText: "가 나 다",
      targetKind: "document",
      targetFrom: 0,
      targetTo: 5,
      revisedText: "가나다라마바사",
      hunks: [
        {
          id: "one",
          from: 1,
          to: 2,
          original: " ",
          replacement: "나다",
          status: "pending",
        },
        {
          id: "two",
          from: 3,
          to: 4,
          original: " ",
          replacement: "라마",
          status: "pending",
        },
      ],
    };

    expect(pendingProposalEdits(proposal, "가X나 다")).toBeNull();
    const rebased = updateProposalAfterHunk(proposal, "one", "applied");
    expect(rebased.hunks[1]).toMatchObject({ from: 4, to: 5 });
    expect(rebased.baseText).toBe("가나다나 다");
  });

  it("keeps all stored messages while bounding context sent to AI", () => {
    const messages = Array.from({ length: 15 }, (_, index): AiChatMessage => ({
      id: String(index),
      conversationId: "thread",
      role: index % 2 === 0 ? "user" : "assistant",
      content: `메시지 ${index}`,
      responseKind: null,
      metadata: {},
      createdAt: new Date(index * 1_000).toISOString(),
    }));
    const context = conversationHistoryContext(messages);

    expect(context.recentMessages).toHaveLength(12);
    expect(context.recentMessages[0]?.content).toContain("메시지 3");
    expect(context.historySummary).toContain("메시지 0");
  });
});
