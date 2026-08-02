<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import {
    caretPlacementForOffset,
    layoutManuscript,
    MANUSCRIPT_CELLS_PER_PAGE,
    MANUSCRIPT_COLUMNS,
    sameCaretPlacement,
    type ManuscriptCaretAffinity,
    type ManuscriptCaretPlacement,
    type ManuscriptBlockPlacement,
    type ManuscriptCell,
    type ManuscriptLayout,
  } from "./manuscript-layout";
  import type {
    ManuscriptLayoutRequest,
    ManuscriptLayoutResponse,
  } from "./manuscript-layout.worker";
  import {
    projectManuscriptEdit,
    projectedPagesForRender,
    type ManuscriptOptimisticProjection,
  } from "./manuscript-projection";
  import {
    createDiagnosticIndex,
    diagnosticSeverityForRange,
  } from "./diagnostic-index";
  import type { WritingDiagnostic } from "./manuscript-document";
  import { sentenceRange } from "./markdown";
  import {
    calculateManuscriptFitScale,
    MANUSCRIPT_GUTTER_BOTTOM,
    MANUSCRIPT_GUTTER_TOP,
    MANUSCRIPT_GUTTER_X,
    MANUSCRIPT_PAGE_BORDER,
    MANUSCRIPT_PAPER_HEIGHT,
    MANUSCRIPT_PAPER_WIDTH,
  } from "./manuscript-fit";
  import type {
    EditorChangeContext,
    EditorSelection as SelectionInfo,
    FocusMode,
    ManuscriptFitMode,
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
    manuscriptFitMode?: ManuscriptFitMode;
    focusMode?: FocusMode;
    typewriterMode?: boolean;
    soundEnabled?: boolean;
    singleSheetMode?: boolean;
    typewriterImperfection?: boolean;
    showDiagnostics?: boolean;
    diagnostics?: WritingDiagnostic[];
    onready?: (api: EditorApi | null) => void;
    onchange?: (value: string, context: EditorChangeContext) => void;
    onselection?: (selection: SelectionInfo) => void;
    onactivity?: () => void;
    onghostaccept?: (text: string) => void;
    onblockactivate?: (block: ManuscriptBlockPlacement) => void;
  }

  let {
    value,
    readOnly = false,
    fallbackTitle = "제목 없는 원고",
    fontFamily = "Pretendard",
    manuscriptFitMode = "page",
    focusMode = "off",
    typewriterMode = true,
    soundEnabled = false,
    singleSheetMode = false,
    typewriterImperfection = false,
    showDiagnostics = true,
    diagnostics = [],
    onready,
    onchange,
    onselection,
    onactivity,
    onghostaccept,
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
  let caretAffinity = $state<ManuscriptCaretAffinity>("forward");
  let focused = $state(false);
  let ghostText = $state("");
  let visibleStart = $state(0);
  let visibleEnd = $state(4);
  let inputLeft = $state(0);
  let inputTop = $state(0);
  let dragAnchor: number | null = null;
  let scrollFrame: number | null = null;
  let caretFrame: number | null = null;
  let viewportFrame: number | null = null;
  let viewportObserver: ResizeObserver | null = null;
  let caretScrollRequested = false;
  let composing = false;
  let contentRevision = 0;
  let lastSelectionSignature = "";
  let audioContext: AudioContext | null = null;
  let pendingPageAnnounce = false;
  let manuscript = $state<ManuscriptLayout>(
    layoutManuscript("", "제목 없는 원고"),
  );
  let manuscriptSource = "";
  let requestedLayoutSource = "";
  let requestedLayoutTitle = "";
  let layoutWorker: Worker | null = null;
  let layoutWorkerBusy = false;
  let queuedLayout: ManuscriptLayoutRequest | null = null;
  let layoutRevision = 0;
  let layoutPending = $state(false);
  let optimisticProjection = $state<ManuscriptOptimisticProjection | null>(
    null,
  );
  let viewportWidth = $state(
    MANUSCRIPT_PAPER_WIDTH + MANUSCRIPT_GUTTER_X * 2 + MANUSCRIPT_PAGE_BORDER,
  );
  let viewportHeight = $state(
    MANUSCRIPT_PAPER_HEIGHT +
      MANUSCRIPT_GUTTER_TOP +
      MANUSCRIPT_GUTTER_BOTTOM +
      MANUSCRIPT_PAGE_BORDER,
  );

  let manuscriptScale = $derived(
    calculateManuscriptFitScale(
      { width: viewportWidth, height: viewportHeight },
      manuscriptFitMode,
    ),
  );
  let pages = $derived(manuscript.pages);
  let renderPages = $derived(projectedPagesForRender(pages, optimisticProjection));
  let lineStarts = $derived(lineStartOffsets(internalValue));
  let diagnosticIndex = $derived(
    createDiagnosticIndex(showDiagnostics ? diagnostics : []),
  );
  let activeCaretOffset = $derived(
    selectionDirection === "backward" ? selectionFrom : selectionTo,
  );
  let activeCaretPlacement = $derived(
    caretPlacementForOffset(manuscript, activeCaretOffset, caretAffinity),
  );
  let visualCaretPlacement = $derived(
    optimisticProjection &&
      selectionFrom === selectionTo &&
      activeCaretOffset === optimisticProjection.caretOffset
      ? optimisticProjection.caret
      : activeCaretPlacement,
  );
  let activePageIndex = $derived(visualCaretPlacement.pageIndex);
  let activeCellIndex = $derived(visualCaretPlacement.cellIndex);
  let activeFocusRange = $derived(
    focusRange(internalValue, selectionFrom, selectionTo, focusMode),
  );
  let ghostGraphemes = $derived(segmentGraphemes(ghostText));

  function selectionInfo(): SelectionInfo {
    const from = Math.min(selectionFrom, selectionTo);
    const to = Math.max(selectionFrom, selectionTo);
    const head =
      selectionDirection === "backward" ? selectionFrom : selectionTo;
    const line = lineNumberAtOffset(lineStarts, head);
    const page = activePageIndex + 1;
    const cell = renderPages[activePageIndex]?.cells[activeCellIndex];
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
    if (notify) {
      const signature = `${selectionFrom}:${selectionTo}:${selectionDirection}:${contentRevision}`;
      if (signature !== lastSelectionSignature) {
        lastSelectionSignature = signature;
        onselection?.(selectionInfo());
      }
    }
    scheduleCaretPosition();
  }

  function commitInput(
    playSound = true,
    context: EditorChangeContext = { composing: false },
    forceNotify = false,
  ): void {
    if (!input) return;
    const changed = input.value !== internalValue;
    if (changed) {
      internalValue = input.value;
      contentRevision += 1;
      caretAffinity = "forward";
      pendingPageAnnounce = true;
      requestManuscriptLayout(
        internalValue,
        input.selectionDirection === "backward"
          ? input.selectionStart
          : input.selectionEnd,
      );
    }
    ghostText = "";
    syncSelection();
    if (changed || forceNotify) onchange?.(internalValue, context);
    if (!context.composing && (changed || forceNotify)) onactivity?.();
    if (playSound && (changed || forceNotify) && !context.composing) {
      playKeystroke();
    }
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

  function setSelection(
    from: number,
    to: number,
    scroll = true,
    affinity: ManuscriptCaretAffinity = from <= to ? "forward" : "backward",
  ): void {
    if (!input) return;
    const start = Math.max(0, Math.min(from, internalValue.length));
    const end = Math.max(0, Math.min(to, internalValue.length));
    input.setSelectionRange(start, end);
    caretAffinity = affinity;
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

  function handleInput(event: Event): void {
    commitInput(true, {
      composing: (event as InputEvent).isComposing || composing,
    });
  }

  function handleCompositionStart(): void {
    composing = true;
  }

  function handleCompositionEnd(): void {
    composing = false;
    commitInput(true, { composing: false }, true);
  }

  const ASYNC_LAYOUT_THRESHOLD = 4_000;

  function startLayoutWorker(): void {
    if (typeof Worker === "undefined") return;
    try {
      layoutWorker = new Worker(
        new URL("./manuscript-layout.worker.ts", import.meta.url),
        { type: "module", name: "manuscript-layout" },
      );
      layoutWorker.onmessage = (
        event: MessageEvent<ManuscriptLayoutResponse>,
      ) => {
        layoutWorkerBusy = false;
        const response = event.data;
        if (response.revision === layoutRevision) {
          commitManuscript(response.layout);
          manuscriptSource = response.source;
          layoutPending = false;
          optimisticProjection = null;
          scheduleCaretScroll();
        }
        pumpLayoutWorker();
      };
      layoutWorker.onerror = () => {
        layoutWorker?.terminate();
        layoutWorker = null;
        layoutWorkerBusy = false;
        queuedLayout = null;
        applyLayoutSynchronously(internalValue, fallbackTitle);
      };
    } catch {
      layoutWorker = null;
    }
  }

  function pumpLayoutWorker(): void {
    if (!layoutWorker || layoutWorkerBusy || !queuedLayout) return;
    const request = queuedLayout;
    queuedLayout = null;
    layoutWorkerBusy = true;
    layoutWorker.postMessage(request);
  }

  function commitManuscript(next: ManuscriptLayout): void {
    const shouldAnnounce = pendingPageAnnounce;
    pendingPageAnnounce = false;
    if (shouldAnnounce && next.pages.length > manuscript.pages.length) {
      playPageComplete();
    }
    manuscript = next;
  }

  function applyLayoutSynchronously(source: string, title: string): void {
    commitManuscript(layoutManuscript(source, title));
    manuscriptSource = source;
    requestedLayoutSource = source;
    requestedLayoutTitle = title;
    layoutPending = false;
    optimisticProjection = null;
  }

  function requestManuscriptLayout(
    source: string,
    caretOffset = source.length,
    force = false,
  ): void {
    const title = fallbackTitle;
    if (
      !force &&
      source === requestedLayoutSource &&
      title === requestedLayoutTitle
    ) {
      return;
    }
    requestedLayoutSource = source;
    requestedLayoutTitle = title;
    layoutRevision += 1;

    if (!layoutWorker || source.length < ASYNC_LAYOUT_THRESHOLD) {
      queuedLayout = null;
      applyLayoutSynchronously(source, title);
      return;
    }

    optimisticProjection = projectManuscriptEdit(
      manuscript,
      manuscriptSource,
      source,
      caretOffset,
    );
    layoutPending = true;
    queuedLayout = {
      revision: layoutRevision,
      source,
      fallbackTitle: title,
    };
    pumpLayoutWorker();
  }

  function selectionHead(): number {
    return selectionDirection === "backward" ? selectionFrom : selectionTo;
  }

  function moveSelectionHead(
    offset: number,
    affinity: ManuscriptCaretAffinity,
    extend: boolean,
  ): void {
    const safeOffset = Math.max(0, Math.min(offset, internalValue.length));
    caretAffinity = affinity;
    if (!extend) {
      setSelection(safeOffset, safeOffset, true, affinity);
      return;
    }
    const anchor =
      selectionFrom === selectionTo
        ? selectionFrom
        : selectionDirection === "backward"
          ? selectionTo
          : selectionFrom;
    setNativeSelection(anchor, safeOffset);
    scheduleCaretScroll();
  }

  function moveHorizontal(direction: -1 | 1, extend: boolean): void {
    if (!extend && selectionFrom !== selectionTo) {
      moveSelectionHead(
        direction < 0 ? selectionFrom : selectionTo,
        direction < 0 ? "backward" : "forward",
        false,
      );
      return;
    }
    const affinity: ManuscriptCaretAffinity =
      direction < 0 ? "backward" : "forward";
    const head = selectionHead();
    const current = caretPlacementForOffset(manuscript, head, affinity);
    let next = head + direction;
    while (next >= 0 && next <= internalValue.length) {
      const candidate = caretPlacementForOffset(manuscript, next, affinity);
      if (!sameCaretPlacement(current, candidate)) break;
      next += direction;
    }
    moveSelectionHead(
      Math.max(0, Math.min(next, internalValue.length)),
      affinity,
      extend,
    );
  }

  function cellOffset(
    page: number,
    cellIndex: number,
    ratio: number,
    preferEnd = false,
  ): number {
    const cells = pages[page]?.cells;
    if (!cells?.length) return selectionHead();
    let safeIndex = Math.max(0, Math.min(cellIndex, cells.length - 1));
    const rowStart = Math.floor(safeIndex / MANUSCRIPT_COLUMNS) * MANUSCRIPT_COLUMNS;
    const rowEnd = rowStart + MANUSCRIPT_COLUMNS;
    while (
      safeIndex < rowEnd &&
      (cells[safeIndex].virtual || cells[safeIndex].tabContinuation)
    ) {
      safeIndex += 1;
    }
    const cell = cells[Math.min(safeIndex, rowEnd - 1)];
    if (cell.blockContinuation) return preferEnd ? cell.to : cell.from;
    if (cell.caretStops?.length) {
      const slot = preferEnd
        ? cell.caretStops.length - 1
        : Math.max(
            0,
            Math.min(
              cell.caretStops.length - 1,
              Math.round(ratio * (cell.caretStops.length - 1)),
            ),
          );
      return cell.caretStops[slot];
    }
    return cell.caretOffset;
  }

  function moveVertical(rows: number, extend: boolean): void {
    const current = caretPlacementForOffset(
      manuscript,
      selectionHead(),
      caretAffinity,
    );
    const currentCell = pages[current.pageIndex]?.cells[current.cellIndex];
    if (!currentCell) return;
    const absoluteRow =
      current.pageIndex * 20 + currentCell.row + rows;
    const maxRow = pages.length * 20 - 1;
    const targetRow = Math.max(0, Math.min(absoluteRow, maxRow));
    const targetPage = Math.floor(targetRow / 20);
    const targetCell =
      (targetRow % 20) * MANUSCRIPT_COLUMNS + currentCell.column;
    const ratio = current.slot / Math.max(1, current.slotCount);
    moveSelectionHead(
      cellOffset(targetPage, targetCell, ratio),
      rows < 0 ? "backward" : "forward",
      extend,
    );
  }

  function moveToRowEdge(end: boolean, extend: boolean): void {
    const current = caretPlacementForOffset(
      manuscript,
      selectionHead(),
      caretAffinity,
    );
    const cells = pages[current.pageIndex]?.cells;
    if (!cells) return;
    const row = Math.floor(current.cellIndex / MANUSCRIPT_COLUMNS);
    const start = row * MANUSCRIPT_COLUMNS;
    if (!end) {
      moveSelectionHead(
        cellOffset(current.pageIndex, start, 0),
        "backward",
        extend,
      );
      return;
    }
    let last = start + MANUSCRIPT_COLUMNS - 1;
    while (
      last > start &&
      !cells[last].filled &&
      !cells[last].blockContinuation
    ) {
      last -= 1;
    }
    moveSelectionHead(
      cellOffset(current.pageIndex, last, 1, true),
      "forward",
      extend,
    );
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && ghostText) {
      event.preventDefault();
      clearGhostText();
      return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        moveHorizontal(event.key === "ArrowLeft" ? -1 : 1, event.shiftKey);
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        moveVertical(event.key === "ArrowUp" ? -1 : 1, event.shiftKey);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        moveToRowEdge(event.key === "End", event.shiftKey);
        return;
      }
      if (event.key === "PageUp" || event.key === "PageDown") {
        event.preventDefault();
        moveVertical(event.key === "PageUp" ? -20 : 20, event.shiftKey);
        return;
      }
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
      if (event.shiftKey) playKeystroke();
      else playCarriageReturn();
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
    const ratio = Math.max(
      0,
      Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)),
    );
    if (cell.caretStops?.length) {
      const slot = Math.max(
        0,
        Math.min(
          cell.caretStops.length - 1,
          Math.round(ratio * (cell.caretStops.length - 1)),
        ),
      );
      return cell.caretStops[slot];
    }
    return ratio >= 0.5 ? cell.to : cell.from;
  }

  function setNativeSelection(anchor: number, head: number): void {
    if (!input) return;
    const from = Math.max(0, Math.min(anchor, head, internalValue.length));
    const to = Math.max(0, Math.min(Math.max(anchor, head), internalValue.length));
    const direction = head < anchor ? "backward" : "forward";
    input.setSelectionRange(from, to, direction);
    caretAffinity = head < anchor ? "backward" : "forward";
    syncSelection();
    input.focus({ preventScroll: true });
    scheduleCaretScroll();
  }

  function handleScroll(): void {
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      if (!scroller) return;
      const firstPage =
        scroller.querySelector<HTMLElement>(".manuscript-page");
      const pageStride = firstPage
        ? firstPage.offsetHeight +
          Number.parseFloat(getComputedStyle(firstPage).marginBottom)
        : 1_236 * manuscriptScale;
      const first = Math.max(
        0,
        Math.floor(
          (scroller.scrollTop - MANUSCRIPT_GUTTER_TOP) / pageStride,
        ),
      );
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

  function optimisticCharacter(pageIndex: number, cellIndex: number): string {
    const absolute =
      pageIndex * MANUSCRIPT_CELLS_PER_PAGE + cellIndex;
    return optimisticProjection?.cells[absolute] ?? "";
  }

  function cellIsOptimisticallyDeleted(cell: ManuscriptCell): boolean {
    const projection = optimisticProjection;
    if (!projection || projection.deletedFrom === projection.deletedTo) {
      return false;
    }
    return (
      cell.filled &&
      cell.from < projection.deletedTo &&
      cell.to > projection.deletedFrom
    );
  }

  function scheduleCaretScroll(): void {
    caretScrollRequested = true;
    scheduleCaretFrame();
  }

  function scheduleCaretPosition(): void {
    scheduleCaretFrame();
  }

  function scheduleCaretFrame(): void {
    if (caretFrame !== null) return;
    caretFrame = requestAnimationFrame(async () => {
      caretFrame = null;
      await tick();
      const caret = host?.querySelector<HTMLElement>("[data-caret='true']");
      if (!caret || !host) return;
      if (caretScrollRequested) {
        caretScrollRequested = false;
        caret.scrollIntoView({
          block: typewriterMode ? "center" : "nearest",
          inline: "nearest",
          behavior: "auto",
        });
      }
      const caretRect = caret.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      const slotRatio =
        visualCaretPlacement.slot /
        Math.max(1, visualCaretPlacement.slotCount);
      inputLeft =
        caretRect.left - hostRect.left + caretRect.width * slotRatio;
      inputTop = caretRect.top - hostRect.top;
    });
  }

  function ensureAudioContext(): AudioContext | null {
    const AudioContextClass =
      window.AudioContext ??
      (
        window as typeof window & {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;
    if (!AudioContextClass) return null;
    const context = audioContext ?? new AudioContextClass();
    audioContext = context;
    if (context.state === "suspended") void context.resume();
    return context;
  }

  function playKeystroke(): void {
    if (!soundEnabled) return;
    try {
      const context = ensureAudioContext();
      if (!context) return;
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
    } catch {
      // Keystroke sound is optional and must never block writing.
    }
  }

  function playCarriageReturn(): void {
    if (!soundEnabled) return;
    try {
      const context = ensureAudioContext();
      if (!context) return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(260, context.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(
        120,
        context.currentTime + 0.11,
      );
      gain.gain.setValueAtTime(0.05, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        context.currentTime + 0.13,
      );
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.14);
    } catch {
      // Carriage-return sound is optional and must never block writing.
    }
  }

  function playPageComplete(): void {
    if (!soundEnabled) return;
    try {
      const context = ensureAudioContext();
      if (!context) return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 920;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.linearRampToValueAtTime(0.045, context.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        context.currentTime + 0.5,
      );
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.52);
    } catch {
      // Page-complete chime is optional and must never block writing.
    }
  }

  function segmentGraphemes(text: string): string[] {
    if (!text) return [];
    if (graphemeSegmenter) {
      return Array.from(
        graphemeSegmenter.segment(text),
        (entry) => entry.segment,
      );
    }
    return Array.from(text);
  }

  function paperGrainSeed(pageNumber: number, salt: number): number {
    const value = Math.sin(pageNumber * 12.9898 + salt * 78.233) * 43758.5453;
    return value - Math.floor(value);
  }

  function paperGrainStyle(pageNumber: number): string {
    const x1 = (6 + paperGrainSeed(pageNumber, 1) * 18).toFixed(1);
    const y1 = (8 + paperGrainSeed(pageNumber, 2) * 22).toFixed(1);
    const x2 = (66 + paperGrainSeed(pageNumber, 3) * 22).toFixed(1);
    const y2 = (58 + paperGrainSeed(pageNumber, 4) * 26).toFixed(1);
    const stampTilt = (paperGrainSeed(pageNumber, 5) * 3 - 1.5).toFixed(2);
    return `--blot-1: ${x1}% ${y1}%; --blot-2: ${x2}% ${y2}%; --stamp-tilt: ${stampTilt}deg;`;
  }

  const glyphJitterVariants = Array.from({ length: 64 }, (_, seed) => {
    const dx = (paperGrainSeed(seed, 8) - 0.5) * 1.4;
    const dy = (paperGrainSeed(seed, 9) - 0.5) * 2.6;
    const rotation = (paperGrainSeed(seed, 10) - 0.5) * 3.2;
    const inkStrength = (0.86 + paperGrainSeed(seed, 11) * 0.14).toFixed(2);
    return `transform: translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) rotate(${rotation.toFixed(2)}deg); opacity: ${inkStrength};`;
  });

  function glyphJitterStyle(
    pageIndex: number,
    cellIndex: number,
  ): string | undefined {
    if (!typewriterImperfection) return undefined;
    return glyphJitterVariants[
      (pageIndex * 17 + cellIndex) % glyphJitterVariants.length
    ];
  }

  function lineStartOffsets(content: string): number[] {
    const result = [0];
    for (let index = 0; index < content.length; index += 1) {
      if (content[index] === "\n") result.push(index + 1);
    }
    return result;
  }

  function lineNumberAtOffset(starts: number[], offset: number): number {
    const safeOffset = Math.max(0, offset);
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (starts[middle] <= safeOffset) low = middle + 1;
      else high = middle;
    }
    return Math.max(1, low);
  }

  function measureViewport(): void {
    viewportFrame = null;
    if (!scroller) return;
    const width = scroller.clientWidth;
    const height = scroller.clientHeight;
    if (width > 0) viewportWidth = width;
    if (height > 0) viewportHeight = height;
  }

  function scheduleViewportMeasurement(): void {
    if (viewportFrame !== null) return;
    viewportFrame = requestAnimationFrame(measureViewport);
  }

  const graphemeSegmenter =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter("ko", { granularity: "grapheme" })
      : null;

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
    startLayoutWorker();
    internalValue = value;
    contentRevision += 1;
    input.value = value;
    input.setSelectionRange(0, 0);
    requestManuscriptLayout(value, 0, true);
    syncSelection();
    onready?.(createApi());
    const endDrag = () => {
      dragAnchor = null;
    };
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("resize", scheduleViewportMeasurement);
    if (typeof ResizeObserver !== "undefined") {
      viewportObserver = new ResizeObserver(scheduleViewportMeasurement);
      viewportObserver.observe(scroller);
    }
    scheduleViewportMeasurement();
    scheduleCaretPosition();
    return () => {
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("resize", scheduleViewportMeasurement);
    };
  });

  $effect(() => {
    const externalValue = value;
    const externalTitle = fallbackTitle;
    if (!mounted || !input) return;
    if (externalValue !== internalValue) {
      const head = Math.min(selectionTo, externalValue.length);
      internalValue = externalValue;
      contentRevision += 1;
      composing = false;
      input.value = externalValue;
      input.setSelectionRange(head, head);
      syncSelection();
    }
    if (
      externalValue !== requestedLayoutSource ||
      externalTitle !== requestedLayoutTitle
    ) {
      requestManuscriptLayout(externalValue, selectionTo);
    }
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
    if (caretFrame !== null) cancelAnimationFrame(caretFrame);
    if (viewportFrame !== null) cancelAnimationFrame(viewportFrame);
    viewportObserver?.disconnect();
    viewportObserver = null;
    if (audioContext) void audioContext.close();
    layoutWorker?.terminate();
    layoutWorker = null;
    onready?.(null);
  });
</script>

<div
  class:focused
  class:layout-pending={layoutPending}
  class="editor-host"
  bind:this={host}
  style={[
    `--manuscript-font: "${fontFamily.replaceAll('"', '\\"')}", Pretendard, sans-serif`,
    `--page-gutter-x: ${MANUSCRIPT_GUTTER_X}px`,
    `--page-gutter-top: ${MANUSCRIPT_GUTTER_TOP}px`,
    `--page-gutter-bottom: ${MANUSCRIPT_GUTTER_BOTTOM}px`,
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
    oncompositionstart={handleCompositionStart}
    oncompositionend={handleCompositionEnd}
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
    <div class:single-sheet={singleSheetMode} class="page-stack">
      {#each renderPages as page, pageIndex (page.number)}
        {#if !singleSheetMode || pageIndex === activePageIndex}
        <section
          class:active-page={pageIndex === activePageIndex}
          class="manuscript-page"
          aria-label={`원고지 ${page.number}쪽`}
          style={paperGrainStyle(page.number)}
        >
          <span class="page-number">
            <span class="page-number-stamp">제 {page.number}매</span>
            <span class="page-number-total">/ 총 {renderPages.length}매</span>
          </span>
          <div class="page-caption">20 × 20</div>
          <div class="manuscript-grid">
            {#if pageIsRendered(pageIndex)}
              {#each page.cells as cell, cellIndex (cell.index)}
                {@const ghost = ghostCharacter(pageIndex, cellIndex)}
                {@const optimistic = optimisticCharacter(pageIndex, cellIndex)}
                {@const diagnosticSeverity =
                  showDiagnostics && (cell.filled || cell.blockContinuation)
                    ? diagnosticSeverityForRange(
                        diagnosticIndex,
                        cell.from,
                        cell.to,
                      )
                    : undefined}
                <span
                  class:active-cell={isActiveCell(pageIndex, cellIndex)}
                  class:selected={cellIsSelected(cell)}
                  class:optimistic-cell={Boolean(optimistic)}
                  class:optimistic-deleted={cellIsOptimisticallyDeleted(cell)}
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
                  class:diagnostic-error={diagnosticSeverity === "error"}
                  class:diagnostic-warning={diagnosticSeverity === "warning"}
                  class:diagnostic-suggestion={diagnosticSeverity === "suggestion"}
                  class:focus-dim={cellIsDimmed(cell)}
                  class:tab-cell={cell.text === "⇥" || cell.tabContinuation}
                  class="manuscript-cell"
                  role="presentation"
                  data-caret={isActiveCell(pageIndex, cellIndex) ? "true" : undefined}
                  data-cell-index={cellIndex}
                  data-page-index={pageIndex}
                  style={isActiveCell(pageIndex, cellIndex)
                    ? `--caret-x: ${(visualCaretPlacement.slot / Math.max(1, visualCaretPlacement.slotCount)) * 100}%`
                    : undefined}
                  onpointerdown={(event) => beginCellSelection(event, cell)}
                  onpointerenter={(event) => extendCellSelection(event, cell)}
                >
                  {#if optimistic}
                    <span class="cell-text optimistic-text">{optimistic}</span>
                  {:else if cell.text}
                    <span
                      class="cell-text"
                      style={glyphJitterStyle(pageIndex, cellIndex)}
                    >{cell.text}</span>
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
        {/if}
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
    --grid-color: rgba(157, 65, 56, 0.4);
    --grid-strong: rgba(142, 54, 47, 0.65);
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
    background-color: var(--desk);
    background-image:
      var(--hanji-texture),
      radial-gradient(
        circle at 50% -10%,
        color-mix(in srgb, white 22%, transparent),
        transparent 52%
      ),
      linear-gradient(
        110deg,
        color-mix(in srgb, var(--desk) 88%, #756d62),
        var(--desk) 42%,
        color-mix(in srgb, var(--desk) 92%, #b9b0a4)
      );
    background-blend-mode: soft-light, normal, normal;
    background-size: 320px 320px, auto, auto;
  }

  .page-stack {
    box-sizing: border-box;
    width: max-content;
    min-width: 100%;
    padding: var(--page-gutter-top) var(--page-gutter-x)
      var(--page-gutter-bottom);
  }

  .page-stack.single-sheet {
    display: flex;
    align-items: center;
    justify-content: center;
    width: max-content;
    min-height: 100%;
  }

  .page-stack.single-sheet .manuscript-page {
    margin: 0;
    animation: page-feed 420ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .manuscript-page {
    position: relative;
    width: var(--paper-width);
    height: var(--paper-height);
    margin: 0 auto var(--page-gap);
    border: 1px solid color-mix(in srgb, var(--sheet-edge) 70%, transparent);
    border-radius: 2px;
    background-color: var(--sheet);
    background-image:
      var(--hanji-texture),
      radial-gradient(circle at var(--blot-1, 12% 18%), rgba(125, 101, 75, 0.025), transparent 28%),
      radial-gradient(circle at var(--blot-2, 78% 72%), rgba(125, 101, 75, 0.022), transparent 32%),
      linear-gradient(105deg, rgba(118, 94, 70, 0.018), transparent 32%, rgba(255, 255, 255, 0.16));
    background-blend-mode: multiply, normal, normal, normal;
    background-size: 320px 320px, auto, auto, auto;
    box-shadow:
      var(--shadow-paper),
      inset 0 0 0 1px rgba(255, 255, 255, 0.45);
    color: var(--paper-ink);
  }

  .manuscript-page.active-page {
    box-shadow:
      0 1px 2px rgba(49, 39, 29, 0.15),
      0 18px 42px rgba(49, 39, 29, 0.19),
      inset 0 0 0 1px rgba(255, 255, 255, 0.5);
  }

  .page-caption {
    position: absolute;
    top: calc(var(--grid-top) / 2);
    left: var(--grid-left);
    color: rgba(135, 64, 57, 0.72);
    font-family: var(--ui-font);
    font-size: 11px;
    letter-spacing: 0.12em;
  }

  .page-number {
    position: absolute;
    top: calc(var(--grid-top) / 2 - 3px);
    right: var(--grid-left);
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-family: var(--ui-font);
  }

  .page-number-stamp {
    display: inline-block;
    border: 1.5px solid rgba(151, 61, 52, 0.55);
    border-radius: 3px;
    padding: 1px 7px;
    color: rgba(151, 61, 52, 0.78);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.1em;
    transform: rotate(var(--stamp-tilt, -1deg));
  }

  .page-number-total {
    color: rgba(135, 64, 57, 0.5);
    font-size: 10px;
    letter-spacing: 0.08em;
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

  .manuscript-cell.optimistic-deleted .cell-text {
    opacity: 0;
  }

  .manuscript-cell .optimistic-text {
    opacity: 1;
  }

  .manuscript-cell.active-cell::after {
    position: absolute;
    z-index: 4;
    top: 4px;
    bottom: 4px;
    left: clamp(3px, var(--caret-x, 3px), calc(100% - 2px));
    width: 2px;
    border-radius: 1px;
    background: #a34839;
    content: "";
    transform: translateX(-1px);
    animation: caret-blink 1.08s steps(1) infinite;
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

  @keyframes page-feed {
    from {
      transform: translateY(46px);
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

    .page-stack.single-sheet .manuscript-page {
      animation: none;
    }
  }
</style>
