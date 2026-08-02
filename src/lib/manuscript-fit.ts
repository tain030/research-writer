import type { ManuscriptFitMode } from "./types";

export const MANUSCRIPT_PAPER_WIDTH = 960;
export const MANUSCRIPT_PAPER_HEIGHT = 1_200;
export const MANUSCRIPT_PAGE_BORDER = 2;
export const MANUSCRIPT_GUTTER_X = 32;
export const MANUSCRIPT_GUTTER_TOP = 24;
export const MANUSCRIPT_GUTTER_BOTTOM = 56;
export const PAGE_FIT_INSET = 16;
export const PAGE_FIT_SAFETY = 2;

const MIN_SAFE_SCALE = 0.1;
const MIN_CONTAINED_SCALE = 0.001;

export interface ManuscriptViewport {
  width: number;
  height: number;
}

export interface PageFitMetrics {
  viewport: ManuscriptViewport;
  page: ManuscriptViewport;
  inset?: number;
  safety?: number;
}

export function calculateContainedPageScale({
  viewport,
  page,
  inset = PAGE_FIT_INSET,
  safety = PAGE_FIT_SAFETY,
}: PageFitMetrics): number {
  const availableWidth = Math.max(
    0,
    viewport.width - inset * 2 - safety,
  );
  const availableHeight = Math.max(
    0,
    viewport.height - inset * 2 - safety,
  );
  return Math.max(
    MIN_CONTAINED_SCALE,
    Math.min(availableWidth / page.width, availableHeight / page.height),
  );
}

export function calculateManuscriptFitScale(
  viewport: ManuscriptViewport,
  mode: ManuscriptFitMode,
): number {
  if (mode === "page") {
    return calculateContainedPageScale({
      viewport,
      page: {
        width: MANUSCRIPT_PAPER_WIDTH,
        height: MANUSCRIPT_PAPER_HEIGHT,
      },
    });
  }
  const availableWidth = Math.max(
    1,
    viewport.width - MANUSCRIPT_GUTTER_X * 2 - MANUSCRIPT_PAGE_BORDER,
  );
  const widthScale = availableWidth / MANUSCRIPT_PAPER_WIDTH;
  return Math.max(MIN_SAFE_SCALE, widthScale);
}
