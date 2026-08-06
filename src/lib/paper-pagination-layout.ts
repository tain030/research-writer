import type { PaperPageBreak } from "./paper-pagination";

export interface PageBreakOpportunity {
  /** ProseMirror position immediately after the last character on a visual line. */
  pos: number;
  /** Height consumed from the beginning of this block through that line. */
  consumed: number;
}

export interface MeasuredPageBlock {
  /** ProseMirror position immediately before this top-level block. */
  pos: number;
  /** Visual height through the final complete line or atomic element edge. */
  contentHeight: number;
  /** Rendered whitespace between this content and the following block. */
  afterGap: number;
  kind: "heading" | "breakable" | "atomic";
  /** At most the first two visual lines, used to keep a heading with its text. */
  leadHeight: number;
  opportunities: PageBreakOpportunity[];
  /** Lazily resolves the last visual line that fits the current sheet. */
  breakAtOrBefore?: (
    segmentStart: number,
    available: number,
  ) => PageBreakOpportunity | undefined;
}

export interface PaperPageMetrics {
  body: number;
  top: number;
  bottom: number;
  epsilon?: number;
}

export interface PageBlockGeometryInput {
  boxHeight: number;
  visualContentHeight?: number | null;
  nextBlockOffset?: number | null;
  marginBottom?: number;
}

export interface PageBlockGeometry {
  contentHeight: number;
  afterGap: number;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Separate visible content from trailing flow space before pagination. */
export function resolvePageBlockGeometry({
  boxHeight,
  visualContentHeight,
  nextBlockOffset,
  marginBottom = 0,
}: PageBlockGeometryInput): PageBlockGeometry {
  const safeBoxHeight = finiteNonNegative(boxHeight);
  const contentHeight =
    visualContentHeight !== null &&
    visualContentHeight !== undefined &&
    Number.isFinite(visualContentHeight) &&
    visualContentHeight > 0
      ? visualContentHeight
      : safeBoxHeight;
  const flowHeight =
    nextBlockOffset !== null &&
    nextBlockOffset !== undefined &&
    Number.isFinite(nextBlockOffset) &&
    nextBlockOffset > 0
      ? Math.max(contentHeight, safeBoxHeight, nextBlockOffset)
      : Math.max(
          contentHeight,
          safeBoxHeight + finiteNonNegative(marginBottom),
        );
  return {
    contentHeight,
    afterGap: Math.max(0, flowHeight - contentHeight),
  };
}

/**
 * Plan paper gaps from measured visual lines.
 *
 * An unmeasurable or over-sized block deliberately stays visible in continuous
 * flow. A slightly imperfect sheet is safer than manufacturing blank pages or
 * hiding manuscript content behind stale, multi-page spacers.
 */
export function planPaperPageBreaks(
  blocks: MeasuredPageBlock[],
  metrics: PaperPageMetrics,
): PaperPageBreak[] {
  const body = finiteNonNegative(metrics.body);
  if (body === 0) return [];
  const top = finiteNonNegative(metrics.top);
  const bottom = finiteNonNegative(metrics.bottom);
  const epsilon = Math.max(0.01, finiteNonNegative(metrics.epsilon ?? 0.75));
  const maximumRest = body + top + bottom;
  const minimumFilledPage = body * 0.25;
  const result: PaperPageBreak[] = [];
  let used = 0;

  const pageRemainder = (contentRest: number): number =>
    Math.max(0, Math.min(maximumRest, top + bottom + contentRest));

  const appendBreak = (pos: number, contentRest: number): boolean => {
    if (!Number.isInteger(pos) || pos <= 0) return false;
    const restPx = pageRemainder(contentRest);
    const previous = result.at(-1);
    if (previous?.pos === pos) {
      previous.restPx = Math.min(previous.restPx, restPx);
      return false;
    }
    if (previous && previous.pos > pos) return false;
    result.push({ pos, restPx });
    return true;
  };

  const rolledUsage = (height: number): number => {
    if (height <= body + epsilon) return height;
    const remainder = height % body;
    return remainder <= epsilon ? body : remainder;
  };

  const applyFollowingGap = (
    block: MeasuredPageBlock,
    next: MeasuredPageBlock | undefined,
  ): void => {
    if (!next) return;
    const afterGap = finiteNonNegative(block.afterGap);
    if (afterGap <= epsilon) return;
    const withGap = used + afterGap;
    if (withGap <= body + epsilon) {
      used = withGap;
      return;
    }

    // The final line already fits. Keep it on this sheet and place the page
    // transition before the next block, compensating for the whitespace that
    // the browser has already rendered ahead of the spacer widget.
    const contentRest = body - withGap;
    if (
      used <= body + epsilon &&
      top + bottom + contentRest >= -epsilon &&
      appendBreak(next.pos, contentRest)
    ) {
      used = 0;
      return;
    }
    used = rolledUsage(withGap);
  };

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const next = blocks[index + 1];
    const contentHeight = finiteNonNegative(block.contentHeight);

    if (contentHeight <= epsilon) {
      applyFollowingGap(block, next);
      continue;
    }

    if (block.kind === "heading") {
      const nextLead = next
        ? Math.min(
            finiteNonNegative(next.leadHeight),
            finiteNonNegative(next.contentHeight),
          )
        : 0;
      const keptHeight =
        contentHeight + finiteNonNegative(block.afterGap) + nextLead;
      if (
        used > epsilon &&
        used + keptHeight > body + epsilon &&
        keptHeight <= body + epsilon &&
        appendBreak(block.pos, body - used)
      ) {
        used = 0;
      }
      used = rolledUsage(used + contentHeight);
      applyFollowingGap(block, next);
      continue;
    }

    if (block.kind === "breakable") {
      const opportunities = block.opportunities
        .filter(
          (entry) =>
            Number.isInteger(entry.pos) &&
            entry.pos > 0 &&
            Number.isFinite(entry.consumed) &&
            entry.consumed > epsilon &&
            entry.consumed < contentHeight - epsilon,
        )
        .sort(
          (left, right) =>
            left.consumed - right.consumed || left.pos - right.pos,
        );
      let segmentStart = 0;
      let failedOpen = false;

      while (used + contentHeight - segmentStart > body + epsilon) {
        const available = Math.max(0, body - used);
        const resolved = block.breakAtOrBefore?.(segmentStart, available);
        let candidate =
          resolved &&
          Number.isInteger(resolved.pos) &&
          resolved.pos > 0 &&
          Number.isFinite(resolved.consumed) &&
          resolved.consumed - segmentStart > epsilon &&
          resolved.consumed - segmentStart <= available + epsilon &&
          resolved.consumed < contentHeight - epsilon
            ? resolved
            : undefined;
        for (const opportunity of opportunities) {
          const segmentHeight = opportunity.consumed - segmentStart;
          if (segmentHeight <= epsilon) continue;
          if (segmentHeight > available + epsilon) break;
          if (!candidate || opportunity.consumed > candidate.consumed) {
            candidate = opportunity;
          }
        }

        if (candidate) {
          const consumed = candidate.consumed - segmentStart;
          if (!appendBreak(candidate.pos, available - consumed)) {
            failedOpen = true;
            break;
          }
          segmentStart = candidate.consumed;
          used = 0;
          continue;
        }

        if (
          used > epsilon &&
          segmentStart === 0 &&
          appendBreak(block.pos, body - used)
        ) {
          used = 0;
          continue;
        }

        failedOpen = true;
        break;
      }

      if (failedOpen) {
        used = rolledUsage(used + contentHeight - segmentStart);
      } else {
        used += contentHeight - segmentStart;
      }
      applyFollowingGap(block, next);
      continue;
    }

    // Atomic blocks move as a unit only when they fit on a fresh page. A table
    // or other block taller than the printable body remains in fail-open flow.
    if (
      used > epsilon &&
      used >= minimumFilledPage &&
      used + contentHeight > body + epsilon &&
      contentHeight <= body + epsilon &&
      appendBreak(block.pos, body - used)
    ) {
      used = 0;
    }
    used = rolledUsage(used + contentHeight);
    applyFollowingGap(block, next);
  }

  return result;
}
