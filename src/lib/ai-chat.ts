import { diffArrays, diffChars, diffLines } from "diff";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type {
  AiChatHistoryMessage,
  AiChatMessage,
  AiChatResponse,
  AiChatTargetKind,
  AiEditHunk,
  AiEditProposal,
  TextEdit,
} from "./types";

const RECENT_MESSAGE_LIMIT = 12;
const HISTORY_ITEM_LIMIT = 4_000;
const HISTORY_DIGEST_LIMIT = 8_000;

interface MarkdownPoint {
  offset?: number;
}

interface MarkdownPosition {
  start: MarkdownPoint;
  end: MarkdownPoint;
}

interface MarkdownNode {
  type: string;
  depth?: number;
  ordered?: boolean;
  position?: MarkdownPosition;
  children?: MarkdownNode[];
}

interface MarkdownBlock {
  index: number;
  from: number;
  to: number;
  node: MarkdownNode;
}

interface PairedRange {
  originalFrom: number;
  originalTo: number;
  revisedFrom: number;
  revisedTo: number;
  originalBlocks: Set<number>;
  revisedBlocks: Set<number>;
}

export interface AiEditReviewSegment {
  text: string;
  changed: boolean;
}

export interface AiEditReview {
  before: string;
  after: string;
  labels: string[];
  beforeSegments: AiEditReviewSegment[];
  afterSegments: AiEditReviewSegment[];
}

const markdownReviewParser = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkGfm)
  .use(remarkMath);

function appendLimited(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[…생략…]`;
}

function preserveTerminalLineBreaks(original: string, revised: string): string {
  if (!original.trim() || !revised.trim()) return revised;
  const originalEnding = /(?:\r?\n)+$/u.exec(original)?.[0] ?? "";
  return `${revised.replace(/(?:\r?\n)+$/u, "")}${originalEnding}`;
}

function markdownBlocks(source: string): MarkdownBlock[] {
  const tree = markdownReviewParser.parse(source) as MarkdownNode;
  return (tree.children ?? []).flatMap((node, index) => {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    return typeof from === "number" && typeof to === "number"
      ? [{ index, from, to, node }]
      : [];
  });
}

function lineDiffRanges(original: string, revised: string): PairedRange[] {
  const ranges: PairedRange[] = [];
  let originalOffset = 0;
  let revisedOffset = 0;
  let current: PairedRange | null = null;

  const begin = (): PairedRange => {
    current ??= {
      originalFrom: originalOffset,
      originalTo: originalOffset,
      revisedFrom: revisedOffset,
      revisedTo: revisedOffset,
      originalBlocks: new Set(),
      revisedBlocks: new Set(),
    };
    return current;
  };
  const flush = () => {
    if (current) ranges.push(current);
    current = null;
  };

  for (const part of diffLines(original, revised)) {
    if (part.removed) {
      const active = begin();
      originalOffset += part.value.length;
      active.originalTo = originalOffset;
      continue;
    }
    if (part.added) {
      const active = begin();
      revisedOffset += part.value.length;
      active.revisedTo = revisedOffset;
      continue;
    }
    flush();
    originalOffset += part.value.length;
    revisedOffset += part.value.length;
  }
  flush();
  return ranges;
}

function blockSignature(block: MarkdownBlock, source: string): string {
  return [
    block.node.type,
    block.node.depth ?? "",
    block.node.ordered ?? "",
    source.slice(block.from, block.to),
  ].join("\u0000");
}

function anchoredLineDiffRanges(
  original: string,
  revised: string,
  originalBlocks: MarkdownBlock[],
  revisedBlocks: MarkdownBlock[],
): PairedRange[] {
  const originalSignatures = originalBlocks.map((block) =>
    blockSignature(block, original),
  );
  const revisedSignatures = revisedBlocks.map((block) =>
    blockSignature(block, revised),
  );
  const anchors: Array<{ original: MarkdownBlock; revised: MarkdownBlock }> = [];
  let originalIndex = 0;
  let revisedIndex = 0;
  for (const part of diffArrays(originalSignatures, revisedSignatures)) {
    if (part.removed) {
      originalIndex += part.value.length;
      continue;
    }
    if (part.added) {
      revisedIndex += part.value.length;
      continue;
    }
    for (let index = 0; index < part.value.length; index += 1) {
      anchors.push({
        original: originalBlocks[originalIndex],
        revised: revisedBlocks[revisedIndex],
      });
      originalIndex += 1;
      revisedIndex += 1;
    }
  }

  const ranges: PairedRange[] = [];
  let originalOffset = 0;
  let revisedOffset = 0;
  const appendGap = (originalTo: number, revisedTo: number) => {
    const gapRanges = lineDiffRanges(
      original.slice(originalOffset, originalTo),
      revised.slice(revisedOffset, revisedTo),
    );
    for (const range of gapRanges) {
      ranges.push({
        ...range,
        originalFrom: range.originalFrom + originalOffset,
        originalTo: range.originalTo + originalOffset,
        revisedFrom: range.revisedFrom + revisedOffset,
        revisedTo: range.revisedTo + revisedOffset,
      });
    }
  };

  for (const anchor of anchors) {
    appendGap(anchor.original.from, anchor.revised.from);
    originalOffset = anchor.original.to;
    revisedOffset = anchor.revised.to;
  }
  appendGap(original.length, revised.length);
  return ranges;
}

function expandToMarkdownBlocks(
  range: PairedRange,
  originalBlocks: MarkdownBlock[],
  revisedBlocks: MarkdownBlock[],
): PairedRange {
  const expanded: PairedRange = {
    ...range,
    originalBlocks: new Set(),
    revisedBlocks: new Set(),
  };
  if (range.originalFrom < range.originalTo) {
    for (const block of originalBlocks) {
      if (block.from >= range.originalTo || block.to <= range.originalFrom) continue;
      expanded.originalBlocks.add(block.index);
      expanded.originalFrom = Math.min(expanded.originalFrom, block.from);
      expanded.originalTo = Math.max(expanded.originalTo, block.to);
    }
  }
  if (range.revisedFrom < range.revisedTo) {
    for (const block of revisedBlocks) {
      if (block.from >= range.revisedTo || block.to <= range.revisedFrom) continue;
      expanded.revisedBlocks.add(block.index);
      expanded.revisedFrom = Math.min(expanded.revisedFrom, block.from);
      expanded.revisedTo = Math.max(expanded.revisedTo, block.to);
    }
  }
  return expanded;
}

function setsOverlap(left: Set<number>, right: Set<number>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function intervalsOverlap(
  leftFrom: number,
  leftTo: number,
  rightFrom: number,
  rightTo: number,
): boolean {
  if (leftFrom === leftTo && rightFrom === rightTo) return leftFrom === rightFrom;
  if (leftFrom === leftTo) return leftFrom > rightFrom && leftFrom < rightTo;
  if (rightFrom === rightTo) return rightFrom > leftFrom && rightFrom < leftTo;
  return leftFrom < rightTo && rightFrom < leftTo;
}

function relatedRanges(left: PairedRange, right: PairedRange): boolean {
  return (
    setsOverlap(left.originalBlocks, right.originalBlocks) ||
    setsOverlap(left.revisedBlocks, right.revisedBlocks) ||
    intervalsOverlap(
      left.originalFrom,
      left.originalTo,
      right.originalFrom,
      right.originalTo,
    ) ||
    intervalsOverlap(
      left.revisedFrom,
      left.revisedTo,
      right.revisedFrom,
      right.revisedTo,
    )
  );
}

function mergeStructuralRanges(ranges: PairedRange[]): PairedRange[] {
  const parent = ranges.map((_, index) => index);
  const root = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left: number, right: number) => {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  for (let left = 0; left < ranges.length; left += 1) {
    for (let right = left + 1; right < ranges.length; right += 1) {
      if (relatedRanges(ranges[left], ranges[right])) union(left, right);
    }
  }

  const groups = new Map<number, PairedRange>();
  for (const [index, range] of ranges.entries()) {
    const key = root(index);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        ...range,
        originalBlocks: new Set(range.originalBlocks),
        revisedBlocks: new Set(range.revisedBlocks),
      });
      continue;
    }
    group.originalFrom = Math.min(group.originalFrom, range.originalFrom);
    group.originalTo = Math.max(group.originalTo, range.originalTo);
    group.revisedFrom = Math.min(group.revisedFrom, range.revisedFrom);
    group.revisedTo = Math.max(group.revisedTo, range.revisedTo);
    for (const block of range.originalBlocks) group.originalBlocks.add(block);
    for (const block of range.revisedBlocks) group.revisedBlocks.add(block);
  }
  return [...groups.values()].sort(
    (left, right) =>
      left.originalFrom - right.originalFrom || left.revisedFrom - right.revisedFrom,
  );
}

function rangesToHunks(
  ranges: PairedRange[],
  original: string,
  revised: string,
  absoluteOffset: number,
): AiEditHunk[] {
  return ranges.map((range, index) => ({
    id: `edit-${index + 1}`,
    from: absoluteOffset + range.originalFrom,
    to: absoluteOffset + range.originalTo,
    original: original.slice(range.originalFrom, range.originalTo),
    replacement: revised.slice(range.revisedFrom, range.revisedTo),
    status: "pending",
  }));
}

function reconstructFromHunks(original: string, hunks: AiEditHunk[], offset: number): string {
  let next = original;
  for (const hunk of [...hunks].sort((left, right) => right.from - left.from)) {
    const from = hunk.from - offset;
    const to = hunk.to - offset;
    next = `${next.slice(0, from)}${hunk.replacement}${next.slice(to)}`;
  }
  return next;
}

export function createEditHunks(
  original: string,
  revised: string,
  absoluteOffset = 0,
): AiEditHunk[] {
  if (original === revised) return [];

  const originalBlocks = markdownBlocks(original);
  const revisedBlocks = markdownBlocks(revised);
  const rawRanges = anchoredLineDiffRanges(
    original,
    revised,
    originalBlocks,
    revisedBlocks,
  );
  const expanded = rawRanges.map((range) =>
    expandToMarkdownBlocks(range, originalBlocks, revisedBlocks),
  );
  const structural = rangesToHunks(
    mergeStructuralRanges(expanded),
    original,
    revised,
    absoluteOffset,
  );
  if (reconstructFromHunks(original, structural, absoluteOffset) === revised) {
    return structural;
  }
  return rangesToHunks(rawRanges, original, revised, absoluteOffset);
}

export function createEditProposal(
  response: AiChatResponse,
  targetKind: AiChatTargetKind,
  targetFrom: number,
  original: string,
): AiEditProposal {
  const revisedText = preserveTerminalLineBreaks(original, response.revisedText);
  return {
    reviewVersion: 2,
    baseHash: response.originalHash,
    baseText: original,
    targetKind,
    targetFrom,
    targetTo: targetFrom + original.length,
    revisedText,
    hunks: createEditHunks(original, revisedText, targetFrom),
  };
}

export function normalizeEditProposal(proposal: AiEditProposal): AiEditProposal {
  if (
    proposal.reviewVersion === 2 ||
    proposal.hunks.some((hunk) => hunk.status !== "pending")
  ) {
    return proposal;
  }
  const revisedText = preserveTerminalLineBreaks(
    proposal.baseText,
    proposal.revisedText,
  );
  return {
    ...proposal,
    reviewVersion: 2,
    revisedText,
    hunks: createEditHunks(
      proposal.baseText,
      revisedText,
      proposal.targetFrom,
    ),
  };
}

function linePreview(proposal: AiEditProposal, hunk: AiEditHunk): {
  before: string;
  after: string;
} {
  if (proposal.reviewVersion === 2) {
    return { before: hunk.original, after: hunk.replacement };
  }
  const relativeFrom = Math.max(0, hunk.from - proposal.targetFrom);
  const relativeTo = Math.max(relativeFrom, hunk.to - proposal.targetFrom);
  const start = proposal.baseText.lastIndexOf("\n", relativeFrom - 1) + 1;
  const endAnchor =
    relativeTo > relativeFrom && proposal.baseText[relativeTo - 1] === "\n"
      ? relativeTo - 1
      : relativeTo;
  const nextBreak = proposal.baseText.indexOf("\n", endAnchor);
  const end = nextBreak < 0 ? proposal.baseText.length : nextBreak;
  const before = proposal.baseText.slice(start, end);
  const localFrom = relativeFrom - start;
  const localTo = relativeTo - start;
  return {
    before,
    after: `${before.slice(0, localFrom)}${hunk.replacement}${before.slice(localTo)}`,
  };
}

function nodeLabel(node: MarkdownNode): string {
  switch (node.type) {
    case "yaml":
      return "문서 정보";
    case "heading":
      return `${node.depth ?? 1}단계 제목`;
    case "blockquote":
      return "인용문";
    case "list":
      return node.ordered ? "번호 목록" : "목록";
    case "table":
      return "표";
    case "code":
      return "코드";
    case "math":
      return "수식";
    case "footnoteDefinition":
      return "각주";
    case "thematicBreak":
      return "구분선";
    case "paragraph":
      return "본문";
    default:
      return "Markdown";
  }
}

function reviewNodes(source: string): MarkdownNode[] {
  if (!source.trim()) return [];
  return ((markdownReviewParser.parse(source) as MarkdownNode).children ?? []);
}

function reviewLabels(before: string, after: string): string[] {
  if (!before.trim() && !after.trim()) {
    const beforeBreaks = before.match(/\n/gu)?.length ?? 0;
    const afterBreaks = after.match(/\n/gu)?.length ?? 0;
    if (beforeBreaks !== afterBreaks) {
      const difference = Math.abs(afterBreaks - beforeBreaks);
      return [`빈 줄 ${difference}개 ${afterBreaks > beforeBreaks ? "추가" : "삭제"}`];
    }
    return ["공백 정리"];
  }
  const beforeNodes = reviewNodes(before);
  const afterNodes = reviewNodes(after);
  if (
    beforeNodes.length === 1 &&
    afterNodes.length === 1 &&
    beforeNodes[0].type === "heading" &&
    afterNodes[0].type === "heading" &&
    beforeNodes[0].depth !== afterNodes[0].depth
  ) {
    return [`제목 단계 ${beforeNodes[0].depth ?? 1} → ${afterNodes[0].depth ?? 1}`];
  }
  const nodes = afterNodes.length ? afterNodes : beforeNodes;
  const labels = [...new Set(nodes.map(nodeLabel))];
  const action = !before.trim() ? "추가" : !after.trim() ? "삭제" : "수정";
  return (labels.length ? labels : ["Markdown"]).map((label) => `${label} ${action}`);
}

function reviewSegments(
  before: string,
  after: string,
): { before: AiEditReviewSegment[]; after: AiEditReviewSegment[] } {
  if (!before.trim() && !after.trim()) {
    const visibleWhitespace = (value: string): AiEditReviewSegment[] => {
      if (!value) return [];
      const lineBreaks = value.match(/\n/gu)?.length ?? 0;
      const horizontal = value.replace(/[\r\n]/gu, "").length;
      const descriptions = [
        lineBreaks ? `줄바꿈 ${lineBreaks}개` : "",
        horizontal ? `공백 ${horizontal}칸` : "",
      ].filter(Boolean);
      return [{ text: descriptions.join(" · "), changed: true }];
    };
    return {
      before: visibleWhitespace(before),
      after: visibleWhitespace(after),
    };
  }
  const parts = diffChars(before, after);
  return {
    before: parts
      .filter((part) => !part.added)
      .map((part) => ({ text: part.value, changed: Boolean(part.removed) })),
    after: parts
      .filter((part) => !part.removed)
      .map((part) => ({ text: part.value, changed: Boolean(part.added) })),
  };
}

export function createEditHunkReview(
  proposal: AiEditProposal,
  hunk: AiEditHunk,
): AiEditReview {
  const preview = linePreview(proposal, hunk);
  const segments = reviewSegments(preview.before, preview.after);
  return {
    ...preview,
    labels: reviewLabels(preview.before, preview.after),
    beforeSegments: segments.before,
    afterSegments: segments.after,
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
