<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import {
    cellIndexForOffset,
    layoutManuscript,
    MANUSCRIPT_CELLS_PER_PAGE,
    pageIndexForOffset,
    type ManuscriptBlockPlacement,
    type ManuscriptCell,
  } from "./manuscript-layout";
  import type { ParsedManuscript } from "./manuscript-document";
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
    fallbackTitle?: string;
    fontFamily?: string;
    manuscriptZoom?: number;
    focusMode?: FocusMode;
    typewriterMode?: boolean;
    soundEnabled?: boolean;
    showDiagnostics?: boolean;
    onready?: (api: EditorApi | null) => void;
    onchange?: (value: string) => void;
    onselection?: (selection: SelectionInfo) => void;
    onactivity?: () => void;
    onghostaccept?: (text: string) => void;
    ondocument?: (document: ParsedManuscript) => void;
    onblockactivate?: (block: ManuscriptBlockPlacement) => void;
  }

  let {
    value,
    readOnly = false,
    fallbackTitle = "제목 없는 원고",
    fontFamily = "Pretendard",
    manuscriptZoom = 100,
    focusMode = "off",
    typewriterMode = true,
    soundEnabled = false,
    showDiagnostics = true,
    onready,
    onchange,
    onselection,
    onactivity,
    onghostaccept,
    ondocument,
    onblockactivate,
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
  let manuscript = $derived(layoutManuscript(internalValue, fallbackTitle));
  let pages = $derived(manuscript.pages);
  let activePageIndex = $derived(
    pageIndexForOffset(pages, selectionDirection === "backward" ? selectionFrom : selectionTo),
  );
  let activeCellIndex = $derived(
    cellIndexForOffset(
      pages[activePageIndex] ?? pages[0],
      selectionDirection === "backward" ? selectionFrom : selectionTo,
    ),
  );
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
    if (
      event.key === "Enter" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !readOnly
    ) {
      event.preventDefault();
      const insertion = event.shiftKey
        ? "\n"
        : paragraphBreakAt(selectionFrom, selectionTo);
      applyReplacement(selectionFrom, selectionTo, insertion);
      return;
    }
    if (
      !readOnly &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      selectionFrom === selectionTo
    ) {
      if (
        [")", "]", "”", "’", '"'].includes(event.key) &&
        internalValue.slice(selectionFrom, selectionFrom + 1) === event.key
      ) {
        event.preventDefault();
        setSelection(selectionFrom + 1, selectionFrom + 1);
        return;
      }
      const pairs: Record<string, string> = {
        "(": ")",
        "[": "]",
        "“": "”",
        "‘": "’",
        '"': '"',
      };
      const closing = pairs[event.key];
      if (closing) {
        event.preventDefault();
        applyReplacement(selectionFrom, selectionTo, `${event.key}${closing}`);
        setSelection(selectionFrom - 1, selectionFrom - 1, false);
        return;
      }
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

  function paragraphBreakAt(from: number, to: number): string {
    const before = internalValue.slice(0, from);
    const after = internalValue.slice(to);
    if (before.endsWith("\n") || after.startsWith("\n")) return "\n";
    return "\n\n";
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

  function activateBlock(
    event: MouseEvent,
    block: ManuscriptBlockPlacement,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    setNativeSelection(block.from, block.to);
    onblockactivate?.(block);
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
    if (
      !cell.filled ||
      cell.virtual ||
      cell.tabContinuation ||
      cell.blockContinuation
    ) {
      return cell.caretOffset;
    }
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

  function blockIsActive(block: ManuscriptBlockPlacement): boolean {
    const head =
      selectionDirection === "backward" ? selectionFrom : selectionTo;
    return head >= block.from && head <= block.to;
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
    const targetCell = pages[pageIndex]?.cells[cellIndex];
    if (targetCell?.virtual || targetCell?.blockContinuation) return "";
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
    if (!mounted) return;
    ondocument?.(manuscript.document);
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
                  class:style-title={cell.style === "title"}
                  class:style-subtitle={cell.style === "subtitle"}
                  class:style-metadata={cell.style === "metadata"}
                  class:style-heading={cell.style === "heading"}
                  class:style-strong={cell.style === "strong"}
                  class:style-emphasis={cell.style === "emphasis"}
                  class:style-link={cell.style === "link"}
                  class:style-code={cell.style === "code"}
                  class:style-quote={cell.style === "quote"}
                  class:style-footnote={cell.style === "footnote"}
                  class:compact-cell={cell.compact}
                  class:virtual-cell={cell.virtual}
                  class:block-reserved={cell.blockContinuation}
                  class:diagnostic-error={showDiagnostics && cell.diagnosticSeverity === "error"}
                  class:diagnostic-warning={showDiagnostics && cell.diagnosticSeverity === "warning"}
                  class:diagnostic-suggestion={showDiagnostics && cell.diagnosticSeverity === "suggestion"}
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
              {#each page.blocks as block (block.id)}
                <button
                  class:active={blockIsActive(block)}
                  class={`manuscript-block block-${block.kind}`}
                  style={`grid-row: ${block.row + 1} / span ${block.rows}; grid-column: 1 / -1;`}
                  title="클릭해서 문서 요소 편집"
                  onclick={(event) => activateBlock(event, block)}
                >
                  <span class="block-kind">
                    {block.kind === "figure"
                      ? "그림"
                      : block.kind === "table"
                        ? "표"
                        : block.kind === "math"
                          ? "수식"
                          : block.kind === "footnote"
                            ? "각주"
                            : block.kind === "code"
                              ? "코드"
                              : block.kind === "divider"
                                ? "구분"
                                : "확인"}
                  </span>
                  <span class="block-copy">
                    <strong>{block.label}</strong>
                    {#if block.detail}<small>{block.detail}</small>{/if}
                  </span>
                  <span class="block-edit">편집</span>
                </button>
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

  .style-title {
    color: #27211e;
    font-size: calc(var(--writing-font-size) * 1.05);
    font-weight: 700;
  }

  .style-subtitle,
  .style-metadata {
    color: #725e55;
    font-size: calc(var(--writing-font-size) * 0.78);
  }

  .style-heading,
  .style-strong {
    color: #27211e;
    font-weight: 680;
  }

  .style-link {
    color: #356d70;
    text-decoration: underline;
    text-decoration-color: rgba(53, 109, 112, 0.42);
    text-underline-offset: 3px;
  }

  .style-quote,
  .style-emphasis {
    color: #6f625a;
    font-style: italic;
  }

  .style-footnote {
    color: #80675f;
    font-size: calc(var(--writing-font-size) * 0.58);
  }

  .style-code {
    color: #466267;
    font-family: NanumGothicCoding, monospace;
    font-size: calc(var(--writing-font-size) * 0.66);
  }

  .compact-cell {
    font-size: calc(var(--writing-font-size) * 0.62);
    letter-spacing: -0.04em;
  }

  .virtual-cell {
    cursor: default;
  }

  .block-reserved .cell-text {
    display: none;
  }

  .diagnostic-error::after,
  .diagnostic-warning::after,
  .diagnostic-suggestion::after {
    position: absolute;
    z-index: 3;
    right: 4px;
    bottom: 3px;
    left: 4px;
    height: 2px;
    border-radius: 2px;
    content: "";
  }

  .diagnostic-error::after {
    background: #b84b43;
  }

  .diagnostic-warning::after {
    background: #c07b35;
  }

  .diagnostic-suggestion::after {
    background: rgba(82, 110, 112, 0.58);
  }

  .manuscript-cell.active-cell.diagnostic-error::after,
  .manuscript-cell.active-cell.diagnostic-warning::after,
  .manuscript-cell.active-cell.diagnostic-suggestion::after {
    right: auto;
    bottom: 4px;
    left: 3px;
    width: 2px;
    height: auto;
    background: #a34839;
  }

  .manuscript-block {
    z-index: 8;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    align-self: stretch;
    gap: 11px;
    margin: 4px 5px;
    border: 1px solid rgba(151, 61, 52, 0.42);
    border-radius: 7px;
    background:
      linear-gradient(
        135deg,
        rgba(255, 253, 247, 0.96),
        rgba(246, 238, 226, 0.94)
      );
    padding: 10px 13px;
    box-shadow: 0 5px 16px rgba(72, 48, 34, 0.1);
    color: #4c4039;
    text-align: left;
  }

  .manuscript-block:hover,
  .manuscript-block.active {
    border-color: rgba(151, 61, 52, 0.72);
    box-shadow: 0 7px 19px rgba(72, 48, 34, 0.15);
  }

  .block-kind {
    display: grid;
    place-items: center;
    min-width: 42px;
    height: 28px;
    border-radius: 14px;
    background: rgba(151, 61, 52, 0.1);
    color: #97453d;
    font-family: var(--ui-font);
    font-size: calc(var(--tab-font-size) * 0.86);
    font-weight: 750;
  }

  .block-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 3px;
  }

  .block-copy strong,
  .block-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .block-copy strong {
    font-family: var(--manuscript-font);
    font-size: calc(var(--writing-font-size) * 0.7);
  }

  .block-copy small,
  .block-edit {
    color: #8a756a;
    font-family: var(--ui-font);
    font-size: calc(var(--tab-font-size) * 0.82);
  }

  .block-edit {
    color: #9c4b42;
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
