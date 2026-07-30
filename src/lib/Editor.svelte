<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import {
    cellIndexForOffset,
    MANUSCRIPT_CELLS_PER_PAGE,
    pageIndexForOffset,
    paginateManuscript,
    type ManuscriptCell,
  } from "./manuscript-layout";
  import { sentenceRange } from "./markdown";
  import type {
    EditorSelection as SelectionInfo,
    FocusMode,
  } from "./types";

  export interface EditorApi {
    focus: () => void;
    getContent: () => string;
    getSelection: () => SelectionInfo;
    replaceRange: (from: number, to: number, text: string) => void;
    insertAtCursor: (text: string) => void;
    setSelection: (from: number, to: number) => void;
    scrollToOffset: (offset: number) => void;
    scrollToLine: (line: number) => void;
    setGhostText: (text: string) => void;
    clearGhostText: () => void;
  }

  interface Props {
    value: string;
    readOnly?: boolean;
    fontFamily?: string;
    manuscriptZoom?: number;
    focusMode?: FocusMode;
    typewriterMode?: boolean;
    soundEnabled?: boolean;
    onready?: (api: EditorApi | null) => void;
    onchange?: (value: string) => void;
    onselection?: (selection: SelectionInfo) => void;
    onactivity?: () => void;
    onghostaccept?: (text: string) => void;
  }

  interface MarkdownDecorations {
    syntax: Set<number>;
    headings: Array<[number, number]>;
    links: Array<[number, number]>;
    quotes: Array<[number, number]>;
    footnotes: Array<[number, number]>;
  }

  let {
    value,
    readOnly = false,
    fontFamily = "Pretendard",
    manuscriptZoom = 100,
    focusMode = "off",
    typewriterMode = true,
    soundEnabled = false,
    onready,
    onchange,
    onselection,
    onactivity,
    onghostaccept,
  }: Props = $props();

  let host: HTMLDivElement;
  let scroller: HTMLDivElement;
  let input: HTMLTextAreaElement;
  let mounted = false;
  let internalValue = $state("");
  let selectionFrom = $state(0);
  let selectionTo = $state(0);
  let selectionDirection = $state<"forward" | "backward" | "none">("none");
  let focused = $state(false);
  let ghostText = $state("");
  let visibleStart = $state(0);
  let visibleEnd = $state(4);
  let inputLeft = $state(0);
  let inputTop = $state(0);
  let dragAnchor: number | null = null;
  let scrollFrame: number | null = null;

  let manuscriptScale = $derived(
    Math.min(140, Math.max(80, manuscriptZoom)) / 100,
  );
  let pages = $derived(paginateManuscript(internalValue));
  let activePageIndex = $derived(
    pageIndexForOffset(pages, selectionDirection === "backward" ? selectionFrom : selectionTo),
  );
  let activeCellIndex = $derived(
    cellIndexForOffset(
      pages[activePageIndex] ?? pages[0],
      selectionDirection === "backward" ? selectionFrom : selectionTo,
    ),
  );
  let markdown = $derived(markdownDecorations(internalValue));
  let activeFocusRange = $derived(
    focusRange(internalValue, selectionFrom, selectionTo, focusMode),
  );
  let ghostGraphemes = $derived(segmentGraphemes(ghostText));

  function selectionInfo(): SelectionInfo {
    const from = Math.min(selectionFrom, selectionTo);
    const to = Math.max(selectionFrom, selectionTo);
    const head =
      selectionDirection === "backward" ? selectionFrom : selectionTo;
    const before = internalValue.slice(0, head);
    const line = before.split("\n").length;
    const page = activePageIndex + 1;
    const cell = pages[activePageIndex]?.cells[activeCellIndex];
    return {
      from,
      to,
      text: internalValue.slice(from, to),
      line,
      page,
      row: (cell?.row ?? 0) + 1,
      column: (cell?.column ?? 0) + 1,
    };
  }

  function syncSelection(notify = true): void {
    if (!input) return;
    selectionFrom = input.selectionStart ?? 0;
    selectionTo = input.selectionEnd ?? selectionFrom;
    selectionDirection =
      (input.selectionDirection as "forward" | "backward" | "none") ?? "none";
    if (notify) onselection?.(selectionInfo());
    scheduleCaretPosition();
  }

  function commitInput(playSound = true): void {
    if (!input) return;
    internalValue = input.value;
    ghostText = "";
    syncSelection();
    onchange?.(internalValue);
    onactivity?.();
    if (playSound) playKeystroke();
    scheduleCaretScroll();
  }

  function applyReplacement(
    from: number,
    to: number,
    text: string,
    selectionMode: SelectionMode = "end",
  ): void {
    if (!input || readOnly) return;
    const safeFrom = Math.max(0, Math.min(from, internalValue.length));
    const safeTo = Math.max(safeFrom, Math.min(to, internalValue.length));
    input.setRangeText(text, safeFrom, safeTo, selectionMode);
    commitInput(false);
    input.focus();
  }

  function setSelection(from: number, to: number, scroll = true): void {
    if (!input) return;
    const start = Math.max(0, Math.min(from, internalValue.length));
    const end = Math.max(0, Math.min(to, internalValue.length));
    input.setSelectionRange(start, end);
    syncSelection();
    input.focus({ preventScroll: true });
    if (scroll) scheduleCaretScroll();
  }

  function createApi(): EditorApi {
    return {
      focus: () => input?.focus({ preventScroll: true }),
      getContent: () => internalValue,
      getSelection: selectionInfo,
      replaceRange: (from, to, text) => applyReplacement(from, to, text),
      insertAtCursor: (text) =>
        applyReplacement(selectionFrom, selectionTo, text),
      setSelection,
      scrollToOffset: (offset) => setSelection(offset, offset),
      scrollToLine: (line) => {
        const lines = internalValue.split("\n");
        const safeLine = Math.max(1, Math.min(line, lines.length));
        let offset = 0;
        for (let index = 0; index < safeLine - 1; index += 1) {
          offset += lines[index].length + 1;
        }
        setSelection(offset, offset);
      },
      setGhostText: (text) => {
        ghostText = text;
        scheduleCaretPosition();
      },
      clearGhostText,
    };
  }

  function handleInput(): void {
    commitInput();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && ghostText) {
      event.preventDefault();
      clearGhostText();
      return;
    }
    if (event.key !== "Tab" || readOnly) return;
    event.preventDefault();
    if (!event.shiftKey && ghostText) {
      const insertion = ghostText;
      ghostText = "";
      applyReplacement(selectionFrom, selectionTo, insertion);
      onghostaccept?.(insertion);
      return;
    }
    if (event.shiftKey) {
      const before = internalValue.slice(Math.max(0, selectionFrom - 4), selectionFrom);
      const spaces = before.match(/ {1,4}$/)?.[0].length ?? 0;
      if (spaces > 0) {
        applyReplacement(selectionFrom - spaces, selectionTo, "");
      }
      return;
    }
    applyReplacement(selectionFrom, selectionTo, "    ");
  }

  function clearGhostText(): void {
    ghostText = "";
  }

  function beginCellSelection(
    event: PointerEvent,
    cell: ManuscriptCell,
  ): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const offset = pointerOffset(event, cell);
    dragAnchor = event.shiftKey ? selectionFrom : offset;
    setNativeSelection(dragAnchor, offset);
  }

  function extendCellSelection(
    event: PointerEvent,
    cell: ManuscriptCell,
  ): void {
    if (dragAnchor === null || event.buttons !== 1) return;
    event.preventDefault();
    setNativeSelection(dragAnchor, pointerOffset(event, cell));
  }

  function pointerOffset(event: PointerEvent, cell: ManuscriptCell): number {
    if (!cell.filled || cell.tabContinuation) return cell.caretOffset;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return event.clientX - rect.left > rect.width / 2 ? cell.to : cell.from;
  }

  function setNativeSelection(anchor: number, head: number): void {
    if (!input) return;
    const from = Math.max(0, Math.min(anchor, head, internalValue.length));
    const to = Math.max(0, Math.min(Math.max(anchor, head), internalValue.length));
    const direction = head < anchor ? "backward" : "forward";
    input.setSelectionRange(from, to, direction);
    syncSelection();
    input.focus({ preventScroll: true });
  }

  function handleScroll(): void {
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      const firstPage =
        scroller.querySelector<HTMLElement>(".manuscript-page");
      const pageStride = firstPage
        ? firstPage.offsetHeight +
          Number.parseFloat(getComputedStyle(firstPage).marginBottom)
        : 1_236 * manuscriptScale;
      const first = Math.max(0, Math.floor((scroller.scrollTop - 56) / pageStride));
      const count = Math.max(1, Math.ceil(scroller.clientHeight / pageStride));
      visibleStart = Math.max(0, first - 2);
      visibleEnd = Math.min(pages.length - 1, first + count + 2);
      scheduleCaretPosition();
    });
  }

  function pageIsRendered(index: number): boolean {
    return (
      (index >= visibleStart && index <= visibleEnd) ||
      index === activePageIndex
    );
  }

  function cellIsSelected(cell: ManuscriptCell): boolean {
    if (selectionFrom === selectionTo || !cell.filled) return false;
    const from = Math.min(selectionFrom, selectionTo);
    const to = Math.max(selectionFrom, selectionTo);
    return cell.from < to && cell.to > from;
  }

  function cellIsDimmed(cell: ManuscriptCell): boolean {
    if (!cell.filled || !activeFocusRange) return false;
    return cell.to <= activeFocusRange[0] || cell.from >= activeFocusRange[1];
  }

  function inRanges(cell: ManuscriptCell, ranges: Array<[number, number]>): boolean {
    return (
      cell.filled &&
      ranges.some(([from, to]) => cell.from < to && cell.to > from)
    );
  }

  function isActiveCell(pageIndex: number, cellIndex: number): boolean {
    return (
      focused &&
      selectionFrom === selectionTo &&
      pageIndex === activePageIndex &&
      cellIndex === activeCellIndex
    );
  }

  function caretAfterCell(cell: ManuscriptCell): boolean {
    return cell.filled && selectionTo >= cell.to && cell.to === internalValue.length;
  }

  function ghostCharacter(pageIndex: number, cellIndex: number): string {
    if (
      !ghostGraphemes.length ||
      selectionFrom !== selectionTo ||
      selectionTo !== internalValue.length
    ) {
      return "";
    }
    let startCell = activeCellIndex;
    const activeCell = pages[activePageIndex]?.cells[activeCellIndex];
    if (activeCell?.filled) startCell += 1;
    const relative =
      (pageIndex - activePageIndex) * MANUSCRIPT_CELLS_PER_PAGE +
      cellIndex -
      startCell;
    return relative >= 0 ? (ghostGraphemes[relative] ?? "") : "";
  }

  function scheduleCaretScroll(): void {
    requestAnimationFrame(async () => {
      await tick();
      const caret = host?.querySelector<HTMLElement>("[data-caret='true']");
      caret?.scrollIntoView({
        block: typewriterMode ? "center" : "nearest",
        inline: "nearest",
        behavior: "smooth",
      });
      scheduleCaretPosition();
    });
  }

  function scheduleCaretPosition(): void {
    requestAnimationFrame(async () => {
      await tick();
      const caret = host?.querySelector<HTMLElement>("[data-caret='true']");
      if (!caret || !host) return;
      const caretRect = caret.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      inputLeft = caretRect.left - hostRect.left;
      inputTop = caretRect.top - hostRect.top;
    });
  }

  function playKeystroke(): void {
    if (!soundEnabled) return;
    try {
      const AudioContextClass =
        window.AudioContext ??
        (
          window as typeof window & {
            webkitAudioContext?: typeof AudioContext;
          }
        ).webkitAudioContext;
      if (!AudioContextClass) return;
      const context = new AudioContextClass();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.value = 112 + Math.random() * 20;
      gain.gain.setValueAtTime(0.016, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        context.currentTime + 0.026,
      );
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.029);
      oscillator.addEventListener("ended", () => context.close());
    } catch {
      // Keystroke sound is optional and must never block writing.
    }
  }

  function segmentGraphemes(text: string): string[] {
    if (!text) return [];
    if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
      return Array.from(
        new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(text),
        (entry) => entry.segment,
      );
    }
    return Array.from(text);
  }

  function focusRange(
    content: string,
    from: number,
    to: number,
    mode: FocusMode,
  ): [number, number] | null {
    if (mode === "off") return null;
    if (mode === "sentence") {
      const range = sentenceRange(content, from, to);
      return [range.from, range.to];
    }
    const startMarker = content.lastIndexOf("\n\n", Math.max(0, from - 1));
    const endMarker = content.indexOf("\n\n", to);
    return [
      startMarker < 0 ? 0 : startMarker + 2,
      endMarker < 0 ? content.length : endMarker,
    ];
  }

  function markdownDecorations(content: string): MarkdownDecorations {
    const result: MarkdownDecorations = {
      syntax: new Set<number>(),
      headings: [],
      links: [],
      quotes: [],
      footnotes: [],
    };
    let lineStart = 0;
    for (const line of content.split("\n")) {
      const lineEnd = lineStart + line.length;
      const heading = line.match(/^(#{1,6})(\s+)/);
      if (heading) {
        result.headings.push([lineStart, lineEnd]);
        mark(result.syntax, lineStart, heading[1].length + heading[2].length);
      }
      const quote = line.match(/^(\s*>\s?)/);
      if (quote) {
        result.quotes.push([lineStart, lineEnd]);
        mark(result.syntax, lineStart, quote[1].length);
      }
      const list = line.match(/^(\s*)(?:[-+*]|\d+\.)\s+/);
      if (list) {
        const markerStart = lineStart + list[1].length;
        mark(result.syntax, markerStart, list[0].length - list[1].length);
      }
      if (/^\[\^[^\]]+\]:/.test(line)) {
        result.footnotes.push([lineStart, lineEnd]);
      }
      for (const marker of line.matchAll(/\*\*|__|~~|`+/g)) {
        mark(
          result.syntax,
          lineStart + (marker.index ?? 0),
          marker[0].length,
        );
      }
      for (const link of line.matchAll(/(!?)\[([^\]]+)\]\(([^)]+)\)/g)) {
        const start = lineStart + (link.index ?? 0);
        const labelStart = start + link[1].length + 1;
        const labelEnd = labelStart + link[2].length;
        result.links.push([labelStart, labelEnd]);
        mark(result.syntax, start, link[1].length + 1);
        result.syntax.add(labelEnd);
        result.syntax.add(labelEnd + 1);
        result.syntax.add(start + link[0].length - 1);
      }
      lineStart = lineEnd + 1;
    }
    return result;
  }

  function mark(target: Set<number>, start: number, length: number): void {
    for (let offset = start; offset < start + length; offset += 1) {
      target.add(offset);
    }
  }

  onMount(() => {
    mounted = true;
    internalValue = value;
    input.value = value;
    input.setSelectionRange(0, 0);
    syncSelection();
    onready?.(createApi());
    const endDrag = () => {
      dragAnchor = null;
    };
    window.addEventListener("pointerup", endDrag);
    scheduleCaretPosition();
    return () => window.removeEventListener("pointerup", endDrag);
  });

  $effect(() => {
    if (!mounted || !input || value === internalValue) return;
    const head = Math.min(selectionTo, value.length);
    internalValue = value;
    input.value = value;
    input.setSelectionRange(head, head);
    syncSelection();
  });

  $effect(() => {
    manuscriptScale;
    if (!mounted) return;
    requestAnimationFrame(() => {
      handleScroll();
      scheduleCaretScroll();
    });
  });

  onDestroy(() => {
    mounted = false;
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    onready?.(null);
  });
</script>

<div
  class:focused
  class="editor-host"
  bind:this={host}
  style={[
    `--manuscript-font: "${fontFamily.replaceAll('"', '\\"')}", Pretendard, sans-serif`,
    `--cell-size: ${40 * manuscriptScale}px`,
    `--row-gap: ${12 * manuscriptScale}px`,
    `--paper-width: ${960 * manuscriptScale}px`,
    `--paper-height: ${1200 * manuscriptScale}px`,
    `--grid-width: ${800 * manuscriptScale}px`,
    `--grid-height: ${1028 * manuscriptScale}px`,
    `--grid-left: ${80 * manuscriptScale}px`,
    `--grid-top: ${86 * manuscriptScale}px`,
    `--page-gap: ${36 * manuscriptScale}px`,
    `--writing-font-size: ${26 * manuscriptScale}px`,
    `--tab-font-size: ${14 * manuscriptScale}px`,
  ].join("; ")}
>
  <textarea
    class="native-input"
    bind:this={input}
    style={`transform: translate(${inputLeft}px, ${inputTop}px);`}
    readonly={readOnly}
    spellcheck="false"
    aria-label="Markdown 원고 편집기"
    oninput={handleInput}
    onselect={() => syncSelection()}
    onkeyup={() => syncSelection()}
    onkeydown={handleKeydown}
    onfocus={() => {
      focused = true;
      scheduleCaretPosition();
    }}
    onblur={() => (focused = false)}
  ></textarea>

  <div
    class="manuscript-scroll"
    bind:this={scroller}
    onscroll={handleScroll}
  >
    <div class="page-stack">
      {#each pages as page, pageIndex (page.number)}
        <section
          class:active-page={pageIndex === activePageIndex}
          class="manuscript-page"
          aria-label={`원고지 ${page.number}쪽`}
        >
          <span class="page-number">NO. {page.number}</span>
          <div class="page-caption">20 × 20</div>
          <div class="manuscript-grid">
            {#if pageIsRendered(pageIndex)}
              {#each page.cells as cell, cellIndex (cell.index)}
                {@const ghost = ghostCharacter(pageIndex, cellIndex)}
                <span
                  class:active-cell={isActiveCell(pageIndex, cellIndex)}
                  class:caret-after={isActiveCell(pageIndex, cellIndex) && caretAfterCell(cell)}
                  class:selected={cellIsSelected(cell)}
                  class:markdown-syntax={cell.filled && markdown.syntax.has(cell.from)}
                  class:markdown-heading={inRanges(cell, markdown.headings)}
                  class:markdown-link={inRanges(cell, markdown.links)}
                  class:markdown-quote={inRanges(cell, markdown.quotes)}
                  class:markdown-footnote={inRanges(cell, markdown.footnotes)}
                  class:focus-dim={cellIsDimmed(cell)}
                  class:tab-cell={cell.text === "⇥" || cell.tabContinuation}
                  class="manuscript-cell"
                  role="presentation"
                  data-caret={isActiveCell(pageIndex, cellIndex) ? "true" : undefined}
                  onpointerdown={(event) => beginCellSelection(event, cell)}
                  onpointerenter={(event) => extendCellSelection(event, cell)}
                >
                  {#if cell.text}
                    <span class="cell-text">{cell.text}</span>
                  {:else if ghost}
                    <span class="ghost-text">{ghost}</span>
                  {/if}
                </span>
              {/each}
            {/if}
          </div>
        </section>
      {/each}
    </div>
  </div>
</div>

<style>
  .editor-host {
    position: relative;
    height: 100%;
    min-width: 0;
    overflow: hidden;
    --grid-color: rgba(174, 79, 69, 0.48);
    --grid-strong: rgba(151, 61, 52, 0.7);
    --paper-ink: #342d29;
  }

  .native-input {
    position: absolute;
    z-index: 20;
    top: 0;
    left: 0;
    width: var(--cell-size);
    height: var(--cell-size);
    margin: 0;
    border: 0;
    border-radius: 0;
    padding: 0;
    resize: none;
    overflow: hidden;
    opacity: 0.002;
    color: transparent;
    caret-color: transparent;
    background: transparent;
    pointer-events: none;
    font-family: var(--manuscript-font);
    font-size: var(--writing-font-size);
    line-height: var(--cell-size);
  }

  .native-input:focus {
    border: 0;
    box-shadow: none;
    outline: 0;
  }

  .manuscript-scroll {
    height: 100%;
    min-width: 0;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    background:
      radial-gradient(
        circle at 50% -10%,
        color-mix(in srgb, var(--paper-raised) 76%, transparent),
        transparent 52%
      ),
      color-mix(in srgb, var(--paper-deep) 84%, #746b61);
  }

  .page-stack {
    width: max-content;
    min-width: 100%;
    padding: 56px 42px 120px;
  }

  .manuscript-page {
    position: relative;
    width: var(--paper-width);
    height: var(--paper-height);
    margin: 0 auto var(--page-gap);
    border: 1px solid rgba(92, 70, 55, 0.18);
    border-radius: 2px;
    background:
      radial-gradient(circle at 12% 18%, rgba(125, 101, 75, 0.025), transparent 28%),
      radial-gradient(circle at 78% 72%, rgba(125, 101, 75, 0.022), transparent 32%),
      #fffdf7;
    box-shadow:
      0 2px 4px rgba(49, 39, 29, 0.09),
      0 18px 50px rgba(49, 39, 29, 0.17);
    color: var(--paper-ink);
  }

  .manuscript-page.active-page {
    box-shadow:
      0 2px 4px rgba(49, 39, 29, 0.1),
      0 20px 55px rgba(49, 39, 29, 0.2);
  }

  .page-number,
  .page-caption {
    position: absolute;
    top: calc(var(--grid-top) / 2);
    color: rgba(135, 64, 57, 0.72);
    font-family: var(--ui-font);
    font-size: 11px;
    letter-spacing: 0.12em;
  }

  .page-number {
    right: var(--grid-left);
  }

  .page-caption {
    left: var(--grid-left);
  }

  .manuscript-grid {
    position: absolute;
    top: var(--grid-top);
    left: var(--grid-left);
    display: grid;
    grid-template-columns: repeat(20, var(--cell-size));
    grid-template-rows: repeat(20, var(--cell-size));
    row-gap: var(--row-gap);
    width: var(--grid-width);
    height: var(--grid-height);
    user-select: none;
  }

  .manuscript-cell {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: var(--cell-size);
    height: var(--cell-size);
    border-top: 1px solid var(--grid-color);
    border-bottom: 1px solid var(--grid-color);
    border-left: 1px solid var(--grid-color);
    color: var(--paper-ink);
    font-family: var(--manuscript-font);
    font-size: var(--writing-font-size);
    font-weight: 400;
    line-height: 1;
    text-align: center;
    cursor: text;
    transition:
      opacity 150ms ease,
      background-color 80ms ease;
  }

  .manuscript-cell:nth-child(20n) {
    border-right: 1px solid var(--grid-strong);
  }

  .manuscript-cell:nth-child(20n + 1) {
    border-left-color: var(--grid-strong);
  }

  .cell-text,
  .ghost-text {
    position: relative;
    z-index: 2;
    display: block;
    max-width: calc(var(--cell-size) - 3px);
    overflow: hidden;
    white-space: nowrap;
  }

  .manuscript-cell.selected::before {
    position: absolute;
    z-index: 1;
    inset: 1px;
    border-radius: 2px;
    background: rgba(177, 104, 75, 0.23);
    content: "";
  }

  .manuscript-cell.active-cell::after {
    position: absolute;
    z-index: 4;
    top: 4px;
    bottom: 4px;
    left: 3px;
    width: 2px;
    border-radius: 1px;
    background: #a34839;
    content: "";
    animation: caret-blink 1.08s steps(1) infinite;
  }

  .manuscript-cell.active-cell.caret-after::after {
    right: 2px;
    left: auto;
  }

  .markdown-syntax {
    color: #b47a70;
  }

  .markdown-heading {
    color: #27211e;
    font-weight: 650;
  }

  .markdown-link {
    color: #356d70;
    text-decoration: underline;
    text-decoration-color: rgba(53, 109, 112, 0.42);
    text-underline-offset: 3px;
  }

  .markdown-quote {
    color: #6f625a;
    font-style: italic;
  }

  .markdown-footnote {
    color: #80675f;
  }

  .tab-cell {
    color: rgba(150, 82, 72, 0.45);
    font-size: var(--tab-font-size);
  }

  .focus-dim {
    opacity: 0.2;
  }

  .ghost-text {
    color: rgba(114, 100, 91, 0.43);
  }

  @keyframes caret-blink {
    50% {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .manuscript-cell {
      transition: none;
    }

    .manuscript-cell.active-cell::after {
      animation: none;
    }
  }
</style>
