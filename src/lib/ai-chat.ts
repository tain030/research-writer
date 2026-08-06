import { diffChars, diffLines } from "diff";
import type {
  AiChatHistoryMessage,
  AiChatMessage,
  AiChatResponse,
  AiChatTargetKind,
  AiEditHunk,
  AiEditProposal,
  TextEdit,
} from "./types";

const MERGE_UNCHANGED_LIMIT = 32;
const RECENT_MESSAGE_LIMIT = 12;
const HISTORY_ITEM_LIMIT = 4_000;
const HISTORY_DIGEST_LIMIT = 8_000;

function appendLimited(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[…생략…]`;
}

export function createEditHunks(
  original: string,
  revised: string,
  absoluteOffset = 0,
): AiEditHunk[] {
  if (original === revised) return [];

  const hunks: AiEditHunk[] = [];
  let sourceOffset = 0;
  let current:
    | { from: number; original: string; replacement: string }
    | null = null;

  const begin = () => {
    current ??= {
      from: sourceOffset,
      original: "",
      replacement: "",
    };
    return current;
  };
  const flush = () => {
    if (!current) return;
    const id = `edit-${hunks.length + 1}`;
    hunks.push({
      id,
      from: absoluteOffset + current.from,
      to: absoluteOffset + current.from + current.original.length,
      original: current.original,
      replacement: current.replacement,
      status: "pending",
    });
    current = null;
  };

  const parts =
    original.length + revised.length > 120_000
      ? diffLines(original, revised)
      : diffChars(original, revised);
  for (const part of parts) {
    if (part.added) {
      begin().replacement += part.value;
      continue;
    }
    if (part.removed) {
      begin().original += part.value;
      sourceOffset += part.value.length;
      continue;
    }

    if (
      current &&
      part.value.length <= MERGE_UNCHANGED_LIMIT &&
      !part.value.includes("\n\n")
    ) {
      const active = current as {
        from: number;
        original: string;
        replacement: string;
      };
      active.original += part.value;
      active.replacement += part.value;
      sourceOffset += part.value.length;
      continue;
    }
    flush();
    sourceOffset += part.value.length;
  }
  flush();
  return hunks;
}

export function createEditProposal(
  response: AiChatResponse,
  targetKind: AiChatTargetKind,
  targetFrom: number,
  original: string,
): AiEditProposal {
  return {
    baseHash: response.originalHash,
    baseText: original,
    targetKind,
    targetFrom,
    targetTo: targetFrom + original.length,
    revisedText: response.revisedText,
    hunks: createEditHunks(original, response.revisedText, targetFrom),
  };
}

export function pendingProposalEdits(
  proposal: AiEditProposal,
  content: string,
): TextEdit[] | null {
  if (!proposalMatchesContent(proposal, content)) return null;
  const pending = proposal.hunks.filter((hunk) => hunk.status === "pending");
  if (
    pending.some(
      (hunk) => content.slice(hunk.from, hunk.to) !== hunk.original,
    )
  ) {
    return null;
  }
  return pending.map((hunk) => ({
    from: hunk.from,
    to: hunk.to,
    text: hunk.replacement,
  }));
}

export function proposalMatchesContent(
  proposal: AiEditProposal,
  content: string,
): boolean {
  return (
    content.slice(proposal.targetFrom, proposal.targetTo) === proposal.baseText
  );
}

export function applyTextEdits(content: string, edits: TextEdit[]): string {
  let next = content;
  for (const edit of [...edits].sort((left, right) => right.from - left.from)) {
    next = `${next.slice(0, edit.from)}${edit.text}${next.slice(edit.to)}`;
  }
  return next;
}

export function updateProposalAfterHunk(
  proposal: AiEditProposal,
  hunkId: string,
  status: "applied" | "rejected",
): AiEditProposal {
  const selected = proposal.hunks.find((hunk) => hunk.id === hunkId);
  if (!selected || selected.status !== "pending") return proposal;
  const delta =
    status === "applied"
      ? selected.replacement.length - selected.original.length
      : 0;
  const relativeFrom = selected.from - proposal.targetFrom;
  const relativeTo = selected.to - proposal.targetFrom;
  const baseText =
    status === "applied"
      ? `${proposal.baseText.slice(0, relativeFrom)}${selected.replacement}${proposal.baseText.slice(relativeTo)}`
      : proposal.baseText;
  return {
    ...proposal,
    baseText,
    hunks: proposal.hunks.map((hunk) => {
      if (hunk.id === hunkId) return { ...hunk, status };
      if (status === "applied" && hunk.status === "pending" && hunk.from >= selected.to) {
        return {
          ...hunk,
          from: hunk.from + delta,
          to: hunk.to + delta,
        };
      }
      return hunk;
    }),
    targetTo: proposal.targetTo + delta,
  };
}

export function markPendingHunks(
  proposal: AiEditProposal,
  status: "applied" | "rejected" | "stale",
): AiEditProposal {
  return {
    ...proposal,
    hunks: proposal.hunks.map((hunk) =>
      hunk.status === "pending" ? { ...hunk, status } : hunk,
    ),
  };
}

function historyContent(message: AiChatMessage): string {
  const proposed = message.metadata.proposal?.revisedText;
  const suffix = proposed
    ? `\n\n[이 응답이 제안한 수정본]\n${appendLimited(proposed, 4_000)}`
    : "";
  return appendLimited(`${message.content}${suffix}`, HISTORY_ITEM_LIMIT);
}

export function conversationHistoryContext(messages: AiChatMessage[]): {
  recentMessages: AiChatHistoryMessage[];
  historySummary: string;
} {
  const usable = messages.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      message.content.trim(),
  );
  const recent = usable.slice(-RECENT_MESSAGE_LIMIT);
  const older = usable.slice(0, -RECENT_MESSAGE_LIMIT);
  const historySummary = appendLimited(
    older
      .map(
        (message) =>
          `${message.role === "user" ? "사용자" : "AI"}: ${appendLimited(
            message.content.trim(),
            500,
          )}`,
      )
      .join("\n"),
    HISTORY_DIGEST_LIMIT,
  );
  return {
    recentMessages: recent.map((message) => ({
      role: message.role,
      content: historyContent(message),
    })),
    historySummary,
  };
}
