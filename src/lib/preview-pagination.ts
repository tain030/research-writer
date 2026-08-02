export interface PreviewBlock {
  html: string;
  sourceFrom: number;
  sourceTo: number;
  footnoteIds: string[];
}

export interface PreviewFootnote {
  id: string;
  html: string;
}

export interface PreviewPageContent {
  bodyHtml: string;
  footnoteHtml: string;
  sourceFrom: number;
  sourceTo: number;
}

export interface ExtractedPreviewDocument {
  blocks: PreviewBlock[];
  footnotes: Map<string, PreviewFootnote>;
}

export type PreviewFitCheck = (
  blocks: PreviewBlock[],
  footnotes: PreviewFootnote[],
  firstPage: boolean,
) => boolean;

export interface AsyncPaginationOptions {
  frameBudgetMs?: number;
  cancelled?: () => boolean;
  yieldControl?: () => Promise<void>;
}

export function extractPreviewDocument(html: string): ExtractedPreviewDocument {
  const template = document.createElement("template");
  template.innerHTML = html;
  const footnotes = new Map<string, PreviewFootnote>();
  const footnoteSection = template.content.querySelector<HTMLElement>(
    "[data-footnotes]",
  );
  if (footnoteSection) {
    for (const item of footnoteSection.querySelectorAll<HTMLElement>("li[id]")) {
      const id = normalizedFootnoteId(item.id);
      if (id) footnotes.set(id, { id, html: item.outerHTML });
    }
    footnoteSection.remove();
  }

  const blocks = Array.from(template.content.children).map((element, index) => {
    const from = finiteDataNumber(element.getAttribute("data-source-from"), index);
    const to = finiteDataNumber(element.getAttribute("data-source-to"), from);
    const footnoteIds = Array.from(
      element.querySelectorAll<HTMLAnchorElement>("a[data-footnote-ref]"),
    )
      .map((anchor) => normalizedFootnoteId(anchor.getAttribute("href") ?? ""))
      .filter((id, position, ids) => Boolean(id) && ids.indexOf(id) === position);
    return {
      html: element.outerHTML,
      sourceFrom: from,
      sourceTo: Math.max(from, to),
      footnoteIds,
    };
  });
  return { blocks, footnotes };
}

export function paginatePreviewBlocks(
  document: ExtractedPreviewDocument,
  fits: PreviewFitCheck,
): PreviewPageContent[] {
  const pages: PreviewPageContent[] = [];
  const placedFootnotes = new Set<string>();
  let blocks: PreviewBlock[] = [];
  let notes: PreviewFootnote[] = [];

  const finishPage = () => {
    if (!blocks.length && !notes.length && pages.length > 0) return;
    pages.push(toPage(blocks, notes));
    blocks = [];
    notes = [];
  };

  for (const [index, block] of document.blocks.entries()) {
    const newNotes = block.footnoteIds
      .filter((id) => !placedFootnotes.has(id))
      .map((id) => document.footnotes.get(id))
      .filter((note): note is PreviewFootnote => Boolean(note));
    const nextBlock = document.blocks[index + 1];
    if (nextBlock && headingBlock(block)) {
      const nextNotes = nextBlock.footnoteIds
        .filter(
          (id) =>
            !placedFootnotes.has(id) &&
            !newNotes.some((note) => note.id === id),
        )
        .map((id) => document.footnotes.get(id))
        .filter((note): note is PreviewFootnote => Boolean(note));
      const pairNotes = [...newNotes, ...nextNotes];
      if (
        fits([block, nextBlock], pairNotes, false) &&
        !fits(
          [...blocks, block, nextBlock],
          [...notes, ...pairNotes],
          pages.length === 0,
        )
      ) {
        finishPage();
      }
    }
    const candidateBlocks = [...blocks, block];
    const candidateNotes = [...notes, ...newNotes];
    if (
      blocks.length === 0 &&
      pages.length === 0 &&
      !fits(candidateBlocks, candidateNotes, true)
    ) {
      // The title block occupies real space on page one. If an indivisible
      // element cannot share that page, keep it intact on the next page.
      finishPage();
      blocks = [block];
      notes = newNotes;
    } else if (
      blocks.length > 0 &&
      !fits(candidateBlocks, candidateNotes, pages.length === 0)
    ) {
      finishPage();
      blocks = [block];
      notes = newNotes;
    } else {
      blocks = candidateBlocks;
      notes = candidateNotes;
    }
    for (const note of newNotes) placedFootnotes.add(note.id);
  }
  finishPage();
  return pages.length ? pages : [toPage([], [])];
}

export async function paginatePreviewBlocksAsync(
  document: ExtractedPreviewDocument,
  fits: PreviewFitCheck,
  options: AsyncPaginationOptions = {},
): Promise<PreviewPageContent[]> {
  const pages: PreviewPageContent[] = [];
  const placedFootnotes = new Set<string>();
  const frameBudgetMs = options.frameBudgetMs ?? 6;
  const yieldControl =
    options.yieldControl ??
    (() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  let frameStarted = performance.now();
  let blocks: PreviewBlock[] = [];
  let notes: PreviewFootnote[] = [];

  const finishPage = () => {
    if (!blocks.length && !notes.length && pages.length > 0) return;
    pages.push(toPage(blocks, notes));
    blocks = [];
    notes = [];
  };

  for (const [index, block] of document.blocks.entries()) {
    if (options.cancelled?.()) return [];
    const newNotes = block.footnoteIds
      .filter((id) => !placedFootnotes.has(id))
      .map((id) => document.footnotes.get(id))
      .filter((note): note is PreviewFootnote => Boolean(note));
    const nextBlock = document.blocks[index + 1];
    if (nextBlock && headingBlock(block)) {
      const nextNotes = nextBlock.footnoteIds
        .filter(
          (id) =>
            !placedFootnotes.has(id) &&
            !newNotes.some((note) => note.id === id),
        )
        .map((id) => document.footnotes.get(id))
        .filter((note): note is PreviewFootnote => Boolean(note));
      const pairNotes = [...newNotes, ...nextNotes];
      if (
        fits([block, nextBlock], pairNotes, false) &&
        !fits(
          [...blocks, block, nextBlock],
          [...notes, ...pairNotes],
          pages.length === 0,
        )
      ) {
        finishPage();
      }
    }
    const candidateBlocks = [...blocks, block];
    const candidateNotes = [...notes, ...newNotes];
    if (
      blocks.length === 0 &&
      pages.length === 0 &&
      !fits(candidateBlocks, candidateNotes, true)
    ) {
      finishPage();
      blocks = [block];
      notes = newNotes;
    } else if (
      blocks.length > 0 &&
      !fits(candidateBlocks, candidateNotes, pages.length === 0)
    ) {
      finishPage();
      blocks = [block];
      notes = newNotes;
    } else {
      blocks = candidateBlocks;
      notes = candidateNotes;
    }
    for (const note of newNotes) placedFootnotes.add(note.id);

    if (performance.now() - frameStarted >= frameBudgetMs) {
      await yieldControl();
      frameStarted = performance.now();
    }
  }
  finishPage();
  return pages.length ? pages : [toPage([], [])];
}

function toPage(
  blocks: PreviewBlock[],
  footnotes: PreviewFootnote[],
): PreviewPageContent {
  return {
    bodyHtml: blocks.map((block) => block.html).join(""),
    footnoteHtml: footnotes.map((note) => note.html).join(""),
    sourceFrom: blocks[0]?.sourceFrom ?? 0,
    sourceTo: blocks.at(-1)?.sourceTo ?? blocks[0]?.sourceTo ?? 0,
  };
}

function normalizedFootnoteId(value: string): string {
  return decodeURIComponent(value)
    .replace(/^#/, "")
    .replace(/^user-content-/, "")
    .replace(/^fnref-/, "")
    .replace(/^fn-/, "")
    .trim();
}

function headingBlock(block: PreviewBlock): boolean {
  return /^<h[1-6](?:\s|>)/i.test(block.html.trimStart());
}

function finiteDataNumber(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
