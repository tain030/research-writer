import type { ManuscriptFitMode } from "./types";

export const MANUSCRIPT_PAPER_WIDTH = 960;
export const MANUSCRIPT_PAPER_HEIGHT = 1_200;
export const MANUSCRIPT_PAGE_BORDER = 2;
export const MANUSCRIPT_GUTTER_X = 32;
export const MANUSCRIPT_GUTTER_TOP = 24;
export const MANUSCRIPT_GUTTER_BOTTOM = 56;

const MIN_SAFE_SCALE = 0.1;

export interface ManuscriptViewport {
  width: number;
  height: number;
}

export function calculateManuscriptFitScale(
  viewport: ManuscriptViewport,
  mode: ManuscriptFitMode,
): number {
  const availableWidth = Math.max(
    1,
    viewport.width - MANUSCRIPT_GUTTER_X * 2 - MANUSCRIPT_PAGE_BORDER,
  );
  const availableHeight = Math.max(
    1,
    viewport.height -
      MANUSCRIPT_GUTTER_TOP -
      MANUSCRIPT_GUTTER_BOTTOM -
      MANUSCRIPT_PAGE_BORDER,
  );
  const widthScale = availableWidth / MANUSCRIPT_PAPER_WIDTH;
  const pageScale = Math.min(
    widthScale,
    availableHeight / MANUSCRIPT_PAPER_HEIGHT,
  );

  return Math.max(MIN_SAFE_SCALE, mode === "width" ? widthScale : pageScale);
}
