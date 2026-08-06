import { describe, expect, it } from "vitest";
import {
  applyTextEdits,
  conversationHistoryContext,
  createEditHunkReview,
  createEditHunks,
  normalizeEditProposal,
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

  it("keeps complete Markdown headings visible in structural review hunks", () => {
    const original = [
      "### 2-2.",
      "",
      "",
      "",
      "## 4. 비교 기준",
      "",
    ].join("\n");
    const revised = [
      "### 2-2. 온오프램프의 작동 구조",
      "",
      "> 작동 흐름 설명",
      "",
      "### 2-3. 핵심 사업 모델과 용어",
      "",
      "> 비교에 필요한 개념",
      "",
      "",
      "",
      "## 4. 비교 기준",
      "",
    ].join("\n");
    const hunks = createEditHunks(original, revised);

    expect(
      hunks.find((hunk) => hunk.replacement.includes("2-2"))?.replacement,
    ).toContain("### 2-2. 온오프램프의 작동 구조");
    expect(
      hunks.find((hunk) => hunk.replacement.includes("2-3"))?.replacement,
    ).toContain("### 2-3. 핵심 사업 모델과 용어");
    expect(
      hunks.some((hunk) => hunk.replacement.startsWith("# 2-3")),
    ).toBe(false);
    expect(
      hunks.every(
        (hunk) =>
          !hunk.original.includes("## 4. 비교 기준") &&
          !hunk.replacement.includes("## 4. 비교 기준"),
      ),
    ).toBe(true);
    expect(
      applyTextEdits(
        original,
        hunks.map((hunk) => ({
          from: hunk.from,
          to: hunk.to,
          text: hunk.replacement,
        })),
      ),
    ).toBe(revised);
  });

  it("keeps paired Markdown delimiters in one atomic block", () => {
    const original = "```ts\n같은 코드\n```\n";
    const revised = "~~~ts\n같은 코드\n~~~\n";
    const hunks = createEditHunks(original, revised);

    expect(hunks).toHaveLength(1);
    expect(hunks[0].original).toBe(original);
    expect(hunks[0].replacement).toBe(revised);
  });

  it("produces the same revision through individual and all-at-once applies", () => {
    const original = "### 제목\n\n첫 문단입니다.\n\n- 기존 항목\n";
    const revised = "### 새 제목\n\n고친 문단입니다.\n\n- 새 항목\n- 추가 항목\n";
    const hunks = createEditHunks(original, revised);
    let proposal: AiEditProposal = {
      reviewVersion: 2,
      baseHash: "hash",
      baseText: original,
      targetKind: "document",
      targetFrom: 0,
      targetTo: original.length,
      revisedText: revised,
      hunks,
    };
    let individual = original;
    for (const id of hunks.map((hunk) => hunk.id)) {
      const hunk = proposal.hunks.find((item) => item.id === id)!;
      individual = applyTextEdits(individual, [
        { from: hunk.from, to: hunk.to, text: hunk.replacement },
      ]);
      proposal = updateProposalAfterHunk(proposal, id, "applied");
    }
    const allAtOnce = applyTextEdits(
      original,
      hunks.map((hunk) => ({
        from: hunk.from,
        to: hunk.to,
        text: hunk.replacement,
      })),
    );

    expect(individual).toBe(revised);
    expect(allAtOnce).toBe(revised);
    expect(proposal.baseText).toBe(revised);
  });

  it("normalizes untouched legacy proposals and previews their complete line", () => {
    const baseText = "### 2-2.\n\n## 4. 비교 기준\n";
    const revisedText = "### 2-2. 작동 구조\n\n## 4. 비교 기준\n";
    const proposal: AiEditProposal = {
      baseHash: "hash",
      baseText,
      targetKind: "document",
      targetFrom: 0,
      targetTo: baseText.length,
      revisedText,
      hunks: [
        {
          id: "legacy",
          from: 8,
          to: 8,
          original: "",
          replacement: " 작동 구조",
          status: "pending",
        },
      ],
    };
    const review = createEditHunkReview(proposal, proposal.hunks[0]);
    const normalized = normalizeEditProposal(proposal);

    expect(review.before).toBe("### 2-2.");
    expect(review.after).toBe("### 2-2. 작동 구조");
    expect(review.labels).toContain("3단계 제목 수정");
    expect(normalized.reviewVersion).toBe(2);
    expect(normalized.hunks[0].original).toContain("### 2-2.");
    expect(normalized.hunks[0].replacement).toContain("### 2-2. 작동 구조");
  });

  it("preserves the document terminal line breaks instead of proposing whitespace noise", () => {
    const proposal: AiEditProposal = {
      baseHash: "hash",
      baseText: "기존 본문\n\n",
      targetKind: "document",
      targetFrom: 0,
      targetTo: 7,
      revisedText: "수정 본문\n",
      hunks: [],
    };
    const normalized = normalizeEditProposal(proposal);

    expect(normalized.revisedText).toBe("수정 본문\n\n");
    expect(normalized.hunks).toHaveLength(1);
    expect(normalized.hunks[0]).toMatchObject({
      original: "기존 본문\n",
      replacement: "수정 본문\n",
    });
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
