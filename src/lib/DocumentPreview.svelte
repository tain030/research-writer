<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { onDestroy, onMount, tick } from "svelte";
  import "katex/dist/katex.min.css";
  import {
    parseManuscript,
    type ParsedManuscript,
  } from "./manuscript-document";
  import {
    extractPreviewDocument,
    paginatePreviewBlocksAsync,
    type ExtractedPreviewDocument,
    type PreviewBlock,
    type PreviewFootnote,
    type PreviewPageContent,
  } from "./preview-pagination";
  import type {
    PreviewRenderRequest,
    PreviewRenderResponse,
  } from "./preview-render.worker";
  import { renderManuscriptHtml } from "./render-manuscript";
  import type { ManuscriptFitMode, ScrollAnchor } from "./types";

  interface AssetData {
    relativePath: string;
    mimeType: string;
    dataUrl: string;
    sizeBytes: number;
  }

  export interface PreviewApi {
    getScrollAnchor: () => ScrollAnchor;
    scrollToAnchor: (anchor: ScrollAnchor) => void;
    awaitLayout: () => Promise<void>;
  }

  interface Props {
    content: string;
    documentPath: string;
    fallbackTitle?: string;
    fontFamily?: string;
    fitMode?: ManuscriptFitMode;
    desktop?: boolean;
    onlink?: (url: string) => void;
    onready?: (api: PreviewApi | null) => void;
    onscrollanchor?: (anchor: ScrollAnchor) => void;
  }

  let {
    content,
    documentPath,
    fallbackTitle = "제목 없는 원고",
    fontFamily = "Pretendard",
    fitMode = "width",
    desktop = false,
    onlink,
    onready,
    onscrollanchor,
  }: Props = $props();

  const A4_WIDTH_PX = 793.7;
  const A4_HEIGHT_PX = 1122.6;
  let scroller: HTMLDivElement;
  let measureInner: HTMLDivElement;
  let measureBody: HTMLDivElement;
  let measureNotes: HTMLOListElement;
  let measureHeader: HTMLElement;
  let viewportWidth = $state(A4_WIDTH_PX);
  let viewportHeight = $state(A4_HEIGHT_PX);
  let viewportObserver: ResizeObserver | null = null;
  let renderWorker: Worker | null = null;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let layoutTimer: ReturnType<typeof setTimeout> | null = null;
  let scrollFrame: number | null = null;
  let mounted = false;
  let hasRendered = false;
  let renderRevision = 0;
  let layoutRevision = 0;
  let assetLoadId = 0;
  let renderBusy = $state(false);
  let assetBusy = $state(false);
  let layoutBusy = $state(false);
  let assetUrls = $state<Record<string, string>>({});
  let rendered = $state("");
  let manuscript = $state<ParsedManuscript>(
    parseManuscript("", "제목 없는 원고", { diagnostics: false }),
  );
  let pages = $state<PreviewPageContent[]>([
    { bodyHtml: "", footnoteHtml: "", sourceFrom: 0, sourceTo: 0 },
  ]);
  let layoutWaiters: Array<() => void> = [];
  let previewScale = $derived(
    calculatePreviewScale(viewportWidth, viewportHeight, fitMode),
  );

  function calculatePreviewScale(
    width: number,
    height: number,
    mode: ManuscriptFitMode,
  ): number {
    const widthScale = (Math.max(240, width) - 30) / A4_WIDTH_PX;
    if (mode === "width") return Math.max(0.28, Math.min(1.35, widthScale));
    const heightScale = (Math.max(300, height) - 64) / A4_HEIGHT_PX;
    return Math.max(0.28, Math.min(1, widthScale, heightScale));
  }

  function startRenderWorker(): void {
    if (typeof Worker === "undefined") return;
    try {
      renderWorker = new Worker(
        new URL("./preview-render.worker.ts", import.meta.url),
        { type: "module", name: "completed-document-renderer" },
      );
      renderWorker.onmessage = (event: MessageEvent<PreviewRenderResponse>) => {
        if (event.data.revision !== renderRevision) return;
        renderBusy = false;
        hasRendered = true;
        manuscript = event.data.manuscript;
        rendered = event.data.html;
      };
      renderWorker.onerror = () => {
        renderWorker?.terminate();
        renderWorker = null;
        renderSynchronously(renderRevision);
      };
    } catch {
      renderWorker = null;
    }
  }

  function scheduleRender(): void {
    if (!mounted) return;
    if (renderTimer) clearTimeout(renderTimer);
    if (layoutTimer) {
      clearTimeout(layoutTimer);
      layoutTimer = null;
    }
    layoutRevision += 1;
    renderBusy = true;
    layoutBusy = true;
    const revision = ++renderRevision;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      const request: PreviewRenderRequest = {
        revision,
        content,
        fallbackTitle,
        assetUrls,
      };
      if (renderWorker) renderWorker.postMessage(request);
      else renderSynchronously(revision);
    }, hasRendered ? 120 : 0);
  }

  function renderSynchronously(revision: number): void {
    if (revision !== renderRevision) return;
    const parsed = parseManuscript(content, fallbackTitle, {
      diagnostics: false,
    });
    const hiddenRanges = [parsed.frontmatterRange, parsed.titleHeadingRange].filter(
      (range): range is { from: number; to: number } => range !== null,
    );
    manuscript = parsed;
    rendered = renderManuscriptHtml(content, assetUrls, { hiddenRanges });
    hasRendered = true;
    renderBusy = false;
  }

  async function loadAssets(
    paths: string[],
    path: string,
    requestId: number,
  ): Promise<void> {
    if (!desktop || !path || !paths.length) {
      if (requestId === assetLoadId) assetBusy = false;
      if (requestId === assetLoadId && Object.keys(assetUrls).length) {
        assetUrls = {};
      }
      return;
    }
    assetBusy = true;
    const entries = await Promise.all(
      paths.map(async (relativePath) => {
        try {
          const asset = await invoke<AssetData>("read_manuscript_asset", {
            documentPath: path,
            relativePath,
          });
          return [relativePath, asset.dataUrl] as const;
        } catch {
          return null;
        }
      }),
    );
    if (requestId !== assetLoadId) return;
    const next = Object.fromEntries(
      entries.filter(
        (entry): entry is readonly [string, string] => entry !== null,
      ),
    );
    assetBusy = false;
    if (JSON.stringify(next) !== JSON.stringify(assetUrls)) assetUrls = next;
    else resolveLayoutWaiters();
  }

  function schedulePagination(): void {
    if (!mounted) return;
    if (layoutTimer) clearTimeout(layoutTimer);
    layoutBusy = true;
    const revision = ++layoutRevision;
    layoutTimer = setTimeout(() => void paginate(revision), 70);
  }

  async function paginate(revision: number): Promise<void> {
    layoutTimer = null;
    await tick();
    await waitForPreviewResources();
    if (
      revision !== layoutRevision ||
      !measureInner ||
      !measureBody ||
      !measureNotes ||
      !measureHeader
    ) {
      return;
    }
    const extracted = await splitOversizedBlocks(
      extractPreviewDocument(rendered),
      revision,
    );
    if (revision !== layoutRevision) return;
    const nextPages = await paginatePreviewBlocksAsync(extracted, fitsOnPage, {
      frameBudgetMs: 6,
      cancelled: () => revision !== layoutRevision,
    });
    if (revision !== layoutRevision) return;
    pages = nextPages;
    layoutBusy = false;
    resolveLayoutWaiters();
  }

  async function splitOversizedBlocks(
    extracted: ExtractedPreviewDocument,
    revision: number,
  ): Promise<ExtractedPreviewDocument> {
    const blocks: PreviewBlock[] = [];
    let frameStarted = performance.now();
    const cooperate = async (): Promise<boolean> => {
      if (revision !== layoutRevision) return false;
      if (performance.now() - frameStarted < 6) return true;
      await yieldToBrowser();
      frameStarted = performance.now();
      return revision === layoutRevision;
    };

    for (const block of extracted.blocks) {
      if (!(await cooperate())) return { ...extracted, blocks: [] };
      const notes = notesForBlock(block, extracted);
      const opensDocument = blocks.length === 0;
      const fitsBlankPage = fitsOnPage([block], notes, false);
      const fitsOpeningPage =
        !opensDocument || fitsOnPage([block], notes, true);
      if (fitsBlankPage && fitsOpeningPage) {
        blocks.push(block);
        continue;
      }
      const template = document.createElement("template");
      template.innerHTML = block.html;
      const element = template.content.firstElementChild as HTMLElement | null;
      if (element?.tagName === "TABLE") {
        blocks.push(
          ...(await splitTableBlock(
            element,
            block,
            extracted,
            opensDocument,
            cooperate,
          )),
        );
      } else if (element?.tagName === "PRE") {
        blocks.push(
          ...(await splitCodeBlock(
            element,
            block,
            opensDocument,
            cooperate,
          )),
        );
      } else if (element?.tagName === "P" && element.children.length === 0) {
        blocks.push(
          ...(await splitPlainParagraph(
            element,
            block,
            opensDocument,
            cooperate,
          )),
        );
      } else {
        blocks.push(block);
      }
    }
    return { ...extracted, blocks };
  }

  async function splitPlainParagraph(
    paragraph: HTMLElement,
    original: PreviewBlock,
    opensDocument: boolean,
    cooperate: () => Promise<boolean>,
  ): Promise<PreviewBlock[]> {
    const tokens = (paragraph.textContent ?? "").split(/(\s+)/).filter(Boolean);
    if (tokens.length < 2) return [original];
    const fragments: PreviewBlock[] = [];
    const prefixLengths = [0];
    for (const token of tokens) {
      prefixLengths.push((prefixLengths.at(-1) ?? 0) + token.length);
    }
    const makeFragment = (start: number, end: number): PreviewBlock => {
      const clone = paragraph.cloneNode(false) as HTMLElement;
      const text = tokens.slice(start, end).join("");
      const from = Math.min(
        original.sourceTo,
        original.sourceFrom + prefixLengths[start],
      );
      const to =
        end === tokens.length
          ? original.sourceTo
          : Math.min(
              original.sourceTo,
              original.sourceFrom + prefixLengths[end],
            );
      clone.textContent = text;
      clone.classList.add("preview-split-paragraph");
      if (start > 0) clone.classList.add("preview-split-continuation");
      if (end < tokens.length) clone.classList.add("preview-split-leading");
      clone.dataset.sourceFrom = String(from);
      clone.dataset.sourceTo = String(to);
      return {
        ...original,
        html: clone.outerHTML,
        sourceFrom: from,
        sourceTo: to,
      };
    };

    let start = 0;
    while (start < tokens.length) {
      const end = largestFittingEnd(
        start,
        tokens.length,
        (candidateEnd) =>
          fitsOnPage(
            [makeFragment(start, candidateEnd)],
            [],
            opensDocument && start === 0,
          ),
      );
      fragments.push(makeFragment(start, end));
      start = end;
      if (!(await cooperate())) return fragments;
    }
    return fragments;
  }

  async function splitTableBlock(
    table: HTMLElement,
    original: PreviewBlock,
    extracted: ExtractedPreviewDocument,
    opensDocument: boolean,
    cooperate: () => Promise<boolean>,
  ): Promise<PreviewBlock[]> {
    const rows = Array.from(
      table.querySelectorAll<HTMLTableRowElement>("tbody > tr"),
    );
    if (rows.length < 2) return [original];
    const base = table.cloneNode(true) as HTMLElement;
    for (const body of base.querySelectorAll("tbody")) body.replaceChildren();
    const fragments: PreviewBlock[] = [];

    const makeFragment = (start: number, end: number): PreviewBlock => {
      const sourceRows = rows.slice(start, end);
      const clone = base.cloneNode(true) as HTMLElement;
      const body = clone.querySelector("tbody");
      body?.replaceChildren(...sourceRows.map((row) => row.cloneNode(true)));
      const fallbackFrom = proportionalSourceOffset(
        original,
        start,
        rows.length,
      );
      const fallbackTo = proportionalSourceOffset(original, end, rows.length);
      const from = finiteSourceOffset(
        sourceRows[0]?.dataset.sourceFrom,
        fallbackFrom,
      );
      const to = finiteSourceOffset(
        sourceRows.at(-1)?.dataset.sourceTo,
        fallbackTo,
      );
      clone.dataset.sourceFrom = String(from);
      clone.dataset.sourceTo = String(to);
      return {
        html: clone.outerHTML,
        sourceFrom: from,
        sourceTo: to,
        footnoteIds: footnoteIdsWithin(clone),
      };
    };

    let start = 0;
    while (start < rows.length) {
      const end = largestFittingEnd(start, rows.length, (candidateEnd) => {
        const candidate = makeFragment(start, candidateEnd);
        return fitsOnPage(
          [candidate],
          notesForBlock(candidate, extracted),
          opensDocument && start === 0,
        );
      });
      fragments.push(makeFragment(start, end));
      start = end;
      if (!(await cooperate())) return fragments;
    }
    return fragments;
  }

  async function splitCodeBlock(
    pre: HTMLElement,
    original: PreviewBlock,
    opensDocument: boolean,
    cooperate: () => Promise<boolean>,
  ): Promise<PreviewBlock[]> {
    const lines = (pre.textContent ?? "").split("\n");
    if (lines.length < 2) return [original];
    const fragments: PreviewBlock[] = [];
    const makeFragment = (start: number, end: number): PreviewBlock => {
      const clone = pre.cloneNode(true) as HTMLElement;
      const target = clone.querySelector("code") ?? clone;
      target.textContent = lines.slice(start, end).join("\n");
      const sourceFrom = proportionalSourceOffset(
        original,
        start,
        lines.length,
      );
      const sourceTo = proportionalSourceOffset(
        original,
        end,
        lines.length,
      );
      clone.dataset.sourceFrom = String(sourceFrom);
      clone.dataset.sourceTo = String(sourceTo);
      return {
        ...original,
        html: clone.outerHTML,
        sourceFrom,
        sourceTo,
        footnoteIds: [],
      };
    };

    let start = 0;
    while (start < lines.length) {
      const end = largestFittingEnd(
        start,
        lines.length,
        (candidateEnd) =>
          fitsOnPage(
            [makeFragment(start, candidateEnd)],
            [],
            opensDocument && start === 0,
          ),
      );
      fragments.push(makeFragment(start, end));
      start = end;
      if (!(await cooperate())) return fragments;
    }
    return fragments;
  }

  function largestFittingEnd(
    start: number,
    total: number,
    fits: (end: number) => boolean,
  ): number {
    let accepted = start;
    let probe = Math.min(total, start + 1);

    while (fits(probe)) {
      accepted = probe;
      if (accepted === total) return total;
      probe = Math.min(total, start + (accepted - start) * 2);
    }
    if (accepted === start) return Math.min(total, start + 1);

    let rejected = probe;
    while (accepted + 1 < rejected) {
      const middle = Math.floor((accepted + rejected) / 2);
      if (fits(middle)) accepted = middle;
      else rejected = middle;
    }
    return accepted;
  }

  function proportionalSourceOffset(
    block: PreviewBlock,
    position: number,
    total: number,
  ): number {
    if (position <= 0 || total <= 0) return block.sourceFrom;
    if (position >= total) return block.sourceTo;
    return Math.round(
      block.sourceFrom +
        ((block.sourceTo - block.sourceFrom) * position) / total,
    );
  }

  function finiteSourceOffset(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function yieldToBrowser(): Promise<void> {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  function notesForBlock(
    block: PreviewBlock,
    extracted: ExtractedPreviewDocument,
  ): PreviewFootnote[] {
    return block.footnoteIds
      .map((id) => extracted.footnotes.get(id))
      .filter((note): note is PreviewFootnote => Boolean(note));
  }

  function footnoteIdsWithin(element: Element): string[] {
    return Array.from(
      element.querySelectorAll<HTMLAnchorElement>("a[data-footnote-ref]"),
    )
      .map((anchor) =>
        decodeURIComponent(anchor.getAttribute("href") ?? "")
          .replace(/^#/, "")
          .replace(/^user-content-/, "")
          .replace(/^fn-/, ""),
      )
      .filter((id, index, ids) => Boolean(id) && ids.indexOf(id) === index);
  }

  function fitsOnPage(
    blocks: Array<{ html: string }>,
    notes: PreviewFootnote[],
    firstPage: boolean,
  ): boolean {
    measureBody.innerHTML = `${firstPage ? measureHeader.outerHTML : ""}<div class="rendered-markdown">${blocks
      .map((block) => block.html)
      .join("")}</div>`;
    measureNotes.innerHTML = notes.map((note) => note.html).join("");
    const notesHeight = notes.length ? measureNotes.scrollHeight + 18 : 0;
    return measureBody.scrollHeight + notesHeight <= measureInner.clientHeight + 1;
  }

  async function waitForPreviewResources(): Promise<void> {
    if (document.fonts?.ready) await document.fonts.ready;
    await Promise.all(
      Object.values(assetUrls).map(
        (url) =>
          new Promise<void>((resolve) => {
            const image = new Image();
            image.onload = () => resolve();
            image.onerror = () => resolve();
            image.src = url;
            if (image.complete) resolve();
          }),
      ),
    );
  }

  function resolveLayoutWaiters(): void {
    if (renderBusy || layoutBusy || assetBusy) return;
    const waiters = layoutWaiters;
    layoutWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function awaitLayout(): Promise<void> {
    if (!renderBusy && !layoutBusy && !assetBusy) return Promise.resolve();
    return new Promise((resolve) => layoutWaiters.push(resolve));
  }

  function currentScrollAnchor(): ScrollAnchor {
    if (!scroller) return { offset: 0, source: "preview" };
    const scrollerRect = scroller.getBoundingClientRect();
    const elements = Array.from(
      scroller.querySelectorAll<HTMLElement>("[data-source-from]"),
    );
    let candidate = elements[0];
    for (const element of elements) {
      if (element.getBoundingClientRect().top <= scrollerRect.top + 72) {
        candidate = element;
      } else {
        break;
      }
    }
    return {
      offset: Number(candidate?.dataset.sourceFrom ?? 0),
      source: "preview",
    };
  }

  function handleScroll(): void {
    if (scrollFrame !== null) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      onscrollanchor?.(currentScrollAnchor());
    });
  }

  function scrollToAnchor(anchor: ScrollAnchor): void {
    if (!scroller) return;
    const elements = Array.from(
      scroller.querySelectorAll<HTMLElement>("[data-source-from]"),
    );
    const target =
      elements.find((element) => {
        const from = Number(element.dataset.sourceFrom ?? 0);
        const to = Number(element.dataset.sourceTo ?? from);
        return anchor.offset >= from && anchor.offset <= to;
      }) ??
      elements.reduce<HTMLElement | null>((closest, element) => {
        if (!closest) return element;
        return Math.abs(Number(element.dataset.sourceFrom) - anchor.offset) <
          Math.abs(Number(closest.dataset.sourceFrom) - anchor.offset)
          ? element
          : closest;
      }, null);
    if (!target) return;
    const scrollerTop = scroller.getBoundingClientRect().top;
    scroller.scrollTop += target.getBoundingClientRect().top - scrollerTop - 54;
  }

  function handleClick(event: MouseEvent): void {
    const anchor =
      event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>("a[href]")
        : null;
    if (!anchor) return;
    const url = anchor.getAttribute("href") ?? "";
    if (url.startsWith("#")) {
      event.preventDefault();
      const id = decodeURIComponent(url.slice(1));
      const target = scroller.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
      target?.scrollIntoView({ block: "center" });
      target?.classList.add("footnote-highlight");
      setTimeout(() => target?.classList.remove("footnote-highlight"), 1200);
      return;
    }
    if (!/^https?:\/\//i.test(url)) return;
    event.preventDefault();
    onlink?.(url);
  }

  function interceptLinks(node: HTMLElement): { destroy: () => void } {
    node.addEventListener("click", handleClick);
    return { destroy: () => node.removeEventListener("click", handleClick) };
  }

  function measureViewport(): void {
    if (!scroller) return;
    viewportWidth = scroller.clientWidth;
    viewportHeight = scroller.clientHeight;
  }

  onMount(() => {
    mounted = true;
    startRenderWorker();
    scheduleRender();
    if (typeof ResizeObserver !== "undefined") {
      viewportObserver = new ResizeObserver(measureViewport);
      viewportObserver.observe(scroller);
    }
    measureViewport();
    onready?.({ getScrollAnchor: currentScrollAnchor, scrollToAnchor, awaitLayout });
  });

  $effect(() => {
    content;
    fallbackTitle;
    assetUrls;
    scheduleRender();
  });

  $effect(() => {
    const paths = manuscript.imagePaths;
    const path = documentPath;
    const requestId = ++assetLoadId;
    void loadAssets(paths, path, requestId);
  });

  $effect(() => {
    rendered;
    manuscript;
    fontFamily;
    schedulePagination();
  });

  onDestroy(() => {
    mounted = false;
    if (renderTimer) clearTimeout(renderTimer);
    if (layoutTimer) clearTimeout(layoutTimer);
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    viewportObserver?.disconnect();
    renderWorker?.terminate();
    renderWorker = null;
    layoutWaiters.forEach((resolve) => resolve());
    layoutWaiters = [];
    onready?.(null);
  });
</script>

<div
  class="preview-scroll"
  class:layout-busy={layoutBusy || renderBusy}
  bind:this={scroller}
  onscroll={handleScroll}
  use:interceptLinks
  style={`--preview-font: "${fontFamily.replaceAll('"', '\\"')}", Pretendard, sans-serif; --preview-scale: ${previewScale}`}
>
  <div class="preview-toolbar-note" aria-live="polite">
    <span>완성본 · A4</span>
    {#if layoutBusy || renderBusy}<small>조판 중…</small>{/if}
  </div>
  <div class="preview-page-stack">
    {#each pages as page, index (`${index}:${page.sourceFrom}:${page.sourceTo}`)}
      <div
        class="preview-page-slot"
        style={`width:${A4_WIDTH_PX * previewScale}px;height:${A4_HEIGHT_PX * previewScale}px`}
      >
        <article
          class="preview-page"
          data-preview-page={index}
          style={`transform:scale(${previewScale})`}
        >
          <div class="preview-page-inner">
            <div class="preview-page-body">
              {#if index === 0}
                <header class="document-header">
                  {#if manuscript.metadata.genre}<p class="genre">{manuscript.metadata.genre}</p>{/if}
                  <h1>{manuscript.metadata.title}</h1>
                  {#if manuscript.metadata.subtitle}<p class="subtitle">{manuscript.metadata.subtitle}</p>{/if}
                  {#if manuscript.metadata.author || manuscript.metadata.affiliation}
                    <p class="byline">
                      {#if manuscript.metadata.affiliation}<span>{manuscript.metadata.affiliation}</span>{/if}
                      {#if manuscript.metadata.author}<strong>{manuscript.metadata.author}</strong>{/if}
                    </p>
                  {/if}
                </header>
              {/if}
              <div class="rendered-markdown">{@html page.bodyHtml}</div>
            </div>
            {#if page.footnoteHtml}
              <section class="page-footnotes" aria-label={`${index + 1}쪽 각주`}>
                <ol>{@html page.footnoteHtml}</ol>
              </section>
            {/if}
          </div>
          <footer class="page-number">{index + 1}</footer>
        </article>
      </div>
    {/each}
  </div>

  <div class="preview-measure" aria-hidden="true">
    <article class="preview-page">
      <div class="preview-page-inner" bind:this={measureInner}>
        <div class="preview-page-body" bind:this={measureBody}></div>
        <section class="page-footnotes"><ol bind:this={measureNotes}></ol></section>
      </div>
    </article>
    <header class="document-header" bind:this={measureHeader}>
      {#if manuscript.metadata.genre}<p class="genre">{manuscript.metadata.genre}</p>{/if}
      <h1>{manuscript.metadata.title}</h1>
      {#if manuscript.metadata.subtitle}<p class="subtitle">{manuscript.metadata.subtitle}</p>{/if}
      {#if manuscript.metadata.author || manuscript.metadata.affiliation}
        <p class="byline">
          {#if manuscript.metadata.affiliation}<span>{manuscript.metadata.affiliation}</span>{/if}
          {#if manuscript.metadata.author}<strong>{manuscript.metadata.author}</strong>{/if}
        </p>
      {/if}
    </header>
  </div>
</div>

<style>
  .preview-scroll {
    height: 100%;
    min-width: 0;
    overflow: auto;
    overscroll-behavior: contain;
    background-color: var(--desk);
    background-image: var(--hanji-texture);
    background-size: 320px 320px;
    scrollbar-gutter: stable;
  }

  .preview-toolbar-note {
    position: sticky;
    z-index: 5;
    top: 8px;
    display: flex;
    width: max-content;
    margin: 8px 12px -34px auto;
    gap: 8px;
    border: 1px solid color-mix(in srgb, var(--rule) 75%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-raised) 92%, transparent);
    padding: 5px 9px;
    box-shadow: var(--shadow-contact);
    color: var(--ink-muted);
    font-family: var(--ui-font);
    font-size: var(--type-micro);
    backdrop-filter: blur(7px);
  }

  .preview-toolbar-note small { color: var(--accent); }

  .preview-page-stack {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 28px;
    min-width: max-content;
    padding: 48px 20px 100px;
  }

  .preview-page-slot { position: relative; flex: 0 0 auto; }

  .preview-page {
    position: absolute;
    top: 0;
    left: 0;
    box-sizing: border-box;
    width: 210mm;
    height: 297mm;
    transform-origin: top left;
    border: 1px solid color-mix(in srgb, var(--sheet-edge) 70%, transparent);
    background-color: var(--sheet);
    background-image: var(--hanji-texture);
    background-size: 320px 320px;
    padding: 22mm 20mm 18mm;
    box-shadow: var(--shadow-paper);
    color: #26211e;
    font-family: var(--preview-font);
    font-size: 10.5pt;
    line-height: 1.75;
  }

  .preview-page-inner {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .preview-page-body { min-height: 0; }

  .document-header {
    margin: 5mm 0 14mm;
    text-align: center;
    break-after: avoid;
  }

  .genre {
    margin: 0 0 7mm;
    color: #756b64;
    font-size: 8.5pt;
    letter-spacing: 0.08em;
  }

  .document-header h1 {
    margin: 0;
    color: #211d1a;
    font-family: var(--preview-font);
    font-size: 22pt;
    font-weight: 700;
    line-height: 1.35;
    letter-spacing: -0.035em;
  }

  .subtitle {
    margin: 4mm 0 0;
    color: #665d57;
    font-size: 12pt;
  }

  .byline {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin: 8mm 0 0;
    color: #635b56;
    font-size: 9pt;
  }

  .byline strong { color: #322d29; }

  .page-number {
    position: absolute;
    right: 0;
    bottom: 7mm;
    left: 0;
    color: #887e77;
    font-size: 8pt;
    text-align: center;
  }

  .page-footnotes {
    flex: 0 0 auto;
    margin-top: auto;
    border-top: 0.75pt solid #9f9690;
    padding-top: 2.5mm;
    font-size: 8pt;
    line-height: 1.45;
  }

  .page-footnotes ol {
    margin: 0;
    padding-left: 5mm;
  }

  .page-footnotes :global(li) { margin: 0 0 1.2mm; transition: background 180ms ease; }
  .page-footnotes :global(.footnote-highlight) { background: rgba(167, 78, 64, 0.14); }

  :global(.rendered-markdown h1) { font-size: 18pt; }
  :global(.rendered-markdown h2) {
    margin: 2em 0 0.7em;
    font-size: 15pt;
    line-height: 1.45;
    break-after: avoid;
  }
  :global(.rendered-markdown h3) {
    margin: 1.7em 0 0.6em;
    font-size: 12pt;
    break-after: avoid;
  }
  :global(.rendered-markdown p) {
    margin: 0 0 0.95em;
    text-align: justify;
    text-indent: 1em;
    word-break: keep-all;
    overflow-wrap: anywhere;
    orphans: 2;
    widows: 2;
  }
  :global(.rendered-markdown p.preview-split-leading) { margin-bottom: 0; }
  :global(.rendered-markdown p.preview-split-continuation) { text-indent: 0; }
  :global(.rendered-markdown blockquote) {
    margin: 1.25em 0;
    border-left: 2px solid #aa8d7e;
    padding: 0.15em 0 0.15em 1.1em;
    color: #5d5550;
  }
  :global(.rendered-markdown blockquote p),
  :global(.rendered-markdown li p),
  :global(.rendered-markdown td p) { text-indent: 0; }
  :global(.rendered-markdown table) {
    width: 100%;
    margin: 1.35em 0;
    border-collapse: collapse;
    font-size: 8.8pt;
  }
  :global(.rendered-markdown thead) { display: table-header-group; }
  :global(.rendered-markdown tr),
  :global(.rendered-markdown figure),
  :global(.rendered-markdown .katex-display) { break-inside: avoid; }
  :global(.rendered-markdown th),
  :global(.rendered-markdown td) {
    border: 0.75pt solid #b8b0aa;
    padding: 0.48em 0.62em;
    text-align: left;
    vertical-align: top;
  }
  :global(.rendered-markdown th) { background: #f1eeeb; font-weight: 700; }
  :global(.rendered-markdown figure) { margin: 1.45em 0; text-align: center; }
  :global(.rendered-markdown figure img),
  :global(.rendered-markdown > img) {
    display: block;
    max-width: 100%;
    max-height: 175mm;
    margin: 0 auto;
    object-fit: contain;
  }
  :global(.rendered-markdown figcaption) {
    margin-top: 0.55em;
    color: #6b625c;
    font-size: 8.5pt;
    text-align: center;
  }
  :global(.rendered-markdown img.missing-image),
  :global(.rendered-markdown img.remote-image) {
    box-sizing: border-box;
    width: 100%;
    height: 38mm;
    border: 1px dashed #b9aaa1;
    background: linear-gradient(135deg, transparent 49.5%, #d4c8c0 50%, transparent 50.5%), #f7f4f1;
  }
  :global(.rendered-markdown pre) {
    overflow: hidden;
    margin: 1.25em 0;
    border: 1px solid #d3ccc7;
    border-radius: 3px;
    background: #f7f5f3;
    padding: 0.85em;
    font-family: NanumGothicCoding, monospace;
    font-size: 8.5pt;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  :global(.rendered-markdown code) { font-family: NanumGothicCoding, monospace; font-size: 0.9em; }
  :global(.rendered-markdown a) {
    color: #315f68;
    text-decoration-thickness: 0.06em;
    text-underline-offset: 0.15em;
  }
  :global(.rendered-markdown .katex-display) {
    max-width: 100%;
    margin: 1.35em 0;
    overflow: hidden;
  }

  .preview-measure {
    position: fixed;
    z-index: -100;
    top: 0;
    left: -200vw;
    visibility: hidden;
    pointer-events: none;
  }
  .preview-measure > .preview-page { position: relative; transform: none; }
  .preview-measure > .document-header { width: 170mm; }

  @page { size: A4; margin: 0; }

  @media print {
    .preview-scroll {
      height: auto;
      overflow: visible;
      background: white;
    }
    .preview-toolbar-note, .preview-measure { display: none; }
    .preview-page-stack { display: block; min-width: 0; padding: 0; }
    .preview-page-slot { width: 210mm !important; height: 297mm !important; }
    .preview-page {
      position: relative;
      transform: none !important;
      border: 0;
      box-shadow: none;
      background: white;
      break-after: page;
      page-break-after: always;
    }
    .preview-page-slot:last-child .preview-page { break-after: auto; page-break-after: auto; }
  }
</style>
