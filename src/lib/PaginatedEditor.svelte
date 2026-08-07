<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { Editor as TiptapEditor, type JSONContent } from "@tiptap/core";
  import StarterKit from "@tiptap/starter-kit";
  import { Markdown } from "@tiptap/markdown";
  import { TableKit } from "@tiptap/extension-table";
  import Image from "@tiptap/extension-image";
  import TaskList from "@tiptap/extension-task-list";
  import TaskItem from "@tiptap/extension-task-item";
  import Placeholder from "@tiptap/extension-placeholder";
  import { TextSelection } from "@tiptap/pm/state";
  import type { EditorView } from "@tiptap/pm/view";
  import { Marked, marked as sharedMarked } from "marked";
  import {
    PaperPagination,
    paperPageBreaks,
    setPaperPageBreaks,
    type PaperPageBreak,
  } from "./paper-pagination";
  import {
    planPaperPageBreaks,
    resolvePageBlockGeometry,
    type MeasuredPageBlock,
    type PageBreakOpportunity,
  } from "./paper-pagination-layout";
  import { ResearchMarkdownExtensions } from "./research-markdown";
  import { FocusSentence } from "./focus-sentence";
  import {
    GhostText,
    clearEditorGhostText,
    editorGhostText,
    setEditorGhostText,
  } from "./ghost-text";
  import {
    AiSelection,
    clearEditorAiSelection,
    setEditorAiSelection,
  } from "./ai-selection";
  import { HeadingInputGuard } from "./heading-input-guard";
  import { MarkdownHeading } from "./markdown-heading";
  import {
    documentPositionToMarkdownOffset,
    markdownOffsetToDocumentPosition,
  } from "./markdown-position-map";
  import { flashInsertedEditorInk, InkFeedback } from "./ink-feedback";
  import { ActiveWritingBlock } from "./active-writing-block";
  import {
    resolveCaretLineGeometry,
    type CaretLineGeometry,
    type RectLike,
    type WritingBlockKind,
  } from "./caret-line-geometry";
  import {
    writingActivity,
    writingInputFromBeforeInput,
    writingInputFromKeydown,
    type PendingWritingInput,
  } from "./writing-activity";
  import {
    approximatePrintingGraphemeAdvance,
    isPrintingKey,
    printCarrierReturnDuration,
    printingCursorMetrics,
    printingElementPoseForCode,
    representativePrintingGrapheme,
    resolvePaperMachineOrigin,
    resolvePrintCarrierOffset,
    resolvePrintingCellCenter,
    resolveScrollbarGutter,
    typewriterStrikeBottomClearance,
  } from "./typewriter-carriage";
  import {
    resolvePlatenScrollFrame,
    TYPEWRITER_PLATEN_DIAMETER,
    typewriterPlatenLinePitch,
    type PlatenDirection,
  } from "./typewriter-platen";
  import type {
    EditorApi,
    EditorChangeContext,
    EditorSelection,
    FocusMode,
    ScrollAnchor,
    WritingActivity,
    WritingExperience,
  } from "./types";

  export type PageFitMode = "page" | "width";

  interface Props {
    value: string;
    readOnly?: boolean;
    fallbackTitle?: string;
    documentPath?: string;
    fontFamily?: string;
    experience?: WritingExperience;
    fitMode?: PageFitMode;
    focusMode?: FocusMode;
    sessionWords?: number;
    sessionSentences?: number;
    sessionParagraphs?: number;
    sessionMarks?: Array<"sentence" | "paragraph">;
    resolveImage?: (relativePath: string) => Promise<string | null>;
    onready?: (api: EditorApi | null) => void;
    onchange?: (value: string, context: EditorChangeContext) => void;
    onselection?: (selection: EditorSelection) => void;
    onactivity?: (activity: WritingActivity) => void;
    onscrollanchor?: (anchor: ScrollAnchor) => void;
    onfocuschange?: (focused: boolean) => void;
  }

  let {
    value,
    readOnly = false,
    fallbackTitle = "제목 없는 원고",
    documentPath = "",
    fontFamily = "Pretendard",
    experience = "typewriter",
    fitMode = "width",
    focusMode = "off",
    sessionWords = 0,
    sessionSentences = 0,
    sessionParagraphs = 0,
    sessionMarks = [],
    resolveImage,
    onready,
    onchange,
    onselection,
    onactivity,
    onscrollanchor,
    onfocuschange,
  }: Props = $props();

  const MM_TO_PX = 96 / 25.4;
  const PAGE_WIDTH = 210 * MM_TO_PX;
  const PAGE_HEIGHT = 297 * MM_TO_PX;
  const PAGE_TOP = 22 * MM_TO_PX;
  const PAGE_BOTTOM = 18 * MM_TO_PX;
  const PAGE_BODY = (297 - 22 - 18) * MM_TO_PX;
  const PAGE_GAP = 28;
  const PAGE_EPSILON = 0.75;
  const TYPEBAR_STRIKE_MS = 210;
  const TYPEWRITER_IMPACT_RELEASE_MS = 115;
  const TYPEWRITER_CARRIER_STEP_MS = 35;
  const TYPEWRITER_BODY_FONT_SIZE = 10.75 * 96 / 72;
  const PRINTING_CONTEXT_LOOKBACK = 128;
  const graphemeSegmenter =
    typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter("ko", { granularity: "grapheme" })
      : null;
  const printingAdvanceCache = new Map<string, number>();
  let scroller: HTMLDivElement;
  let viewport: HTMLDivElement;
  let paperWindow: HTMLDivElement;
  let typewriterMachine = $state<HTMLDivElement>();
  let editorMount: HTMLDivElement;
  let measureHost: HTMLDivElement;
  let editor: TiptapEditor | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let mounted = false;
  let internalUpdate = false;
  let composing = false;
  let compositionBefore: string | null = null;
  let pendingInput: PendingWritingInput | null = null;
  let lastValue = "";
  let frontmatter = "";
  let layoutFrame: number | null = null;
  let layoutTimer: ReturnType<typeof setTimeout> | null = null;
  let scrollFrame: number | null = null;
  let programmaticScrollReleaseFrame: number | null = null;
  let platenIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let platenDetentTimer: ReturnType<typeof setTimeout> | null = null;
  let activeLineFrame: number | null = null;
  let printCarrierFrame: number | null = null;
  let pointerSelectionReleaseFrame: number | null = null;
  let workspaceFrame: number | null = null;
  let pageCount = $state(1);
  let viewedPageIndex = $state(0);
  let viewportWidth = $state(PAGE_WIDTH + 48);
  let viewportHeight = $state(PAGE_HEIGHT + 48);
  let continuousHeight = $state(PAGE_HEIGHT);
  let layoutBusy = $state(false);
  let activeFormatLabel = $state("");
  let caretLine = $state<CaretLineGeometry | null>(null);
  let caretAlignedToPrintingLine = $state(false);
  let printCarrierVisible = $state(false);
  let printCarrierOffset = $state(0);
  let paperMachineOrigin = $state(0);
  let typewriterScrollbarGutter = $state(0);
  let printCarrierReturning = $state(false);
  let printCarrierStepping = $state(false);
  let impactPrintPointLeft = $state<number | null>(null);
  let pointerSelectionActive = $state(false);
  let pointerSelectionPointerId: number | null = null;
  let printAdvancePending = false;
  let printingElementStriking = $state(false);
  let printingElementStrikeId = $state(0);
  let printingElementRotate = $state(0);
  let printingElementTilt = $state(0);
  let lineFeeding = $state(false);
  let platenRolling = $state(false);
  let platenDetenting = $state(false);
  let platenAngle = $state(0);
  let platenSurfaceOffset = $state(0);
  let platenDirection = $state<PlatenDirection>(0);
  let platenIntensity = $state(0);
  let platenDetentSequence = $state(0);
  let printCarrierReturnMs = $state(180);
  let marginWarning = $state(false);
  let literaryCompletion = $state<"sentence" | "paragraph" | null>(null);
  let nextPrintingElementStrikeId = 0;
  let lastPhysicalPrintingKeyAt = Number.NEGATIVE_INFINITY;
  let printingElementStrikeTimer: ReturnType<typeof setTimeout> | null = null;
  let printingElementImpactTimer: ReturnType<typeof setTimeout> | null = null;
  let printCarrierStepTimer: ReturnType<typeof setTimeout> | null = null;
  let returnTimer: ReturnType<typeof setTimeout> | null = null;
  let lineFeedFrame: number | null = null;
  let lineFeedTimer: ReturnType<typeof setTimeout> | null = null;
  let lineFeedTarget: number | null = null;
  let lineFeedPending = false;
  let programmaticScrollGuard = false;
  let programmaticScrollTarget: number | null = null;
  let literaryTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPrintCarrierLineTop: number | null = null;
  let lastPlatenScrollTop = 0;
  let lastPlatenScrollAt = 0;
  let lastFlowBlock: HTMLElement | null = null;
  let renderedExperience: WritingExperience | null = null;
  let workspaceTransitionTarget: WritingExperience | null = null;
  let layoutWaiters: Array<() => void> = [];
  let resolvedImageDocument = "";
  let imageDocumentInitialized = false;
  const imageSourceCache = new Map<string, Promise<string | null>>();
  const imageViews = new Set<{ refresh: () => void }>();
  const imageWork = new Set<Promise<unknown>>();

  let effectiveFitMode = $derived(
    experience === "literary" ? fitMode : "width",
  );
  let pageScale = $derived.by(() => {
    if (experience === "flow") return 1;
    const width = Math.max(
      1,
      viewportWidth - (effectiveFitMode === "page" ? 32 : 48),
    );
    const widthScale = width / PAGE_WIDTH;
    if (effectiveFitMode === "width") {
      return Math.max(0.35, Math.min(1.28, widthScale));
    }
    const heightScale = Math.max(1, viewportHeight - 32) / PAGE_HEIGHT;
    return Math.max(0.2, Math.min(1.08, widthScale, heightScale));
  });
  let pagePeriod = $derived(PAGE_HEIGHT + PAGE_GAP);
  let stackHeight = $derived(PAGE_HEIGHT * pageCount + PAGE_GAP * (pageCount - 1));
  let flowWidth = $derived(Math.max(280, Math.min(720, viewportWidth - 64)));
  let typewriterLineAperture = $derived(
    Math.max(
      22,
      Math.min(58, (caretLine?.height ?? 22) * pageScale + 8),
    ),
  );
  let typewriterCursorMetrics = $derived(
    printingCursorMetrics(
      caretLine?.fontSize ?? TYPEWRITER_BODY_FONT_SIZE,
      pageScale,
    ),
  );
  let typewriterStrikeBottom = $derived(
    typewriterStrikeBottomClearance(typewriterLineAperture),
  );
  let typewriterPlatenPitch = $derived(typewriterPlatenLinePitch(pageScale));
  let typewriterPaperTension = $derived(
    -platenDirection * platenIntensity * 1.4,
  );
  let typewriterTopRunway = $derived(
    Math.max(
      84,
      viewportHeight - typewriterStrikeBottom - PAGE_TOP * pageScale,
    ),
  );
  let typewriterBottomRunway = $derived(
    Math.max(
      150,
      typewriterStrikeBottom + PAGE_BOTTOM * pageScale + 16,
    ),
  );
  let flowTopRunway = $derived(Math.max(104, viewportHeight * 0.5 - 88));
  let flowBottomRunway = $derived(Math.max(176, viewportHeight * 0.5));
  let visibleHeight = $derived(
    experience === "flow"
      ? Math.max(viewportHeight, continuousHeight)
      : effectiveFitMode === "page"
        ? PAGE_HEIGHT
        : stackHeight,
  );
  let paperFontFallback = $derived(
    experience === "typewriter"
      ? 'Pretendard, system-ui, sans-serif'
      : experience === "flow"
        ? "Pretendard, sans-serif"
        : "MaruBuri, Pretendard, serif",
  );

  function splitFrontmatter(source: string): { prefix: string; body: string } {
    const block = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u.exec(source);
    if (!block) return { prefix: "", body: source };
    const end = block[0].length;
    return { prefix: source.slice(0, end), body: source.slice(end) };
  }

  function canonicalMarkdown(): string {
    if (!editor) return lastValue;
    const body = editor.getMarkdown();
    return `${frontmatter}${body}`;
  }

  function differsOnlyByTerminalBlankLines(left: string, right: string): boolean {
    return left.replace(/\n+$/u, "") === right.replace(/\n+$/u, "");
  }

  function serializedPrefix(position: number): string {
    if (!editor) return "";
    const safe = Math.max(0, Math.min(position, editor.state.doc.content.size));
    if (safe === 0) return "";
    try {
      const markdown = editor.markdown;
      if (!markdown) throw new Error("Markdown serializer is unavailable");
      const fragment = editor.state.doc.slice(0, safe).content.toJSON() as JSONContent[];
      return markdown.serialize({ type: "doc", content: fragment });
    } catch {
      return editor.state.doc.textBetween(0, safe, "\n", "\n");
    }
  }

  function documentToSourcePosition(position: number): number {
    if (!editor) return 0;
    return documentPositionToMarkdownOffset(position, {
      documentSize: editor.state.doc.content.size,
      frontmatterLength: frontmatter.length,
      serializedPrefixLength: (prefixPosition) =>
        serializedPrefix(prefixPosition).length,
    });
  }

  function sourceToDocumentPosition(offset: number): number {
    if (!editor) return 0;
    return markdownOffsetToDocumentPosition(offset, {
      documentSize: editor.state.doc.content.size,
      frontmatterLength: frontmatter.length,
      serializedPrefixLength: (prefixPosition) =>
        serializedPrefix(prefixPosition).length,
    });
  }

  function lineAt(source: string, offset: number): number {
    let line = 1;
    for (let index = 0; index < Math.min(offset, source.length); index += 1) {
      if (source.charCodeAt(index) === 10) line += 1;
    }
    return line;
  }

  function currentPage(): number {
    if (!editor) return 1;
    const position = editor.state.selection.head;
    const page =
      paperPageBreaks(editor.view).filter((pageBreak) => pageBreak.pos <= position)
        .length + 1;
    return Math.max(1, Math.min(pageCount, page));
  }

  function selectionInfo(): EditorSelection {
    const source = canonicalMarkdown();
    if (!editor) return { from: 0, to: 0, text: "", line: 1, page: 1 };
    const range = editor.state.selection;
    const from = documentToSourcePosition(range.from);
    const to = documentToSourcePosition(range.to);
    return {
      from,
      to,
      text: editor.state.doc.textBetween(range.from, range.to, "\n", "\n"),
      line: lineAt(source, from),
      page: currentPage(),
    };
  }

  function activeBlockElement(): HTMLElement | null {
    if (!editor) return null;
    const nativeAnchor = window.getSelection()?.anchorNode;
    const nativeElement =
      nativeAnchor instanceof Element ? nativeAnchor : nativeAnchor?.parentElement;
    const nativeBlock = nativeElement?.closest<HTMLElement>(
      "h1,h2,h3,h4,h5,h6,p,blockquote,li,pre,td,th",
    );
    if (nativeBlock && editor.view.dom.contains(nativeBlock)) return nativeBlock;
    const resolved = editor.state.selection.$from;
    for (let depth = resolved.depth; depth > 0; depth -= 1) {
      try {
        const node = editor.view.nodeDOM(resolved.before(depth));
        const element = node instanceof Element ? node : node?.parentElement;
        const block = element?.closest<HTMLElement>(
          "h1,h2,h3,h4,h5,h6,p,blockquote,li,pre,td,th",
        );
        if (block) return block;
      } catch {
        // Some inline positions do not expose a node boundary at this depth.
      }
    }
    const dom = editor.view.domAtPos(editor.state.selection.head).node;
    const element = dom instanceof Element ? dom : dom.parentElement;
    const direct = element?.closest<HTMLElement>(
      "h1,h2,h3,h4,h5,h6,p,blockquote,li,pre,td,th",
    );
    if (direct) return direct;
    const offset = editor.view.domAtPos(editor.state.selection.head).offset;
    const child = element?.childNodes[offset];
    return child instanceof HTMLElement
      ? child.closest<HTMLElement>("h1,h2,h3,h4,h5,h6,p,blockquote,li,pre,td,th")
      : null;
  }

  function updateActiveBlock(): HTMLElement | null {
    if (!editor) return null;
    const block = activeBlockElement();

    const parent = editor.state.selection.$from.parent;
    const headingLevel = parent.type.name === "heading" ? Number(parent.attrs.level) : 0;
    if (headingLevel) activeFormatLabel = `${headingLevel}단계 제목`;
    else if (editor.isActive("bold")) activeFormatLabel = "굵게";
    else if (editor.isActive("italic")) activeFormatLabel = "기울임";
    else if (editor.isActive("code")) activeFormatLabel = "코드";
    else if (editor.isActive("blockquote")) activeFormatLabel = "인용";
    else if (editor.isActive("bulletList")) activeFormatLabel = "글머리 목록";
    else if (editor.isActive("orderedList")) activeFormatLabel = "번호 목록";
    else activeFormatLabel = "";
    return block;
  }

  function writingBlockKind(block: HTMLElement | null): WritingBlockKind {
    if (!block) return "other";
    if (/^H[1-6]$/u.test(block.tagName)) return "heading";
    if (block.tagName === "LI") return "list-item";
    if (block.tagName === "BLOCKQUOTE") return "blockquote";
    if (block.tagName === "PRE") return "code";
    if (block.tagName === "TD" || block.tagName === "TH") return "table-cell";
    if (block.tagName === "P") return "paragraph";
    return "other";
  }

  function caretStyleElement(
    position: number,
    fallbackBlock: HTMLElement | null,
  ): HTMLElement | null {
    if (!editor) return fallbackBlock;
    let inlineElement: HTMLElement | null = null;
    try {
      const domPosition = editor.view.domAtPos(position);
      if (domPosition.node instanceof Text) {
        inlineElement = domPosition.node.parentElement;
      } else if (domPosition.node instanceof HTMLElement) {
        const adjacent =
          domPosition.node.childNodes[domPosition.offset] ??
          domPosition.node.childNodes[domPosition.offset - 1];
        inlineElement =
          adjacent instanceof HTMLElement
            ? adjacent
            : adjacent?.parentElement ?? domPosition.node;
      }
    } catch {
      inlineElement = null;
    }
    const candidate =
      inlineElement && editor.view.dom.contains(inlineElement)
        ? inlineElement
        : fallbackBlock;
    return candidate;
  }

  function caretFontSize(
    position: number,
    fallbackBlock: HTMLElement | null,
  ): number {
    const candidate = caretStyleElement(position, fallbackBlock);
    if (!candidate) return TYPEWRITER_BODY_FONT_SIZE;
    const measured = Number.parseFloat(getComputedStyle(candidate).fontSize);
    return Number.isFinite(measured) && measured > 0
      ? measured
      : TYPEWRITER_BODY_FONT_SIZE;
  }

  function graphemes(text: string): string[] {
    if (!text) return [];
    if (!graphemeSegmenter) return Array.from(text);
    return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
  }

  function firstGrapheme(text: string): string {
    return graphemes(text)[0] ?? "";
  }

  function lastGrapheme(text: string): string {
    return graphemes(text).at(-1) ?? "";
  }

  function modelTextRangeRect(from: number, to: number): DOMRect | null {
    if (!editor || from < 0 || to <= from || to > editor.state.doc.content.size) {
      return null;
    }
    try {
      const start = editor.view.domAtPos(from);
      const end = editor.view.domAtPos(to);
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      const rects = Array.from(range.getClientRects()).filter(
        (rect) => rect.width > 0 && rect.height > 0,
      );
      if (!rects.length) return null;
      const caret = editor.view.coordsAtPos(from);
      const caretCenter = (caret.top + caret.bottom) / 2;
      return rects.reduce((nearest, rect) => {
        const nearestDistance = Math.abs(
          (nearest.top + nearest.bottom) / 2 - caretCenter,
        );
        const distance = Math.abs((rect.top + rect.bottom) / 2 - caretCenter);
        return distance < nearestDistance ? rect : nearest;
      });
    } catch {
      return null;
    }
  }

  function printingAdvance(
    position: number,
    text: string,
  ): { advance: number; direction: "ltr" | "rtl" } {
    const candidate = caretStyleElement(position, activeBlockElement());
    const style = candidate ? getComputedStyle(candidate) : null;
    const sample = firstGrapheme(text) || "가";
    const fontSize = style
      ? Number.parseFloat(style.fontSize)
      : TYPEWRITER_BODY_FONT_SIZE;
    const safeFontSize =
      Number.isFinite(fontSize) && fontSize > 0
        ? fontSize
        : TYPEWRITER_BODY_FONT_SIZE;
    const direction = style?.direction === "rtl" ? "rtl" : "ltr";
    const cacheKey = [
      sample,
      style?.fontFamily ?? fontFamily,
      style?.fontSize ?? safeFontSize,
      style?.fontWeight ?? "400",
      style?.fontStyle ?? "normal",
      style?.letterSpacing ?? "normal",
      pageScale,
    ].join("|");
    const cached = printingAdvanceCache.get(cacheKey);
    if (cached !== undefined) return { advance: cached, direction };

    const measure = document.createElement("span");
    measure.textContent = sample;
    Object.assign(measure.style, {
      position: "fixed",
      visibility: "hidden",
      pointerEvents: "none",
      whiteSpace: "pre",
      fontFamily: style?.fontFamily ?? fontFamily,
      fontSize: style?.fontSize ?? `${safeFontSize}px`,
      fontWeight: style?.fontWeight ?? "400",
      fontStyle: style?.fontStyle ?? "normal",
      fontVariant: style?.fontVariant ?? "normal",
      fontStretch: style?.fontStretch ?? "normal",
      letterSpacing: style?.letterSpacing ?? "normal",
    });
    document.body.append(measure);
    const measuredWidth = measure.getBoundingClientRect().width;
    measure.remove();
    const parsedLetterSpacing = Number.parseFloat(style?.letterSpacing ?? "");
    const letterSpacing = Number.isFinite(parsedLetterSpacing)
      ? parsedLetterSpacing
      : 0;
    const estimatedWidth = Math.max(
      0.1,
      approximatePrintingGraphemeAdvance(sample, safeFontSize) + letterSpacing,
    );
    const advance =
      (Number.isFinite(measuredWidth) && measuredWidth > 0
        ? measuredWidth
        : estimatedWidth) * pageScale;
    printingAdvanceCache.set(cacheKey, advance);
    return { advance, direction };
  }

  function contextualPrintingSample(position: number): string {
    if (!editor) return "가";
    try {
      const resolved = editor.state.doc.resolve(position);
      const blockContext = resolved.parent.isTextblock
        ? resolved.parent.textBetween(0, resolved.parentOffset, "\n", "\n")
        : "";
      const blockSample = representativePrintingGrapheme(blockContext);
      if (blockSample) return blockSample;

      const contextStart = Math.max(0, position - PRINTING_CONTEXT_LOOKBACK);
      const documentContext = editor.state.doc.textBetween(
        contextStart,
        position,
        "\n",
        "\n",
      );
      return representativePrintingGrapheme(documentContext) ?? "가";
    } catch {
      return "가";
    }
  }

  function previousGraphemeRect(position: number): DOMRect | null {
    if (!editor) return null;
    const previous = editor.state.doc.resolve(position).nodeBefore;
    if (!previous?.isText || !previous.text) return null;
    const grapheme = lastGrapheme(previous.text);
    return grapheme
      ? modelTextRangeRect(position - grapheme.length, position)
      : null;
  }

  function sharesCaretLine(
    rect: DOMRect,
    caret: { top: number; bottom: number },
  ): boolean {
    const rectCenter = (rect.top + rect.bottom) / 2;
    const caretCenter = (caret.top + caret.bottom) / 2;
    const tolerance = Math.max(
      1,
      rect.bottom - rect.top,
      caret.bottom - caret.top,
    ) * 0.6;
    return Math.abs(rectCenter - caretCenter) <= tolerance;
  }

  // A trailing mechanical caret rests under the last entered glyph. At a
  // visual line start, the measured cell immediately before the caret stands
  // in for that glyph so the next character still appears to its right.
  function idlePrintPointLeft(position: number): number | null {
    if (!editor) return null;
    const caret = editor.view.coordsAtPos(position);
    const previous = previousGraphemeRect(position);
    const glyph =
      previous && sharesCaretLine(previous, caret) ? previous : null;
    const fallback = printingAdvance(
      position,
      contextualPrintingSample(position),
    );
    return resolvePrintingCellCenter({
      caretLeft: caret.left,
      glyphLeft: glyph?.left,
      glyphRight: glyph?.right,
      fallbackAdvance: fallback.advance,
      direction: fallback.direction,
      fallbackSide: "before",
    });
  }

  function anticipatedPrintPointLeft(
    position: number,
    text: string,
  ): number | null {
    if (!editor) return null;
    const grapheme = firstGrapheme(text);
    if (!grapheme) return idlePrintPointLeft(position);
    const caret = editor.view.coordsAtPos(position);
    const measured = printingAdvance(position, grapheme);
    return resolvePrintingCellCenter({
      caretLeft: caret.left,
      fallbackAdvance: measured.advance,
      direction: measured.direction,
    });
  }

  function insertedGraphemePrintPointLeft(insertedText: string): number | null {
    if (!editor) return null;
    const grapheme = lastGrapheme(insertedText);
    if (!grapheme) return null;
    const end = editor.state.selection.head;
    const rect = modelTextRangeRect(end - grapheme.length, end);
    if (!rect) return null;
    return (rect.left + rect.right) / 2;
  }

  function caretClientRects(position: number): RectLike[] {
    if (!editor) return [];
    const result: DOMRect[] = [];
    const addRange = (node: Text, from: number, to: number): void => {
      if (from < 0 || to <= from || to > node.length) return;
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      result.push(...Array.from(range.getClientRects()));
    };
    const collectTextEdge = (node: Node | undefined, fromEnd: boolean): void => {
      if (!node) return;
      let current = node;
      while (current.nodeType !== Node.TEXT_NODE && current.childNodes.length) {
        current = fromEnd
          ? current.childNodes[current.childNodes.length - 1]
          : current.childNodes[0];
      }
      if (!(current instanceof Text) || !current.length) return;
      addRange(current, fromEnd ? current.length - 1 : 0, fromEnd ? current.length : 1);
    };

    try {
      const domPosition = editor.view.domAtPos(position);
      if (domPosition.node instanceof Text) {
        addRange(
          domPosition.node,
          Math.max(0, domPosition.offset - 1),
          domPosition.offset,
        );
        addRange(domPosition.node, domPosition.offset, domPosition.offset + 1);
      } else {
        const children = domPosition.node.childNodes;
        collectTextEdge(children[domPosition.offset - 1], true);
        collectTextEdge(children[domPosition.offset], false);
      }
    } catch {
      return [];
    }
    return result;
  }

  function updateCaretLine(): void {
    if (
      !editor ||
      !editor.isFocused ||
      readOnly ||
      experience === "flow" ||
      !(editor.state.selection instanceof TextSelection) ||
      !editor.state.selection.empty
    ) {
      caretLine = null;
      return;
    }
    const stack = editorMount.closest<HTMLElement>(".paper-stack");
    if (!stack || pageScale <= 0) {
      caretLine = null;
      return;
    }
    try {
      const caret = editor.view.coordsAtPos(editor.state.selection.head);
      const stackRect = stack.getBoundingClientRect();
      const block = activeBlockElement();
      caretLine = resolveCaretLineGeometry({
        caret,
        lineRects: caretClientRects(editor.state.selection.head),
        stack: stackRect,
        scale: pageScale,
        pageWidth: PAGE_WIDTH,
        pageHeight: PAGE_HEIGHT,
        pageGap: PAGE_GAP,
        pageTopInset: PAGE_TOP,
        pageBottomInset: PAGE_BOTTOM,
        pageHorizontalInset: 20 * MM_TO_PX,
        fontSize: caretFontSize(editor.state.selection.head, block),
        blockKind: writingBlockKind(block),
      });
    } catch {
      caretLine = null;
    }
  }

  function scheduleCaretLine(): void {
    if (activeLineFrame !== null) cancelAnimationFrame(activeLineFrame);
    activeLineFrame = requestAnimationFrame(() => {
      activeLineFrame = null;
      updateCaretLine();
    });
  }

  function clearProgrammaticScrollMarker(): void {
    if (programmaticScrollReleaseFrame !== null) {
      cancelAnimationFrame(programmaticScrollReleaseFrame);
    }
    programmaticScrollReleaseFrame = null;
    programmaticScrollGuard = false;
    programmaticScrollTarget = null;
  }

  function markProgrammaticScroll(
    target: number | null = null,
  ): void {
    clearProgrammaticScrollMarker();
    programmaticScrollGuard = true;
    programmaticScrollTarget = target;
    programmaticScrollReleaseFrame = requestAnimationFrame(() => {
      programmaticScrollReleaseFrame = requestAnimationFrame(() => {
        programmaticScrollReleaseFrame = null;
        programmaticScrollGuard = false;
        programmaticScrollTarget = null;
      });
    });
  }

  function setProgrammaticScrollTop(target: number): void {
    if (!scroller) return;
    const normalized = Math.max(0, target);
    markProgrammaticScroll(normalized);
    scroller.scrollTop = normalized;
    programmaticScrollTarget = scroller.scrollTop;
  }

  function consumeProgrammaticScroll(): boolean {
    if (!scroller || !programmaticScrollGuard) return false;
    const matches =
      programmaticScrollTarget === null ||
      Math.abs(scroller.scrollTop - programmaticScrollTarget) <= 1;
    clearProgrammaticScrollMarker();
    return matches;
  }

  function resetPrintCarrier(): void {
    cancelLineFeed(false);
    clearProgrammaticScrollMarker();
    clearPrintingElementImpact();
    printCarrierOffset = 0;
    caretAlignedToPrintingLine = false;
    printCarrierVisible = false;
    marginWarning = false;
    lastPrintCarrierLineTop = null;
    printAdvancePending = false;
  }

  function triggerPrintCarrierReturn(feedLine = false): void {
    clearPrintingElementImpact();
    if (returnTimer) clearTimeout(returnTimer);
    printCarrierReturnMs = printCarrierReturnDuration(printCarrierOffset);
    printCarrierReturning = true;
    returnTimer = setTimeout(() => {
      printCarrierReturning = false;
      returnTimer = null;
    }, printCarrierReturnMs);
    if (!feedLine) return;
    lineFeedPending = true;
    lineFeeding = true;
    if (lineFeedTimer) clearTimeout(lineFeedTimer);
    lineFeedTimer = setTimeout(() => {
      lineFeedPending = false;
      lineFeeding = false;
      lineFeedTimer = null;
    }, 240);
  }

  function cancelPrintCarrierReturn(): void {
    if (returnTimer) clearTimeout(returnTimer);
    returnTimer = null;
    printCarrierReturning = false;
  }

  function stopPrintingElementStrike(): void {
    if (printingElementStrikeTimer) clearTimeout(printingElementStrikeTimer);
    printingElementStrikeTimer = null;
    printingElementStriking = false;
    clearPrintingElementImpact();
  }

  function cancelLineFeed(snapToTarget: boolean): void {
    if (lineFeedFrame !== null) cancelAnimationFrame(lineFeedFrame);
    lineFeedFrame = null;
    if (lineFeedTimer) clearTimeout(lineFeedTimer);
    lineFeedTimer = null;
    if (snapToTarget && scroller && lineFeedTarget !== null) {
      setProgrammaticScrollTop(lineFeedTarget);
    }
    lineFeedTarget = null;
    lineFeedPending = false;
    lineFeeding = false;
  }

  function startLineFeed(target: number): void {
    if (!scroller) return;
    cancelLineFeed(true);
    const start = scroller.scrollTop;
    const distance = target - start;
    lineFeedTarget = target;
    lineFeeding = true;
    const reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion || Math.abs(distance) <= 1) {
      setProgrammaticScrollTop(target);
      cancelLineFeed(false);
      return;
    }
    let startedAt: number | null = null;
    const animate = (time: number) => {
      if (!scroller || lineFeedTarget === null) return;
      startedAt ??= time;
      const progress = Math.min(1, (time - startedAt) / 160);
      const eased = 1 - Math.pow(1 - progress, 3);
      setProgrammaticScrollTop(start + distance * eased);
      if (progress < 1) {
        lineFeedFrame = requestAnimationFrame(animate);
        return;
      }
      setProgrammaticScrollTop(target);
      lineFeedFrame = null;
      lineFeedTarget = null;
      lineFeeding = false;
      if (lineFeedTimer) clearTimeout(lineFeedTimer);
      lineFeedTimer = null;
      scheduleCaretLine();
      schedulePrintCarrierPosition();
    };
    lineFeedFrame = requestAnimationFrame(animate);
    lineFeedTimer = setTimeout(() => {
      if (lineFeedFrame !== null) cancelAnimationFrame(lineFeedFrame);
      if (scroller && lineFeedTarget !== null) {
        setProgrammaticScrollTop(lineFeedTarget);
      }
      lineFeedFrame = null;
      lineFeedTarget = null;
      lineFeeding = false;
      lineFeedTimer = null;
      scheduleCaretLine();
      schedulePrintCarrierPosition();
    }, 220);
  }

  function reducedTypewriterMotion(): boolean {
    return (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    );
  }

  function settlePrintingElementPose(): void {
    printingElementRotate = 0;
    printingElementTilt = 0;
  }

  function clearPrintingElementImpact(): void {
    if (printingElementImpactTimer) clearTimeout(printingElementImpactTimer);
    printingElementImpactTimer = null;
    impactPrintPointLeft = null;
    settlePrintingElementPose();
  }

  function releasePrintingElementImpact(): void {
    printingElementImpactTimer = null;
    impactPrintPointLeft = null;
    settlePrintingElementPose();
    schedulePrintCarrierPosition();
  }

  function schedulePrintingElementImpactRelease(): void {
    if (printingElementImpactTimer) clearTimeout(printingElementImpactTimer);
    printingElementImpactTimer = setTimeout(
      releasePrintingElementImpact,
      reducedTypewriterMotion() ? 0 : TYPEWRITER_IMPACT_RELEASE_MS,
    );
  }

  function retargetPrintingElementImpact(text: string): void {
    if (
      !editor ||
      !(editor.state.selection instanceof TextSelection) ||
      !editor.state.selection.empty
    ) {
      return;
    }
    const point = anticipatedPrintPointLeft(editor.state.selection.head, text);
    if (point === null) return;
    impactPrintPointLeft = point;
    schedulePrintCarrierPosition();
  }

  function lockPrintingElementToInsertedText(text: string): void {
    const point = insertedGraphemePrintPointLeft(text);
    if (point === null) return;
    impactPrintPointLeft = point;
    if (!printingElementImpactTimer) schedulePrintingElementImpactRelease();
    schedulePrintCarrierPosition();
  }

  function triggerPrintingElementStrike(code = "", text = ""): void {
    if (experience !== "typewriter" || !mounted) {
      return;
    }
    if (printingElementStrikeTimer) clearTimeout(printingElementStrikeTimer);
    retargetPrintingElementImpact(text);
    schedulePrintingElementImpactRelease();
    printingElementStrikeId = ++nextPrintingElementStrikeId;
    const pose = printingElementPoseForCode(code, printingElementStrikeId);
    printingElementRotate = pose.rotate;
    printingElementTilt = pose.tilt;
    printingElementStriking = true;
    printingElementStrikeTimer = setTimeout(() => {
      printingElementStriking = false;
      printingElementStrikeTimer = null;
    }, reducedTypewriterMotion() ? 1 : TYPEBAR_STRIKE_MS);
  }

  function triggerPrintCarrierStep(): void {
    if (printCarrierStepTimer) clearTimeout(printCarrierStepTimer);
    printCarrierStepping = true;
    printCarrierStepTimer = setTimeout(() => {
      printCarrierStepping = false;
      printCarrierStepTimer = null;
    }, TYPEWRITER_CARRIER_STEP_MS + 5);
  }

  function triggerLiteraryCompletion(
    kind: "sentence" | "paragraph",
  ): void {
    if (literaryTimer) clearTimeout(literaryTimer);
    literaryCompletion = kind;
    literaryTimer = setTimeout(() => {
      literaryCompletion = null;
      literaryTimer = null;
    }, 650);
  }

  function alignTypewriterLine(): boolean {
    if (!editor || !scroller || lineFeedFrame !== null) return false;
    const coordinates = editor.view.coordsAtPos(editor.state.selection.head);
    const viewportRect = scroller.getBoundingClientRect();
    const caretCenter = (coordinates.top + coordinates.bottom) / 2;
    const delta = caretCenter - (viewportRect.bottom - typewriterStrikeBottom);
    if (Math.abs(delta) <= 1) {
      if (lineFeedPending) cancelLineFeed(false);
      return true;
    }
    const previousTop = scroller.scrollTop;
    const target = Math.max(0, scroller.scrollTop + delta);
    if (lineFeedPending) {
      startLineFeed(target);
      return false;
    }
    setProgrammaticScrollTop(target);
    return Math.abs(delta - (scroller.scrollTop - previousTop)) <= 1;
  }

  function caretMatchesTypewriterStrike(): boolean {
    if (
      !editor ||
      !editor.isFocused ||
      readOnly ||
      experience !== "typewriter" ||
      lineFeedFrame !== null ||
      !(editor.state.selection instanceof TextSelection) ||
      !editor.state.selection.empty ||
      !scroller
    ) {
      return false;
    }
    try {
      const caret = editor.view.coordsAtPos(editor.state.selection.head);
      const viewportRect = scroller.getBoundingClientRect();
      const caretCenter = (caret.top + caret.bottom) / 2;
      return (
        Math.abs(
          caretCenter - (viewportRect.bottom - typewriterStrikeBottom),
        ) <= 2
      );
    } catch {
      return false;
    }
  }

  function prepareTypewriterInput(): void {
    if (
      experience !== "typewriter" ||
      readOnly ||
      !editor ||
      !(editor.state.selection instanceof TextSelection) ||
      !editor.state.selection.empty ||
      caretAlignedToPrintingLine
    ) {
      return;
    }
    if (lineFeedFrame !== null) cancelLineFeed(true);
    updatePrintCarrierPosition();
  }

  function handleTypewriterTitleBoundaryKey(
    view: EditorView,
    event: KeyboardEvent,
  ): boolean {
    if (
      experience !== "typewriter" ||
      readOnly ||
      (event.key !== "Home" && event.key !== "End") ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.isComposing ||
      view.composing ||
      !(view.state.selection instanceof TextSelection)
    ) {
      return false;
    }
    const selection = view.state.selection;
    const head = selection.$head;
    if (
      head.parent.type.name !== "heading" ||
      Number(head.parent.attrs.level) !== 1
    ) {
      return false;
    }
    const target =
      event.key === "Home" ? head.start(head.depth) : head.end(head.depth);
    const nextSelection = event.shiftKey
      ? TextSelection.create(view.state.doc, selection.anchor, target)
      : TextSelection.create(view.state.doc, target);
    event.preventDefault();
    if (!nextSelection.eq(selection)) {
      view.dispatch(view.state.tr.setSelection(nextSelection));
    }
    scheduleCaretLine();
    schedulePrintCarrierPosition();
    return true;
  }

  function updatePrintCarrierPosition(): void {
    if (pointerSelectionActive) return;
    if (
      !editor ||
      !editor.isFocused ||
      readOnly ||
      experience !== "typewriter"
    ) {
      resetPrintCarrier();
      return;
    }
    if (
      !(editor.state.selection instanceof TextSelection) ||
      !editor.state.selection.empty
    ) {
      caretAlignedToPrintingLine = false;
      printCarrierVisible = false;
      marginWarning = false;
      lastPrintCarrierLineTop = null;
      printAdvancePending = false;
      return;
    }
    if (!scroller || !paperWindow) {
      caretAlignedToPrintingLine = false;
      printCarrierVisible = false;
      marginWarning = false;
      return;
    }

    const aligned = alignTypewriterLine();
    try {
      const caret = editor.view.coordsAtPos(editor.state.selection.head);
      const machineBounds = typewriterMachine?.getBoundingClientRect();
      const paperRect = paperWindow.getBoundingClientRect();
      const stack = editorMount.closest<HTMLElement>(".paper-stack");
      const stackRect = stack?.getBoundingClientRect();
      if (!stackRect || pageScale <= 0) return;
      if (machineBounds) {
        const nextOrigin = resolvePaperMachineOrigin({
          paperLeft: paperRect.left,
          paperWidth: paperRect.width,
          machineLeft: machineBounds.left,
          machineWidth: machineBounds.width,
        });
        if (nextOrigin !== null) paperMachineOrigin = nextOrigin;
      }
      const printPointLeft =
        impactPrintPointLeft ??
        idlePrintPointLeft(editor.state.selection.head) ??
        caret.left;
      const nextOffset = resolvePrintCarrierOffset({
        printPointLeft,
        paperLeft: paperRect.left,
        paperWidth: paperRect.width,
      });
      if (nextOffset === null) {
        printAdvancePending = false;
        return;
      }
      const lineTop = (caret.top - stackRect.top) / pageScale;
      const lineHeight = Math.max(1, (caret.bottom - caret.top) / pageScale);
      if (
        printAdvancePending &&
        lastPrintCarrierLineTop !== null &&
        !printCarrierReturning &&
        lineTop > lastPrintCarrierLineTop + lineHeight * 0.55
      ) {
        triggerPrintCarrierReturn(true);
      }
      lastPrintCarrierLineTop = lineTop;
      printCarrierOffset = nextOffset;
      caretAlignedToPrintingLine = aligned;
      printCarrierVisible = aligned || printCarrierReturning || lineFeeding;
      printAdvancePending = false;
      const caretOnPaper = (printPointLeft - paperRect.left) / pageScale;
      marginWarning = caretOnPaper >= PAGE_WIDTH - 28 * MM_TO_PX;
    } catch {
      caretAlignedToPrintingLine = false;
      printCarrierVisible = false;
      printAdvancePending = false;
    }
  }

  function schedulePrintCarrierPosition(): void {
    if (pointerSelectionActive) {
      if (printCarrierFrame !== null) cancelAnimationFrame(printCarrierFrame);
      printCarrierFrame = null;
      return;
    }
    if (printCarrierFrame !== null) cancelAnimationFrame(printCarrierFrame);
    printCarrierFrame = requestAnimationFrame(() => {
      printCarrierFrame = null;
      updatePrintCarrierPosition();
    });
  }

  function notifySelection(): void {
    if (experience === "typewriter" && !pointerSelectionActive) {
      markProgrammaticScroll();
    }
    const block = updateActiveBlock();
    scheduleCaretLine();
    schedulePrintCarrierPosition();
    const selected = selectionInfo();
    viewedPageIndex = Math.max(0, (selected.page ?? 1) - 1);
    onselection?.(selected);
    if (experience === "flow" && editor?.isFocused) centerFlowBlock(block);
    settleWorkspaceTransition(block);
  }

  function settleWorkspaceTransition(block: HTMLElement | null): void {
    if (workspaceTransitionTarget !== experience || !scroller) return;
    if (workspaceFrame !== null) cancelAnimationFrame(workspaceFrame);
    workspaceFrame = requestAnimationFrame(() => {
      workspaceFrame = null;
      if (workspaceTransitionTarget !== experience || !scroller) return;
      workspaceTransitionTarget = null;
      if (experience === "literary") {
        scroller.scrollTop = Math.max(0, (currentPage() - 1) * pagePeriod * pageScale);
      } else if (experience === "flow") {
        lastFlowBlock = null;
        centerFlowBlock(block);
      } else {
        schedulePrintCarrierPosition();
      }
    });
  }

  function centerFlowBlock(block = activeBlockElement()): void {
    if (!editor || !scroller || !block || experience !== "flow") return;
    const blockRect = block.getBoundingClientRect();
    const viewportRect = scroller.getBoundingClientRect();
    const center = (blockRect.top + blockRect.bottom) / 2;
    const lower = viewportRect.top + viewportRect.height * 0.42;
    const upper = viewportRect.top + viewportRect.height * 0.58;
    if (center < lower || center > upper || block !== lastFlowBlock) {
      scroller.scrollTop += center - (viewportRect.top + viewportRect.height * 0.5);
    }
    lastFlowBlock = block;
  }

  function handleWritingFeedback(activity: WritingActivity): void {
    if (activity.origin !== "keyboard") return;
    if (experience === "typewriter") {
      if (editor) {
        flashInsertedEditorInk(
          editor.view,
          activity.insertedText,
          "typewriter",
        );
      }
      printAdvancePending = true;
      if (activity.kind === "enter") {
        if (!printCarrierReturning) triggerPrintCarrierReturn(true);
      } else {
        cancelPrintCarrierReturn();
        cancelLineFeed(true);
        if (activity.kind === "character" && activity.insertedText) {
          lockPrintingElementToInsertedText(activity.insertedText);
        } else {
          clearPrintingElementImpact();
          triggerPrintCarrierStep();
        }
      }
      schedulePrintCarrierPosition();
      return;
    }
    if (experience === "literary" && editor) {
      flashInsertedEditorInk(editor.view, activity.insertedText, "literary");
      if (activity.paragraphDelta > 0) triggerLiteraryCompletion("paragraph");
      else if (activity.sentenceDelta > 0) triggerLiteraryCompletion("sentence");
    }
    if (experience === "flow") {
      centerFlowBlock();
    }
  }

  function updateContinuousHeight(): void {
    if (!editor || experience !== "flow") return;
    continuousHeight = Math.max(
      viewportHeight,
      editor.view.dom.scrollHeight,
      editorMount.scrollHeight,
    );
  }

  function trackImageWork<T>(work: Promise<T>): Promise<T> {
    let tracked: Promise<T>;
    tracked = work.finally(() => {
      imageWork.delete(tracked);
      resolveLayoutWaiters();
    });
    imageWork.add(tracked);
    return tracked;
  }

  function cachedImageSource(source: string): Promise<string | null> {
    if (!documentPath || !resolveImage) return Promise.resolve(null);
    const key = `${documentPath}\u0000${source}`;
    const cached = imageSourceCache.get(key);
    if (cached) return cached;
    const request = trackImageWork(
      Promise.resolve(resolveImage(source)).catch(() => null),
    );
    imageSourceCache.set(key, request);
    return request;
  }

  const RepositoryImage = Image.extend({
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement("figure");
        const image = document.createElement("img");
        const placeholder = document.createElement("span");
        let currentNode = node;
        let revision = 0;

        dom.className = "editorial-image";
        dom.contentEditable = "false";
        image.draggable = false;
        placeholder.className = "editorial-image-placeholder";
        dom.append(image, placeholder);

        const showPlaceholder = (
          state: "loading" | "missing" | "remote",
          message: string,
        ) => {
          dom.dataset.state = state;
          image.hidden = true;
          image.removeAttribute("src");
          placeholder.hidden = false;
          placeholder.textContent = message;
          scheduleLayout();
        };
        const showImage = (source: string) => {
          dom.dataset.state = "ready";
          placeholder.hidden = true;
          image.hidden = false;
          image.src = source;
          const settled = image.decode
            ? image.decode().catch(() => undefined)
            : Promise.resolve();
          void trackImageWork(
            settled.then(() => {
              scheduleLayout();
            }),
          );
        };
        const refresh = () => {
          const requestRevision = ++revision;
          const source = String(currentNode.attrs.src ?? "").trim();
          const alt = String(currentNode.attrs.alt ?? "").trim();
          const title = String(currentNode.attrs.title ?? "").trim();
          image.alt = alt;
          if (title) image.title = title;
          else image.removeAttribute("title");

          if (!source) {
            showPlaceholder("missing", alt || "그림 경로가 비어 있습니다.");
            return;
          }
          if (/^https?:\/\//i.test(source)) {
            showPlaceholder(
              "remote",
              alt || "원격 그림은 개인정보 보호를 위해 자동으로 불러오지 않습니다.",
            );
            return;
          }
          if (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(source)) {
            showImage(source);
            return;
          }

          showPlaceholder("loading", alt ? `${alt} · 불러오는 중…` : "그림을 불러오는 중…");
          void cachedImageSource(source).then((resolved) => {
            if (requestRevision !== revision) return;
            if (resolved) showImage(resolved);
            else showPlaceholder("missing", alt || `그림을 찾을 수 없습니다: ${source}`);
          });
        };
        const managed = { refresh };
        imageViews.add(managed);
        refresh();

        return {
          dom,
          update: (updatedNode) => {
            if (updatedNode.type !== currentNode.type) return false;
            currentNode = updatedNode;
            refresh();
            return true;
          },
          destroy: () => {
            revision += 1;
            imageViews.delete(managed);
          },
          ignoreMutation: () => true,
        };
      };
    },
  }).configure({ allowBase64: false, inline: false });

  function emitWritingActivity(
    before: string,
    after: string,
    input: PendingWritingInput | null,
  ): void {
    const activity = writingActivity(before, after, "paper", input);
    handleWritingFeedback(activity);
    onactivity?.(activity);
  }

  function emitChange(): void {
    if (!editor || internalUpdate) return;
    const before = lastValue;
    const next = canonicalMarkdown();
    if (next === lastValue || differsOnlyByTerminalBlankLines(next, lastValue)) {
      if (!editor.view.composing && !composing && pendingInput) {
        emitWritingActivity(before, next, pendingInput);
        pendingInput = null;
      }
      return;
    }
    lastValue = next;
    onchange?.(next, { composing: editor.view.composing || composing });
    if (!editor.view.composing && !composing && compositionBefore === null) {
      emitWritingActivity(before, next, pendingInput);
      pendingInput = null;
    }
  }

  interface MeasuredCharacter {
    node: Text;
    offset: number;
    modelPosition: number;
  }

  function measuredCharacters(
    block: HTMLElement,
    blockIndex: number,
  ): MeasuredCharacter[] {
    if (!editor) return [];
    const topLevelNode = editor.state.doc.child(blockIndex);
    const topLevelOffset = positionsForTopLevelNode(blockIndex);
    const modelPositions: number[] = [];
    topLevelNode.descendants((node, offset) => {
      if (!node.isText || !node.text) return;
      for (let index = 1; index <= node.text.length; index += 1) {
        modelPositions.push(topLevelOffset + 1 + offset + index);
      }
    });

    const domPositions: Array<{ node: Text; offset: number }> = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    while (textNode) {
      const text = textNode.textContent ?? "";
      const parent = textNode.parentElement;
      if (!parent?.closest(".inline-math, sup[data-footnote-reference]")) {
        for (let index = 0; index < text.length; index += 1) {
          domPositions.push({ node: textNode as Text, offset: index });
        }
      }
      textNode = walker.nextNode();
    }
    return domPositions
      .slice(0, modelPositions.length)
      .map((position, index) => ({
        ...position,
        modelPosition: modelPositions[index],
      }));
  }

  function positionsForTopLevelNode(index: number): number {
    if (!editor) return 0;
    let offset = 0;
    for (let current = 0; current < index; current += 1) {
      offset += editor.state.doc.child(current).nodeSize;
    }
    return offset;
  }

  function visualLineBreakResolver(
    block: HTMLElement,
    blockIndex: number,
  ): (
    segmentStart: number,
    available: number,
  ) => PageBreakOpportunity | undefined {
    const blockRect = block.getBoundingClientRect();
    let characters: MeasuredCharacter[] | null = null;
    const bottoms = new Map<number, number>();
    const characterBottom = (index: number): number => {
      const cached = bottoms.get(index);
      if (cached !== undefined) return cached;
      const character = characters?.[index];
      if (!character) return Number.NaN;
      const range = document.createRange();
      range.setStart(character.node, character.offset);
      range.setEnd(character.node, character.offset + 1);
      const bottom = range.getBoundingClientRect().bottom;
      bottoms.set(index, bottom);
      return bottom;
    };
    const lastCharacterAtOrBefore = (
      start: number,
      targetBottom: number,
    ): number => {
      if (!characters) return -1;
      let low = start;
      let high = characters.length - 1;
      let result = start - 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (characterBottom(middle) <= targetBottom + PAGE_EPSILON) {
          result = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      return result;
    };

    return (segmentStart, available) => {
      characters ??= measuredCharacters(block, blockIndex);
      if (
        characters.length < 2 ||
        !Number.isFinite(blockRect.top) ||
        available <= PAGE_EPSILON
      ) {
        return undefined;
      }
      const start = lastCharacterAtOrBefore(
        0,
        blockRect.top + segmentStart + PAGE_EPSILON,
      ) + 1;
      const boundary = lastCharacterAtOrBefore(
        start,
        blockRect.top + segmentStart + available,
      );
      if (boundary < start || boundary >= characters.length - 1) {
        return undefined;
      }
      const bottom = characterBottom(boundary);
      return {
        pos: characters[boundary].modelPosition,
        consumed: Math.max(0, bottom - blockRect.top),
      };
    };
  }

  function measuredVisualTextHeight(
    block: HTMLElement,
    blockTop: number,
  ): number | null {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let lastCharacter: { node: Text; offset: number } | null = null;
    let textNode = walker.nextNode();
    while (textNode) {
      const text = textNode.textContent ?? "";
      const parent = textNode.parentElement;
      if (
        text.length > 0 &&
        !parent?.closest(".inline-math, sup[data-footnote-reference]")
      ) {
        lastCharacter = { node: textNode as Text, offset: text.length - 1 };
      }
      textNode = walker.nextNode();
    }
    if (!lastCharacter) return null;
    const range = document.createRange();
    range.setStart(lastCharacter.node, lastCharacter.offset);
    range.setEnd(lastCharacter.node, lastCharacter.offset + 1);
    const height = range.getBoundingClientRect().bottom - blockTop;
    return Number.isFinite(height) && height > PAGE_EPSILON ? height : null;
  }

  function measuredBlockGeometry(
    block: HTMLElement,
    next: HTMLElement | undefined,
    useVisualTextBottom: boolean,
  ): { contentHeight: number; afterGap: number } {
    const rect = block.getBoundingClientRect();
    const nextRect = next?.getBoundingClientRect();
    const visualTextHeight = useVisualTextBottom
      ? measuredVisualTextHeight(block, rect.top)
      : null;
    return resolvePageBlockGeometry({
      boxHeight: rect.height,
      visualContentHeight: visualTextHeight,
      nextBlockOffset: nextRect ? nextRect.top - rect.top : null,
      marginBottom: Number.parseFloat(getComputedStyle(block).marginBottom),
    });
  }

  function isAtomicPageBlock(block: HTMLElement): boolean {
    return (
      block.matches(
        "table, figure, img, .tableWrapper, .editorial-image, .display-math",
      ) ||
      Boolean(
        block.querySelector(
          ":scope > table, :scope > figure, :scope > img, :scope > .editorial-image, :scope > .display-math",
        ),
      )
    );
  }

  function measuredPageBlocks(
    blocks: HTMLElement[],
    positions: number[],
  ): MeasuredPageBlock[] {
    return blocks.map((block, index) => {
      const atomic = isAtomicPageBlock(block);
      const hasBreakableText = !atomic && (block.textContent?.length ?? 0) > 1;
      const heading = /^H[1-6]$/u.test(block.tagName);
      const geometry = measuredBlockGeometry(
        block,
        blocks[index + 1],
        hasBreakableText && !heading,
      );
      const computedLineHeight = Number.parseFloat(
        getComputedStyle(block).lineHeight,
      );
      const fallbackLead = Number.isFinite(computedLineHeight)
        ? computedLineHeight * 2
        : 48;
      const leadHeight = Math.min(
        geometry.contentHeight,
        fallbackLead,
      );
      return {
        pos: positions[index] ?? 0,
        contentHeight: geometry.contentHeight,
        afterGap: geometry.afterGap,
        kind: heading
          ? "heading"
          : hasBreakableText
            ? "breakable"
            : "atomic",
        leadHeight,
        opportunities: [],
        breakAtOrBefore: hasBreakableText
          ? visualLineBreakResolver(block, index)
          : undefined,
      };
    });
  }

  function equalBreaks(left: PaperPageBreak[], right: PaperPageBreak[]): boolean {
    return (
      left.length === right.length &&
      left.every(
        (entry, index) =>
          entry.pos === right[index]?.pos &&
          Math.abs(entry.restPx - (right[index]?.restPx ?? 0)) < PAGE_EPSILON,
      )
    );
  }

  function resolveLayoutWaiters(): void {
    const waiters = layoutWaiters;
    layoutWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function failOpenPaperPagination(): void {
    if (editor && paperPageBreaks(editor.view).length > 0) {
      setPaperPageBreaks(editor.view, []);
    }
    pageCount = 1;
    viewedPageIndex = 0;
  }

  async function reflowPages(): Promise<void> {
    if (!editor || !mounted || !measureHost) return;
    layoutBusy = true;
    try {
      await document.fonts?.ready;
      await tick();
      if (!editor || !mounted) return;
      const proseMirror = editor.view.dom;
      const clone = proseMirror.cloneNode(true) as HTMLElement;
      clone.removeAttribute("contenteditable");
      clone
        .querySelectorAll(".paper-page-break, .editor-ghost-text")
        .forEach((node) => node.remove());
      clone.classList.add("paper-measure-document");
      clone.style.minHeight = "0";
      clone.style.height = "auto";
      measureHost.replaceChildren(clone);
      await Promise.all(
        Array.from(clone.querySelectorAll("img")).map((image) =>
          image.decode
            ? image.decode().catch(() => undefined)
            : Promise.resolve(),
        ),
      );

      const blocks = Array.from(clone.children).filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement &&
          !element.classList.contains("paper-page-break"),
      );
      const positions: number[] = [];
      editor.state.doc.forEach((_node, offset) => positions.push(offset));
      if (blocks.length !== positions.length) {
        throw new Error("Pagination measurement did not match the document.");
      }
      const breaks = planPaperPageBreaks(
        measuredPageBlocks(blocks, positions),
        {
          body: PAGE_BODY,
          top: PAGE_TOP,
          bottom: PAGE_BOTTOM,
          epsilon: PAGE_EPSILON,
        },
      );

      const current = paperPageBreaks(editor.view);
      if (!equalBreaks(current, breaks)) {
        setPaperPageBreaks(editor.view, breaks);
      }
      const appliedBreaks = paperPageBreaks(editor.view);
      pageCount = Math.max(1, appliedBreaks.length + 1);
      viewedPageIndex = Math.min(viewedPageIndex, pageCount - 1);
    } catch {
      failOpenPaperPagination();
    } finally {
      measureHost.replaceChildren();
      try {
        await tick();
        if (mounted) {
          updateCaretLine();
          updateContinuousHeight();
        }
      } finally {
        layoutBusy = false;
        resolveLayoutWaiters();
      }
    }
  }

  function scheduleLayout(): void {
    if (!mounted) return;
    layoutBusy = true;
    if (layoutTimer !== null) clearTimeout(layoutTimer);
    if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
    layoutTimer = setTimeout(() => {
      layoutTimer = null;
      layoutFrame = requestAnimationFrame(() => {
        layoutFrame = null;
        void reflowPages().catch(() => {
          failOpenPaperPagination();
          layoutBusy = false;
          resolveLayoutWaiters();
        });
      });
    }, 48);
  }

  async function awaitLayout(): Promise<void> {
    while (true) {
      if (imageWork.size > 0) {
        await Promise.allSettled(Array.from(imageWork));
      }
      if (
        imageWork.size === 0 &&
        !layoutBusy &&
        layoutFrame === null &&
        layoutTimer === null
      ) {
        return;
      }
      await new Promise<void>((resolve) => layoutWaiters.push(resolve));
    }
  }

  function replaceRange(from: number, to: number, text: string): void {
    if (!editor || readOnly) return;
    pendingInput = { kind: "other", origin: "programmatic" };
    const start = sourceToDocumentPosition(from);
    const end = sourceToDocumentPosition(to);
    const range = { from: Math.min(start, end), to: Math.max(start, end) };
    if (text === "") {
      editor.chain().focus().deleteRange(range).run();
      return;
    }
    if (/^\s+$/.test(text)) {
      const transaction = editor.state.tr
        .insertText(text, range.from, range.to)
        .scrollIntoView();
      editor.view.dispatch(transaction);
      editor.view.focus();
      return;
    }
    editor
      .chain()
      .focus()
      .insertContentAt(range, text, {
        contentType: "markdown",
        updateSelection: true,
      })
      .run();
  }

  function replaceRanges(
    edits: Array<{ from: number; to: number; text: string }>,
  ): void {
    if (!editor || readOnly || edits.length === 0) return;
    const source = canonicalMarkdown();
    const before = lastValue;
    const ordered = [...edits].sort((left, right) => right.from - left.from);
    let next = source;
    let previousFrom = source.length + 1;
    for (const edit of ordered) {
      const from = Math.max(0, Math.min(edit.from, source.length));
      const to = Math.max(from, Math.min(edit.to, source.length));
      if (to > previousFrom) return;
      next = `${next.slice(0, from)}${edit.text}${next.slice(to)}`;
      previousFrom = from;
    }
    pendingInput = { kind: "other", origin: "programmatic" };
    internalUpdate = true;
    const parsed = splitFrontmatter(next);
    frontmatter = parsed.prefix;
    try {
      editor.commands.setContent(parsed.body, {
        contentType: "markdown",
        emitUpdate: false,
      });
    } finally {
      internalUpdate = false;
    }
    const applied = canonicalMarkdown();
    lastValue = applied;
    if (applied !== before && !differsOnlyByTerminalBlankLines(applied, before)) {
      onchange?.(applied, { composing: false });
      emitWritingActivity(before, applied, pendingInput);
    }
    pendingInput = null;
    const last = ordered[ordered.length - 1];
    setSelection(last.from + last.text.length, last.from + last.text.length);
    scheduleLayout();
  }

  function setSelection(from: number, to: number): void {
    if (!editor) return;
    const anchor = sourceToDocumentPosition(from);
    const head = sourceToDocumentPosition(to);
    const document = editor.state.doc;
    const resolvedAnchor = document.resolve(anchor);
    const resolvedHead = document.resolve(head);
    const selection =
      anchor === head
        ? TextSelection.near(
            resolvedAnchor,
            anchor >= document.content.size ? -1 : 1,
          )
        : TextSelection.between(
            resolvedAnchor,
            resolvedHead,
            anchor <= head ? 1 : -1,
          );
    const transaction = editor.state.tr.setSelection(selection);
    editor.view.dispatch(transaction.scrollIntoView());
    editor.view.focus();
  }

  function currentAnchor(): ScrollAnchor {
    return { offset: selectionInfo().from, source: "paper" };
  }

  function scrollToAnchor(anchor: ScrollAnchor): void {
    setSelection(anchor.offset, anchor.offset);
  }

  function api(): EditorApi {
    return {
      focus: () => editor?.commands.focus(),
      getContent: canonicalMarkdown,
      getSelection: selectionInfo,
      replaceRange,
      replaceRanges,
      insertAtCursor: (text) => {
        const selected = selectionInfo();
        replaceRange(selected.from, selected.to, text);
      },
      setSelection,
      scrollToOffset: (offset) => setSelection(offset, offset),
      scrollToLine: (line) => {
        const source = canonicalMarkdown();
        let offset = 0;
        for (let current = 1; current < line; current += 1) {
          const next = source.indexOf("\n", offset);
          if (next < 0) break;
          offset = next + 1;
        }
        setSelection(offset, offset);
      },
      getScrollAnchor: currentAnchor,
      scrollToAnchor,
      setGhostText: (text) => {
        if (editor) setEditorGhostText(editor.view, text);
      },
      clearGhostText: () => {
        if (editor) clearEditorGhostText(editor.view);
      },
      setAiSelection: (from, to) => {
        if (!editor) return;
        setEditorAiSelection(
          editor.view,
          sourceToDocumentPosition(from),
          sourceToDocumentPosition(to),
        );
      },
      clearAiSelection: () => {
        if (editor) clearEditorAiSelection(editor.view);
      },
      getPageCount: () => pageCount,
      awaitLayout,
    };
  }

  function measureViewport(): void {
    if (!scroller) return;
    viewportWidth = scroller.clientWidth || PAGE_WIDTH + 48;
    viewportHeight = scroller.clientHeight || PAGE_HEIGHT + 48;
    typewriterScrollbarGutter = resolveScrollbarGutter(
      scroller.offsetWidth,
      scroller.clientWidth,
    );
    void tick().then(() => {
      scheduleCaretLine();
      schedulePrintCarrierPosition();
      updateContinuousHeight();
    });
  }

  function resetPlatenMotion(syncToPaper = true): void {
    if (platenIdleTimer) clearTimeout(platenIdleTimer);
    if (platenDetentTimer) clearTimeout(platenDetentTimer);
    platenIdleTimer = null;
    platenDetentTimer = null;
    platenRolling = false;
    platenDetenting = false;
    platenDirection = 0;
    platenIntensity = 0;
    const top = syncToPaper && scroller ? Math.max(0, scroller.scrollTop) : 0;
    const frame = resolvePlatenScrollFrame({
      previousTop: top,
      nextTop: top,
      linePitch: typewriterPlatenPitch,
      platenDiameter: TYPEWRITER_PLATEN_DIAMETER,
    });
    platenAngle = frame.angleDeg;
    platenSurfaceOffset = frame.surfaceOffsetPx;
    lastPlatenScrollTop = top;
    lastPlatenScrollAt = 0;
  }

  function updatePlatenFromScroll(): void {
    if (!scroller || experience !== "typewriter") return;
    const now = performance.now();
    const nextTop = Math.max(0, scroller.scrollTop);
    const frame = resolvePlatenScrollFrame({
      previousTop: lastPlatenScrollTop,
      nextTop,
      linePitch: typewriterPlatenPitch,
      platenDiameter: TYPEWRITER_PLATEN_DIAMETER,
      elapsedMs: lastPlatenScrollAt > 0 ? now - lastPlatenScrollAt : undefined,
    });
    lastPlatenScrollTop = nextTop;
    lastPlatenScrollAt = now;
    platenAngle = frame.angleDeg;
    platenSurfaceOffset = frame.surfaceOffsetPx;
    if (frame.direction === 0) return;

    platenRolling = true;
    platenDirection = frame.direction;
    platenIntensity = frame.intensity;
    if (platenIdleTimer) clearTimeout(platenIdleTimer);
    platenIdleTimer = setTimeout(() => {
      platenRolling = false;
      platenDirection = 0;
      platenIntensity = 0;
      platenIdleTimer = null;
    }, 96);

    if (frame.detentCrossings === 0) return;
    platenDetentSequence += frame.detentCrossings;
    platenDetenting = true;
    if (platenDetentTimer) clearTimeout(platenDetentTimer);
    platenDetentTimer = setTimeout(() => {
      platenDetenting = false;
      platenDetentTimer = null;
    }, 88);
  }

  function hidePrintCarrierForFreeScroll(): void {
    if (experience !== "typewriter") return;
    clearProgrammaticScrollMarker();
    if (lineFeedFrame !== null || lineFeedPending) cancelLineFeed(false);
    if (pointerSelectionActive) return;
    if (printCarrierFrame !== null) cancelAnimationFrame(printCarrierFrame);
    printCarrierFrame = null;
    cancelPrintCarrierReturn();
    if (printCarrierStepTimer) clearTimeout(printCarrierStepTimer);
    printCarrierStepTimer = null;
    printCarrierStepping = false;
    clearPrintingElementImpact();
    printAdvancePending = false;
    lastPrintCarrierLineTop = null;
    marginWarning = false;
    caretAlignedToPrintingLine = false;
    printCarrierVisible = false;
  }

  function handleFreeScrollIntent(): void {
    hidePrintCarrierForFreeScroll();
  }

  function cancelPointerSelectionRelease(): void {
    if (pointerSelectionReleaseFrame !== null) {
      cancelAnimationFrame(pointerSelectionReleaseFrame);
    }
    pointerSelectionReleaseFrame = null;
  }

  function cancelTypewriterPointerSelection(): void {
    cancelPointerSelectionRelease();
    pointerSelectionActive = false;
    pointerSelectionPointerId = null;
  }

  function beginTypewriterPointerSelection(event: PointerEvent): void {
    if (
      experience !== "typewriter" ||
      readOnly ||
      event.pointerType === "touch" ||
      (typeof event.button === "number" && event.button !== 0) ||
      event.isPrimary === false
    ) {
      return;
    }

    cancelPointerSelectionRelease();
    pointerSelectionPointerId = Number.isFinite(event.pointerId)
      ? event.pointerId
      : null;
    pointerSelectionActive = true;
    clearProgrammaticScrollMarker();
    if (lineFeedFrame !== null || lineFeedPending) cancelLineFeed(false);
    if (printCarrierFrame !== null) cancelAnimationFrame(printCarrierFrame);
    printCarrierFrame = null;
    cancelPrintCarrierReturn();
    if (printCarrierStepTimer) clearTimeout(printCarrierStepTimer);
    printCarrierStepTimer = null;
    printCarrierStepping = false;
    clearPrintingElementImpact();
    printAdvancePending = false;
    lastPrintCarrierLineTop = null;
    marginWarning = false;
    caretAlignedToPrintingLine = false;
    printCarrierVisible = false;
  }

  function finishTypewriterPointerSelection(event?: PointerEvent): void {
    if (!pointerSelectionActive) return;
    if (
      event &&
      pointerSelectionPointerId !== null &&
      Number.isFinite(event.pointerId) &&
      event.pointerId !== pointerSelectionPointerId
    ) {
      return;
    }
    pointerSelectionActive = false;
    pointerSelectionPointerId = null;
    cancelPointerSelectionRelease();
    pointerSelectionReleaseFrame = requestAnimationFrame(() => {
      pointerSelectionReleaseFrame = null;
      if (!mounted || pointerSelectionActive) return;
      scheduleCaretLine();
      schedulePrintCarrierPosition();
    });
  }

  function handlePointerSelectionEnd(event: PointerEvent): void {
    finishTypewriterPointerSelection(event);
  }

  function handlePointerSelectionBlur(): void {
    finishTypewriterPointerSelection();
  }

  function handleScrollPointerDown(event: PointerEvent): void {
    if (experience !== "typewriter" || !scroller) return;
    const bounds = scroller.getBoundingClientRect();
    const scrollbarHitWidth = Math.max(typewriterScrollbarGutter, 12);
    if (
      event.pointerType === "touch" ||
      (event.target === scroller &&
        event.clientX >= bounds.right - scrollbarHitWidth)
    ) {
      hidePrintCarrierForFreeScroll();
    }
  }

  function handleScroll(): void {
    const programmatic =
      experience === "typewriter" && consumeProgrammaticScroll();
    updatePlatenFromScroll();
    if (experience === "typewriter" && programmatic) {
      caretAlignedToPrintingLine = caretMatchesTypewriterStrike();
      printCarrierVisible =
        caretAlignedToPrintingLine || printCarrierReturning || lineFeeding;
    }
    if (effectiveFitMode === "page" || scrollFrame !== null) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      onscrollanchor?.(currentAnchor());
    });
  }

  function changePage(direction: -1 | 1): void {
    viewedPageIndex = Math.max(0, Math.min(pageCount - 1, viewedPageIndex + direction));
  }

  onMount(() => {
    mounted = true;
    const initial = splitFrontmatter(value);
    frontmatter = initial.prefix;
    lastValue = value;
    const isolatedMarkdown = new Marked() as unknown as typeof sharedMarked;
    editor = new TiptapEditor({
      element: editorMount,
      content: initial.body || "",
      contentType: "markdown",
      editable: !readOnly,
      extensions: [
        HeadingInputGuard,
        StarterKit.configure({
          heading: false,
          link: { openOnClick: false },
        }),
        MarkdownHeading,
        Markdown.configure({
          marked: isolatedMarkdown,
          markedOptions: { gfm: true, breaks: false },
        }),
        TableKit.configure({ table: { resizable: false } }),
        RepositoryImage,
        TaskList,
        TaskItem.configure({ nested: true }),
        Placeholder.configure({
          placeholder: ({ node }) =>
            node.type.name === "heading" ? "제목을 입력하세요" : "생각을 적어보세요…",
        }),
        ...ResearchMarkdownExtensions,
        FocusSentence,
        ActiveWritingBlock,
        GhostText,
        AiSelection,
        InkFeedback,
        PaperPagination,
      ],
      editorProps: {
        attributes: {
          class: "editorial-prose",
          spellcheck: "true",
          autocapitalize: "sentences",
          "aria-label": "에디토리얼 A4 편집기",
        },
        handleDOMEvents: {
          pointerdown: (_view, event) => {
            beginTypewriterPointerSelection(event as PointerEvent);
            return false;
          },
          compositionstart: () => {
            composing = true;
            compositionBefore = lastValue;
            return false;
          },
          compositionend: () => {
            composing = false;
            queueMicrotask(() => {
              if (!editor || compositionBefore === null) return;
              const before = compositionBefore;
              const next = canonicalMarkdown();
              compositionBefore = null;
              if (
                next !== lastValue &&
                !differsOnlyByTerminalBlankLines(next, lastValue)
              ) {
                lastValue = next;
                onchange?.(next, { composing: false });
              }
              emitWritingActivity(
                before,
                next,
                pendingInput ?? { kind: "character", origin: "keyboard" },
              );
              pendingInput = null;
            });
            return false;
          },
          beforeinput: (_view, event) => {
            const inputEvent = event as InputEvent;
            pendingInput = writingInputFromBeforeInput(inputEvent);
            if (
              pendingInput?.origin === "keyboard" &&
              (pendingInput.kind === "character" ||
                pendingInput.kind === "space" ||
                pendingInput.kind === "enter")
            ) {
              prepareTypewriterInput();
            }
            if (
              experience === "typewriter" &&
              pendingInput?.kind === "character"
            ) {
              const inputText = pendingInput.text ?? "";
              if (performance.now() - lastPhysicalPrintingKeyAt > 80) {
                triggerPrintingElementStrike("", inputText);
              } else if (inputText) {
                retargetPrintingElementImpact(inputText);
              }
            }
            if (pendingInput?.kind === "enter" && editor) {
              pendingInput.paragraphHadContent = Boolean(
                editor.state.selection.$from.parent.textContent.trim(),
              );
            }
            return false;
          },
          focus: () => {
            onfocuschange?.(true);
            return false;
          },
          blur: () => {
            queueMicrotask(() => {
              if (!mounted || editor?.isFocused) return;
              caretLine = null;
              resetPrintCarrier();
              lastFlowBlock = null;
              pendingInput = null;
              onfocuschange?.(false);
            });
            return false;
          },
        },
        handleKeyDown: (view, event) => {
          if (handleTypewriterTitleBoundaryKey(view, event)) return true;
          const keyboardInput = writingInputFromKeydown(event);
          if (keyboardInput) {
            pendingInput = keyboardInput;
            prepareTypewriterInput();
            if (keyboardInput.kind === "enter") {
              if (experience === "typewriter") triggerPrintCarrierReturn(true);
              pendingInput.paragraphHadContent = Boolean(
                view.state.selection.$from.parent.textContent.trim(),
              );
            }
          }
          if (
            experience === "typewriter" &&
            isPrintingKey(event)
          ) {
            lastPhysicalPrintingKeyAt = performance.now();
            triggerPrintingElementStrike(
              event.code,
              event.key === "Process" ? "" : event.key,
            );
          }
          const ghost = editorGhostText(view);
          if (event.key === "Escape" && ghost) {
            clearEditorGhostText(view);
            return true;
          }
          if (event.key !== "Tab" || !ghost) return false;
          pendingInput = { kind: "other", origin: "autocomplete" };
          const completion = ghost.text.replace(/\r?\n+/gu, " ");
          const end = ghost.pos + completion.length;
          const transaction = view.state.tr.insertText(completion, ghost.pos);
          transaction.setSelection(
            TextSelection.near(transaction.doc.resolve(end), -1),
          );
          transaction.scrollIntoView();
          view.dispatch(transaction);
          return true;
        },
      },
      onUpdate: ({ transaction }) => {
        if (!transaction.docChanged) return;
        if (experience === "typewriter" && !pointerSelectionActive) {
          markProgrammaticScroll();
        }
        emitChange();
        updateActiveBlock();
        scheduleLayout();
        scheduleCaretLine();
        schedulePrintCarrierPosition();
      },
      onSelectionUpdate: ({ transaction }) => {
        if (
          experience === "typewriter" &&
          !pointerSelectionActive &&
          !transaction.docChanged &&
          (lineFeedFrame !== null || lineFeedPending)
        ) {
          cancelLineFeed(true);
        }
        notifySelection();
      },
      onTransaction: ({ transaction }) => {
        if (transaction.docChanged) scheduleLayout();
      },
      onFocus: notifySelection,
    });
    resizeObserver = new ResizeObserver(measureViewport);
    resizeObserver.observe(scroller);
    scroller.addEventListener("pointerdown", handleScrollPointerDown);
    window.addEventListener("pointerup", handlePointerSelectionEnd);
    window.addEventListener("pointercancel", handlePointerSelectionEnd);
    window.addEventListener("blur", handlePointerSelectionBlur);
    measureViewport();
    resetPlatenMotion(experience === "typewriter");
    scheduleLayout();
    notifySelection();
    onready?.(api());
    void document.fonts?.ready.then(() => {
      if (!mounted) return;
      printingAdvanceCache.clear();
      schedulePrintCarrierPosition();
    });
  });

  $effect(() => {
    const external = value;
    if (!mounted || !editor || external === lastValue) return;
    const next = splitFrontmatter(external);
    const selected = selectionInfo();
    internalUpdate = true;
    frontmatter = next.prefix;
    lastValue = external;
    editor.commands.setContent(next.body, { contentType: "markdown", emitUpdate: false });
    internalUpdate = false;
    setSelection(
      Math.min(selected.from, external.length),
      Math.min(selected.to, external.length),
    );
    scheduleLayout();
  });

  $effect(() => {
    const editable = !readOnly;
    if (mounted && editor) {
      editor.setEditable(editable, false);
      if (readOnly) {
        cancelTypewriterPointerSelection();
        caretLine = null;
      } else {
        scheduleCaretLine();
      }
    }
  });

  $effect(() => {
    fontFamily;
    const nextExperience = experience;
    fitMode;
    focusMode;
    void tick().then(() => {
      const changed =
        renderedExperience !== null && nextExperience !== renderedExperience;
      renderedExperience = nextExperience;
      if (changed) {
        workspaceTransitionTarget = nextExperience;
      }
      const block = updateActiveBlock();
      if (nextExperience !== "typewriter") {
        cancelTypewriterPointerSelection();
        resetPrintCarrier();
        resetPlatenMotion(false);
      } else if (changed) {
        resetPlatenMotion(true);
      }
      if (nextExperience !== "flow") lastFlowBlock = null;
      scheduleLayout();
      scheduleCaretLine();
      schedulePrintCarrierPosition();
      updateContinuousHeight();
      if (changed && nextExperience === "literary" && scroller) {
        scroller.scrollTop = Math.max(0, (currentPage() - 1) * pagePeriod * pageScale);
      } else if (nextExperience === "flow") {
        centerFlowBlock(block);
      }
    });
  });

  $effect(() => {
    const nextDocument = documentPath;
    if (!imageDocumentInitialized) {
      imageDocumentInitialized = true;
      resolvedImageDocument = nextDocument;
      return;
    }
    if (nextDocument === resolvedImageDocument) return;
    resolvedImageDocument = nextDocument;
    imageSourceCache.clear();
    for (const imageView of imageViews) imageView.refresh();
  });

  onDestroy(() => {
    mounted = false;
    if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
    if (layoutTimer !== null) clearTimeout(layoutTimer);
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    clearProgrammaticScrollMarker();
    if (platenIdleTimer) clearTimeout(platenIdleTimer);
    if (platenDetentTimer) clearTimeout(platenDetentTimer);
    if (activeLineFrame !== null) cancelAnimationFrame(activeLineFrame);
    if (printCarrierFrame !== null) cancelAnimationFrame(printCarrierFrame);
    cancelTypewriterPointerSelection();
    if (workspaceFrame !== null) cancelAnimationFrame(workspaceFrame);
    stopPrintingElementStrike();
    cancelLineFeed(false);
    if (printCarrierStepTimer) clearTimeout(printCarrierStepTimer);
    if (returnTimer) clearTimeout(returnTimer);
    if (literaryTimer) clearTimeout(literaryTimer);
    scroller?.removeEventListener("pointerdown", handleScrollPointerDown);
    window.removeEventListener("pointerup", handlePointerSelectionEnd);
    window.removeEventListener("pointercancel", handlePointerSelectionEnd);
    window.removeEventListener("blur", handlePointerSelectionBlur);
    resizeObserver?.disconnect();
    resizeObserver = null;
    editor?.destroy();
    editor = null;
    imageViews.clear();
    imageSourceCache.clear();
    imageWork.clear();
    resolveLayoutWaiters();
    onready?.(null);
  });
</script>

<div
  class:fit-page={effectiveFitMode === "page"}
  class:focus-paragraph={focusMode === "paragraph" && experience !== "flow"}
  class:focus-sentence={focusMode === "sentence" && experience !== "flow"}
  class:writing-literary={experience === "literary"}
  class:writing-typewriter={experience === "typewriter"}
  class:writing-flow={experience === "flow"}
  class:print-carrier-visible={experience === "typewriter" && printCarrierVisible && Boolean(caretLine)}
  class:print-carrier-returning={printCarrierReturning}
  class:print-carrier-stepping={printCarrierStepping}
  class:pointer-selecting={pointerSelectionActive}
  class:printing-element-striking={printingElementStriking}
  class:line-feeding={lineFeeding}
  class:platen-rolling={platenRolling}
  class:platen-detenting={platenDetenting}
  class:margin-warning={marginWarning}
  class="paper-editor-shell"
  style={`--paper-font:"${fontFamily.replaceAll('"', '\\"')}", ${paperFontFallback};--paper-scale:${pageScale};--paper-gap:${PAGE_GAP}px;--paper-machine-origin:${paperMachineOrigin}px;--print-carrier-offset:${printCarrierOffset}px;--print-carrier-track-duration:90ms;--print-carrier-step-duration:${TYPEWRITER_CARRIER_STEP_MS}ms;--print-carrier-return-duration:${printCarrierReturnMs}ms;--printing-element-rotate:${printingElementRotate}deg;--printing-element-tilt:${printingElementTilt}deg;--type-strike-width:${typewriterCursorMetrics.strikeWidth}px;--type-strike-height:${typewriterCursorMetrics.strikeHeight}px;--type-strike-top-offset:${typewriterCursorMetrics.strikeTopOffset}px;--type-element-width:${typewriterCursorMetrics.elementWidth}px;--type-element-height:${typewriterCursorMetrics.elementHeight}px;--typewriter-strike-duration:${TYPEBAR_STRIKE_MS}ms;--typewriter-scrollbar-gutter:${typewriterScrollbarGutter}px;--typewriter-paper-width:${PAGE_WIDTH * pageScale}px;--typewriter-strike-bottom:${typewriterStrikeBottom}px;--typewriter-strike-y:calc(100% - var(--typewriter-strike-bottom));--typewriter-line-aperture:${typewriterLineAperture}px;--typewriter-platen-angle:${platenAngle}deg;--typewriter-platen-surface:${platenSurfaceOffset}px;--typewriter-platen-intensity:${platenIntensity};--typewriter-paper-tension:${typewriterPaperTension}px;--typewriter-platen-pitch:${typewriterPlatenPitch}px;--flow-width:${flowWidth}px;--typewriter-top-runway:${typewriterTopRunway}px;--typewriter-bottom-runway:${typewriterBottomRunway}px;--flow-top-runway:${flowTopRunway}px;--flow-bottom-runway:${flowBottomRunway}px`}
>
  <div class="paper-toolbar-note" aria-live="polite">
    <span>
      {experience === "typewriter"
          ? "타자기"
        : experience === "literary"
          ? "문학 서재"
          : "몰입 캔버스"}
      · {experience === "flow" ? "연속" : "A4"}
    </span>
    {#if activeFormatLabel}<small>{activeFormatLabel}</small>{/if}
    {#if layoutBusy}<small>조판 중…</small>{/if}
  </div>

  {#if experience === "typewriter"}
    <div
      class:active={printCarrierVisible && Boolean(caretLine)}
      class="typewriter-machine"
      bind:this={typewriterMachine}
      style="--line-aperture:var(--typewriter-line-aperture)"
      data-platen-detent={platenDetentSequence}
      aria-hidden="true"
    >
      <div class="typewriter-frame-rear">
        <span class="typewriter-rail-recess"></span>
        <span class="typewriter-fixed-guide-rail"></span>
      </div>
      <div class="typewriter-frame-front">
        <span class="typewriter-front-bevel"></span>
        <span class="typewriter-typing-well"></span>
      </div>
      <div class="typewriter-platen-assembly">
        <span class="typewriter-platen-endcap is-left">
          <i class="typewriter-platen-bearing"></i>
          <i class="typewriter-bail-pivot"></i>
        </span>
        <span class="typewriter-platen-endcap is-right">
          <i class="typewriter-platen-bearing"></i>
          <i class="typewriter-bail-pivot"></i>
        </span>
        <span class="typewriter-paper-wrap"></span>
        <span class="typewriter-platen"></span>
        <span class="typewriter-paper-scale"></span>
        <span class="typewriter-bail-arm is-left"><i></i></span>
        <span class="typewriter-bail-arm is-right"><i></i></span>
        <span class="typewriter-paper-bail">
          <i class="typewriter-bail-roller is-first"></i>
          <i class="typewriter-bail-roller is-second"></i>
          <i class="typewriter-bail-roller is-third"></i>
          <i class="typewriter-bail-roller is-fourth"></i>
        </span>
        <span class="typewriter-platen-knob is-left"><i></i></span>
        <span class="typewriter-platen-knob is-right"><i></i></span>
        <span class="typewriter-index-wheel"></span>
        {#if platenDetenting}
          {#key platenDetentSequence}
            <span class="typewriter-detent-pawl"></span>
          {/key}
        {/if}
      </div>
      <span class="typewriter-carrier-track"></span>
      {#if printCarrierVisible && caretLine}
        <div class="typewriter-print-carrier">
          <span class="typewriter-carrier-bearing"></span>
          <span class="typewriter-carrier-body"></span>
          {#if printingElementStriking}
            {#key printingElementStrikeId}
              <span class="typewriter-ribbon-gate is-striking"></span>
              <span class="typewriter-element-yoke is-striking">
                <i class="typewriter-print-element">
                  <span class="typewriter-element-shell"></span>
                  <em class="typewriter-strike-face"></em>
                </i>
              </span>
            {/key}
          {:else}
            <span class="typewriter-ribbon-gate"></span>
            <span class="typewriter-element-yoke">
              <i class="typewriter-print-element">
                <span class="typewriter-element-shell"></span>
                <em class="typewriter-strike-face"></em>
              </i>
            </span>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <div
    class:fit-page={effectiveFitMode === "page"}
    class="paper-scroller"
    bind:this={scroller}
    onwheel={handleFreeScrollIntent}
    onscroll={handleScroll}
  >
    <div class="paper-viewport" bind:this={viewport}>
      <div
        class:fit-page={effectiveFitMode === "page"}
        class="paper-window"
        bind:this={paperWindow}
        style={`width:${experience === "flow" ? flowWidth : PAGE_WIDTH * pageScale}px;height:${experience === "flow" ? visibleHeight : visibleHeight * pageScale}px`}
      >
        <div
          class="paper-stack"
          style={experience === "flow"
            ? `width:${flowWidth}px;min-height:${visibleHeight}px`
            : `width:${PAGE_WIDTH}px;min-height:${stackHeight}px;transform:translateY(-${effectiveFitMode === "page" ? viewedPageIndex * pagePeriod * pageScale : 0}px) scale(${pageScale})`}
        >
          <div class="paper-sheet-layer" aria-hidden="true">
            {#each Array(pageCount) as _, index}
              <div class="paper-sheet"><span>{index + 1}</span></div>
            {/each}
          </div>
          {#if experience === "literary" && caretLine}
            <div
              class="literary-caret-mark"
              style={`top:${caretLine.top}px;height:${caretLine.height}px;left:${caretLine.bodyLeft - 20}px`}
              aria-hidden="true"
            ></div>
            {#if literaryCompletion}
              <div
                class:paragraph={literaryCompletion === "paragraph"}
                class="literary-completion-mark"
                style={`top:${caretLine.top + caretLine.height / 2}px;left:${caretLine.bodyLeft - 34}px`}
                aria-hidden="true"
              ></div>
            {/if}
            <div
              class="literary-folio-trail"
              style={`top:${caretLine.pageIndex * pagePeriod + PAGE_HEIGHT - 106}px`}
              aria-hidden="true"
            >
              {#each Array(Math.min(9, sessionParagraphs)) as _, index (`folio-${index}`)}
                <span></span>
              {/each}
            </div>
          {/if}
          <div class="paper-editor-mount" bind:this={editorMount}></div>
        </div>
      </div>
    </div>
  </div>

  {#if experience === "literary" && effectiveFitMode === "page" && pageCount > 1}
    <nav class="paper-page-navigator" aria-label="쪽 이동">
      <button aria-label="이전 쪽" disabled={viewedPageIndex === 0} onclick={() => changePage(-1)}>‹</button>
      <span>{viewedPageIndex + 1} / {pageCount}</span>
      <button aria-label="다음 쪽" disabled={viewedPageIndex >= pageCount - 1} onclick={() => changePage(1)}>›</button>
    </nav>
  {/if}

  {#if experience === "flow"}
    <div class="flow-session-dock" aria-live="polite">
      <div class="flow-session-copy">
        <small>이번 세션</small>
        <strong>{sessionWords}<span>단어</span></strong>
        <strong>{sessionSentences}<span>문장</span></strong>
        <strong>{sessionParagraphs}<span>문단</span></strong>
      </div>
      <div class="flow-session-trace" aria-hidden="true">
        {#each sessionMarks as mark, index (`${index}-${mark}`)}
          <span class:paragraph={mark === "paragraph"}></span>
        {/each}
      </div>
    </div>
  {/if}

  <div class="paper-measure-host paper-editor-mount" bind:this={measureHost} aria-hidden="true"></div>
</div>

<style>
  .paper-editor-shell {
    --writing-caret: #8d493e;
    --writing-graphite: #3b3530;
    --writing-margin: #9a7868;
    position: relative;
    height: 100%;
    min-width: 0;
    overflow: hidden;
    background:
      radial-gradient(circle at 20% 0%, color-mix(in srgb, var(--sheet) 20%, transparent), transparent 38%),
      var(--desk);
  }

  .paper-editor-shell.writing-typewriter {
    background: var(--typewriter-desk-surface);
    box-shadow:
      inset 0 1px var(--typewriter-desk-inset-top),
      inset 0 -40px 96px var(--typewriter-desk-inset-bottom);
  }

  .paper-editor-shell.writing-literary {
    background:
      radial-gradient(ellipse at 50% -4%, rgba(255, 243, 215, 0.34), transparent 54%),
      linear-gradient(120deg, rgba(117, 74, 43, 0.1), transparent 34%),
      color-mix(in srgb, var(--desk) 85%, #9b7655);
  }

  .paper-editor-shell.writing-flow {
    background:
      radial-gradient(ellipse at 50% 0%, color-mix(in srgb, var(--surface-raised) 38%, transparent), transparent 62%),
      color-mix(in srgb, var(--desk) 92%, #aab1ad);
  }

  .paper-scroller,
  .paper-viewport {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
  }

  .paper-scroller {
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }

  .writing-typewriter .paper-scroller {
    --typewriter-paper-mask-start: calc(
      var(--typewriter-strike-y) + var(--typewriter-line-aperture) / 2
    );
    --typewriter-paper-mask-end: calc(
      var(--typewriter-paper-mask-start) + 14px
    );
    overflow-x: hidden;
    -webkit-mask-image: linear-gradient(
      180deg,
      #000 0,
      #000 var(--typewriter-paper-mask-start),
      transparent var(--typewriter-paper-mask-end)
    );
    mask-image: linear-gradient(
      180deg,
      #000 0,
      #000 var(--typewriter-paper-mask-start),
      transparent var(--typewriter-paper-mask-end)
    );
    -webkit-mask-repeat: no-repeat;
    mask-repeat: no-repeat;
    -webkit-mask-size: 100% 100%;
    mask-size: 100% 100%;
  }

  .paper-scroller.fit-page {
    overflow: hidden;
    scrollbar-gutter: auto;
  }

  .paper-viewport {
    display: flex;
    justify-content: center;
    box-sizing: border-box;
    padding: 48px 24px 100px;
  }

  .writing-typewriter .paper-viewport {
    padding-top: var(--typewriter-top-runway);
    padding-bottom: var(--typewriter-bottom-runway);
  }

  .writing-flow .paper-viewport {
    align-items: flex-start;
    padding: var(--flow-top-runway) 32px var(--flow-bottom-runway);
  }

  .paper-viewport:has(.paper-window.fit-page) {
    align-items: center;
    padding: 16px;
  }

  .paper-window {
    position: relative;
    flex: 0 0 auto;
  }

  .paper-window.fit-page { overflow: hidden; }

  .paper-stack {
    position: relative;
    transform-origin: top left;
  }

  .paper-sheet-layer {
    position: absolute;
    z-index: 0;
    inset: 0 auto auto 0;
    display: flex;
    width: 210mm;
    flex-direction: column;
    gap: var(--paper-gap);
    pointer-events: none;
  }

  .paper-sheet {
    position: relative;
    box-sizing: border-box;
    width: 210mm;
    height: 297mm;
    flex: 0 0 auto;
    border: 1px solid color-mix(in srgb, var(--sheet-edge) 68%, transparent);
    background-color: var(--sheet);
    background-image: var(--hanji-texture);
    background-size: 320px 320px;
    box-shadow: var(--shadow-paper);
  }

  .writing-typewriter .paper-sheet {
    border-color: color-mix(in srgb, var(--typewriter-sheet-edge) 76%, transparent);
    background-color: var(--typewriter-sheet);
    background-image:
      linear-gradient(180deg, rgba(255, 255, 255, 0.2), rgba(55, 62, 58, 0.018)),
      var(--typewriter-paper-texture);
    background-repeat: no-repeat, repeat;
    background-size: 100% 100%, 320px 320px;
    box-shadow:
      0 1px 1px rgba(0, 0, 0, 0.24),
      0 20px 58px rgba(0, 0, 0, 0.38);
  }

  .writing-literary .paper-sheet {
    border-color: rgba(119, 84, 53, 0.16);
    background-color: color-mix(in srgb, var(--sheet) 94%, #fff5dc);
    background-image:
      linear-gradient(90deg, rgba(139, 99, 62, 0.018), transparent 18%, transparent 82%, rgba(139, 99, 62, 0.018)),
      var(--hanji-texture);
    box-shadow:
      0 1px 2px rgba(77, 54, 37, 0.12),
      0 28px 72px rgba(77, 54, 37, 0.22);
  }

  .writing-flow .paper-sheet-layer { display: none; }

  .paper-sheet span {
    position: absolute;
    right: 0;
    bottom: 7mm;
    left: 0;
    color: color-mix(in srgb, var(--ink-faint) 82%, transparent);
    font: 8pt/1 var(--ui-font);
    text-align: center;
  }

  .paper-editor-mount {
    position: relative;
    z-index: 2;
    width: 210mm;
    min-height: 297mm;
  }

  .writing-typewriter .paper-stack > .paper-editor-mount {
    z-index: 7;
  }

  .writing-flow .paper-editor-mount {
    width: 100%;
    min-height: 100%;
  }

  /*
   * IBM Selectric-inspired stationary paper path. The platen and A4 sheet stay
   * horizontally fixed while a compact single-element carrier follows the
   * native editor caret on a powered rail.
   */
  .typewriter-machine {
    --typewriter-rubber: #080a0b;
    --typewriter-metal: #d8d8d3;
    --typewriter-metal-deep: #808583;
    --typewriter-warning: #c79a54;
    --typewriter-frame-width: min(940px, calc(100% - 18px));
    --typewriter-platen-width: calc(var(--typewriter-paper-width) + 104px);
    --typewriter-frame-top: calc(
      var(--typewriter-strike-y) + var(--line-aperture) / 2 + 13px
    );
    position: absolute;
    z-index: 6;
    inset: 0 var(--typewriter-scrollbar-gutter) 0 0;
    overflow: hidden;
    isolation: isolate;
    pointer-events: none;
  }

  .typewriter-frame-rear,
  .typewriter-frame-front {
    position: absolute;
    left: 50%;
    width: var(--typewriter-frame-width);
    transform: translateX(-50%);
  }

  .typewriter-frame-rear {
    z-index: 2;
    top: var(--typewriter-frame-top);
    height: 18px;
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--typewriter-body-deep) 78%, #000) 0 24%,
      var(--typewriter-chassis-surface) 25% 100%
    );
    box-shadow:
      inset 0 1px var(--typewriter-body-inset-highlight),
      inset 0 -5px 7px -5px var(--typewriter-body-inset-shadow);
    filter: drop-shadow(0 -2px 5px var(--typewriter-body-cast-shadow));
  }

  .typewriter-rail-recess {
    position: absolute;
    z-index: 2;
    top: 0;
    right: 3.2%;
    left: 3.2%;
    height: 12px;
    clip-path: polygon(0.5% 0, 99.5% 0, 100% 72%, 99.2% 100%, 0.8% 100%, 0 72%);
    background: linear-gradient(
      180deg,
      rgba(0, 0, 0, 0.78),
      color-mix(in srgb, var(--typewriter-body-deep) 84%, #000) 64%,
      rgba(255, 255, 255, 0.035)
    );
    box-shadow:
      inset 0 4px 6px rgba(0, 0, 0, 0.72),
      0 1px var(--typewriter-body-inset-highlight);
  }

  .typewriter-fixed-guide-rail {
    position: absolute;
    z-index: 3;
    top: 3px;
    right: 4.6%;
    left: 4.6%;
    height: 6px;
    border-radius: 2px;
    background: var(--typewriter-race-surface);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.36),
      inset 0 -2px 2px rgba(0, 0, 0, 0.8),
      0 3px 5px rgba(0, 0, 0, 0.54);
  }

  .typewriter-frame-front {
    z-index: 4;
    top: calc(var(--typewriter-frame-top) + 11px);
    height: 7px;
    clip-path: polygon(0.8% 0, 99.2% 0, 100% 100%, 0 100%);
    background:
      var(--typewriter-chassis-front-overlay),
      var(--typewriter-chassis-surface);
    box-shadow:
      inset 0 2px 3px -2px var(--typewriter-body-inset-highlight),
      inset 0 -4px 5px -3px var(--typewriter-body-inset-shadow);
  }

  .typewriter-front-bevel {
    position: absolute;
    top: 0;
    right: 1.5%;
    left: 1.5%;
    height: 2px;
    background: var(--typewriter-chassis-deck-overlay);
    box-shadow:
      inset 0 1px var(--typewriter-body-inset-highlight),
      inset 0 -2px 3px var(--typewriter-depth-edge);
  }

  .typewriter-typing-well {
    position: absolute;
    z-index: 2;
    top: -8px;
    left: 50%;
    width: clamp(116px, 17vw, 154px);
    height: 12px;
    transform: translateX(-50%);
    clip-path: polygon(8% 0, 92% 0, 100% 100%, 0 100%);
    background: linear-gradient(180deg, #050708, #171b1b 62%, #080a0b);
    box-shadow:
      inset 0 5px 8px rgba(0, 0, 0, 0.84),
      0 1px rgba(255, 255, 255, 0.08);
  }

  .typewriter-typing-well::after {
    position: absolute;
    right: 10%;
    bottom: 2px;
    left: 10%;
    height: 2px;
    background: linear-gradient(90deg, transparent, #5e6462, transparent);
    content: "";
    opacity: 0.54;
  }

  .typewriter-platen-assembly {
    position: absolute;
    z-index: 5;
    top: var(--typewriter-strike-y);
    left: calc(50% + var(--paper-machine-origin));
    width: var(--typewriter-platen-width);
    height: 1px;
    transform: translateX(-50%);
  }

  .typewriter-platen-endcap {
    position: absolute;
    z-index: 6;
    top: calc(var(--line-aperture) / 2 + 1px);
    width: 44px;
    height: 48px;
    background: var(--typewriter-endcap-surface);
    box-shadow:
      inset 0 1px var(--typewriter-endcap-inset-highlight),
      inset 0 -8px 10px -9px var(--typewriter-endcap-inset-shadow);
    filter: drop-shadow(0 4px 5px var(--typewriter-endcap-cast-shadow));
  }

  .typewriter-platen-endcap.is-left {
    left: 0;
    clip-path: polygon(0 14%, 20% 0, 100% 0, 100% 72%, 78% 100%, 18% 100%, 0 82%);
  }

  .typewriter-platen-endcap.is-right {
    right: 0;
    clip-path: polygon(0 0, 80% 0, 100% 14%, 100% 82%, 82% 100%, 22% 100%, 0 72%);
  }

  .typewriter-platen-endcap::before {
    position: absolute;
    top: 1px;
    right: 5px;
    left: 5px;
    height: 5px;
    background: linear-gradient(180deg, var(--typewriter-body-inset-highlight), transparent);
    content: "";
    opacity: 0.72;
  }

  .typewriter-platen-endcap::after {
    position: absolute;
    bottom: -1px;
    width: 18px;
    height: 14px;
    clip-path: polygon(14% 0, 86% 0, 100% 100%, 0 100%);
    background: var(--typewriter-support-surface);
    box-shadow: inset 0 2px 3px rgba(0, 0, 0, 0.48);
    content: "";
  }

  .typewriter-platen-endcap.is-left::after { right: 4px; }
  .typewriter-platen-endcap.is-right::after { left: 4px; }

  .typewriter-platen-bearing {
    position: absolute;
    z-index: 8;
    top: 6px;
    width: 17px;
    height: 17px;
    border: 1px solid rgba(3, 5, 6, 0.86);
    border-radius: 50%;
    background:
      radial-gradient(circle at 42% 38%, #8d928f 0 10%, #252a2b 13% 37%, #080a0b 40% 64%, #555b59 68% 73%, #111415 76%);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.24),
      0 2px 3px rgba(0, 0, 0, 0.58);
  }

  .typewriter-platen-endcap.is-left .typewriter-platen-bearing { right: 10px; }
  .typewriter-platen-endcap.is-right .typewriter-platen-bearing { left: 10px; }

  .typewriter-bail-pivot {
    position: absolute;
    z-index: 9;
    top: 3px;
    width: 9px;
    height: 9px;
    border: 1px solid #121617;
    border-radius: 50%;
    background: radial-gradient(circle at 38% 32%, #e0e1dc, #737977 42%, #202526 72%);
    box-shadow:
      0 0 0 2px color-mix(in srgb, var(--typewriter-body-deep) 74%, transparent),
      0 2px 2px rgba(0, 0, 0, 0.46);
  }

  .typewriter-platen-endcap.is-left .typewriter-bail-pivot { left: 5px; }
  .typewriter-platen-endcap.is-right .typewriter-bail-pivot { right: 5px; }

  .typewriter-paper-wrap {
    position: absolute;
    z-index: 5;
    top: calc(var(--line-aperture) / 2 + 3px);
    left: 50%;
    width: var(--typewriter-paper-width);
    height: 24px;
    transform: translate3d(-50%, var(--typewriter-paper-tension), 0);
    transform-origin: top center;
    border-radius: 0 0 50% 50% / 0 0 14px 14px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.34), rgba(91, 98, 94, 0.045) 50%, rgba(24, 28, 26, 0.2)),
      var(--typewriter-sheet);
    box-shadow:
      inset 0 -8px 9px rgba(35, 32, 27, 0.18),
      0 2px 3px rgba(0, 0, 0, 0.26);
    transition: transform 72ms cubic-bezier(0.2, 0.72, 0.28, 1);
  }

  .typewriter-platen {
    position: absolute;
    z-index: 4;
    top: calc(var(--line-aperture) / 2 + 5px);
    right: 24px;
    left: 24px;
    height: 22px;
    border: 1px solid #020303;
    border-radius: 999px;
    background:
      repeating-linear-gradient(
        0deg,
        rgba(255, 255, 255, 0.026) 0 1px,
        transparent 1px 5px
      ),
      linear-gradient(180deg, #3b3f40 0, #1a1d1e 24%, #070809 62%, #222627 100%);
    background-position:
      0 calc(0px - var(--typewriter-platen-surface)),
      0 0;
    background-size: auto 10px, auto;
    box-shadow:
      inset 0 2px 2px rgba(255, 255, 255, 0.11),
      inset 0 -4px 5px rgba(0, 0, 0, 0.94),
      0 4px 6px rgba(0, 0, 0, 0.52);
    transition: background-position 56ms linear;
  }

  .typewriter-platen::before,
  .typewriter-platen::after {
    position: absolute;
    top: 4px;
    bottom: 4px;
    width: 8px;
    border-radius: 2px;
    background: linear-gradient(180deg, #656b69, #171b1c 58%, #050708);
    content: "";
  }

  .typewriter-platen::before { left: 5px; }
  .typewriter-platen::after { right: 5px; }

  .typewriter-paper-scale {
    position: absolute;
    z-index: 7;
    top: calc(var(--line-aperture) / 2 - 1px);
    right: 52px;
    left: 52px;
    height: 8px;
    border-top: 1px solid rgba(219, 220, 216, 0.58);
    background: repeating-linear-gradient(
      90deg,
      rgba(218, 219, 214, 0.5) 0 1px,
      transparent 1px 12px,
      rgba(218, 219, 214, 0.28) 12px 13px,
      transparent 13px 24px
    );
    mask-image: linear-gradient(90deg, transparent, #000 4%, #000 96%, transparent);
    opacity: 0.44;
  }

  .typewriter-bail-arm {
    position: absolute;
    z-index: 8;
    top: calc(var(--line-aperture) / -2 - 12px);
    width: 47px;
    height: calc(var(--line-aperture) + 20px);
    background: linear-gradient(90deg, #4b5150, #d6d7d2 46%, #6f7573 68%, #202526);
    filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.5));
  }

  .typewriter-bail-arm.is-left {
    left: 6px;
    clip-path: polygon(94% 0, 100% 1%, 10% 100%, 0 98%);
  }

  .typewriter-bail-arm.is-right {
    right: 6px;
    clip-path: polygon(0 1%, 6% 0, 100% 98%, 90% 100%);
  }

  .typewriter-bail-arm > i {
    position: absolute;
    top: -2px;
    width: 9px;
    height: 7px;
    border: 1px solid #353a39;
    border-radius: 3px;
    background: linear-gradient(180deg, #e1e2dd, #777d7a 58%, #292e2f);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.48),
      0 1px 2px rgba(0, 0, 0, 0.44);
  }

  .typewriter-bail-arm.is-left > i { right: -1px; }
  .typewriter-bail-arm.is-right > i { left: -1px; }

  .typewriter-paper-bail {
    position: absolute;
    z-index: 9;
    top: calc(var(--line-aperture) / -2 - 12px);
    right: 52px;
    left: 52px;
    height: 3px;
    border-radius: 999px;
    background: linear-gradient(180deg, #f0f1ec 0, #9da29f 48%, #4b5150 76%, #24292a);
    box-shadow:
      0 2px 3px rgba(0, 0, 0, 0.4),
      inset 0 1px rgba(255, 255, 255, 0.76);
  }

  .typewriter-paper-bail::before,
  .typewriter-paper-bail::after {
    position: absolute;
    top: -2px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: radial-gradient(circle at 38% 32%, #e5e6e1, #6e7472 58%, #202526 76%);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.48);
    content: "";
  }

  .typewriter-paper-bail::before { left: -3px; }
  .typewriter-paper-bail::after { right: -3px; }

  .typewriter-bail-roller {
    position: absolute;
    top: -3px;
    width: 28px;
    height: 9px;
    transform: translateX(-50%);
    border: 1px solid #040506;
    border-radius: 999px;
    background:
      repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.035) 0 1px, transparent 1px 4px),
      linear-gradient(180deg, #343839, #090b0c 58%, #1d2122);
    background-position:
      0 calc(0px - var(--typewriter-platen-surface)),
      0 0;
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.11),
      0 2px 3px rgba(0, 0, 0, 0.4);
    transition: background-position 56ms linear;
  }

  .typewriter-bail-roller.is-first { left: 12%; }
  .typewriter-bail-roller.is-second { left: 37%; }
  .typewriter-bail-roller.is-third { left: 63%; }
  .typewriter-bail-roller.is-fourth { left: 88%; }

  .typewriter-platen-knob {
    position: absolute;
    z-index: 7;
    top: calc(var(--line-aperture) / 2 + 1px);
    width: 30px;
    height: 30px;
    border: 1px solid #040506;
    border-radius: 50%;
    background: radial-gradient(circle at 38% 30%, #3b4041, #171a1b 46%, #07090a 78%);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.13),
      inset 0 -3px 4px rgba(0, 0, 0, 0.74),
      0 3px 6px rgba(0, 0, 0, 0.56);
  }

  .typewriter-platen-knob.is-left { left: -15px; }
  .typewriter-platen-knob.is-right { right: -15px; }

  .typewriter-platen-knob > i {
    position: absolute;
    inset: 4px;
    transform: rotate(var(--typewriter-platen-angle));
    border: 1px solid #666c6b;
    border-radius: 50%;
    background:
      radial-gradient(circle, #232728 0 31%, transparent 34%),
      conic-gradient(from -2deg, #d9d9d4 0 4deg, #363b3c 4deg 356deg, #d9d9d4 356deg);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.1),
      0 0 0 1px rgba(0, 0, 0, 0.35);
    transition: transform 56ms linear;
  }

  .typewriter-index-wheel {
    position: absolute;
    z-index: 8;
    top: calc(var(--line-aperture) / 2 + 8px);
    left: 17px;
    width: 16px;
    height: 16px;
    transform: rotate(var(--typewriter-platen-angle));
    border: 1px solid #585e5d;
    border-radius: 50%;
    background: repeating-conic-gradient(#8c918e 0 3deg, #252a2b 3deg 15deg);
    box-shadow:
      inset 0 0 0 4px #111415,
      0 1px 2px rgba(0, 0, 0, 0.5);
    opacity: 0.22;
    transition: opacity 72ms ease, transform 56ms linear;
  }

  .typewriter-detent-pawl {
    position: absolute;
    z-index: 10;
    top: calc(var(--line-aperture) / 2 + 2px);
    left: 27px;
    width: 20px;
    height: 3px;
    transform-origin: left center;
    border-radius: 999px;
    background: linear-gradient(180deg, #deded9, #777d7b 64%, #393e3f);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
    animation: typewriter-detent-release 88ms cubic-bezier(0.2, 0.76, 0.22, 1) both;
  }

  .platen-rolling .typewriter-index-wheel { opacity: 0.58; }

  .platen-detenting .typewriter-index-wheel {
    opacity: 0.88;
    animation: typewriter-index-seat 88ms cubic-bezier(0.18, 0.8, 0.24, 1) both;
  }

  .typewriter-carrier-track {
    position: absolute;
    z-index: 6;
    top: calc(var(--typewriter-strike-y) + var(--line-aperture) / 2 + 18px);
    left: 50%;
    width: min(880px, calc(100% - 58px));
    height: 5px;
    transform: translateX(-50%);
    border-radius: 2px;
    background: linear-gradient(180deg, #8f9491, #333938 42%, #090b0c 78%);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.3),
      0 3px 5px rgba(0, 0, 0, 0.62);
  }

  .typewriter-print-carrier {
    position: absolute;
    z-index: 12;
    top: var(--typewriter-strike-y);
    left: calc(50% + var(--paper-machine-origin));
    width: 46px;
    height: calc(var(--line-aperture) + 50px);
    transform: translate3d(calc(-50% + var(--print-carrier-offset)), 0, 0);
    transition: transform var(--print-carrier-track-duration) cubic-bezier(0.2, 0.72, 0.28, 1);
    will-change: transform;
  }

  .print-carrier-stepping .typewriter-print-carrier {
    transition-duration: var(--print-carrier-step-duration);
    transition-timing-function: cubic-bezier(0.18, 0.78, 0.24, 1);
  }

  .print-carrier-returning .typewriter-print-carrier {
    transition-duration: var(--print-carrier-return-duration);
    transition-timing-function: cubic-bezier(0.16, 0.92, 0.26, 1.04);
  }

  .typewriter-carrier-bearing {
    position: absolute;
    z-index: 1;
    top: calc(var(--line-aperture) / 2 + 15px);
    left: 50%;
    width: 38px;
    height: 11px;
    transform: translateX(-50%);
    clip-path: polygon(8% 0, 92% 0, 100% 34%, 86% 100%, 14% 100%, 0 34%);
    background: linear-gradient(180deg, #7c817e, #303635 34%, #090c0c 80%);
    filter: drop-shadow(0 2px 2px var(--typewriter-contact-shadow));
  }

  .typewriter-carrier-bearing::after {
    position: absolute;
    top: 2px;
    right: 7px;
    left: 7px;
    height: 4px;
    border-radius: 999px;
    background: linear-gradient(180deg, #b5b8b4, #545a58 54%, #151919);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.34);
    content: "";
  }

  .typewriter-carrier-body {
    position: absolute;
    z-index: 3;
    top: calc(var(--line-aperture) / 2 + 22px);
    left: 50%;
    width: 44px;
    height: 19px;
    transform: translateX(-50%);
    clip-path: polygon(10% 0, 90% 0, 100% 42%, 88% 100%, 12% 100%, 0 42%);
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.1), transparent 27%),
      linear-gradient(180deg, var(--typewriter-body-light), var(--typewriter-body) 44%, var(--typewriter-body-deep));
    box-shadow:
      inset 0 1px var(--typewriter-body-inset-highlight),
      0 4px 6px rgba(0, 0, 0, 0.56);
  }

  .typewriter-ribbon-gate {
    position: absolute;
    z-index: 7;
    top: calc(
      var(--type-strike-top-offset) + var(--type-strike-height) + 3.5px
    );
    left: 50%;
    box-sizing: border-box;
    width: calc(var(--type-strike-width) + 8px);
    height: 6px;
    transform: translateX(-50%);
    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.54));
  }

  .typewriter-ribbon-gate::before,
  .typewriter-ribbon-gate::after {
    position: absolute;
    top: 0;
    width: 1px;
    height: 6px;
    border-radius: 0 0 1px 1px;
    background: linear-gradient(180deg, #777d78, #252927);
    content: "";
  }

  .typewriter-ribbon-gate::before { left: 0; }
  .typewriter-ribbon-gate::after { right: 0; }

  .typewriter-element-yoke {
    position: absolute;
    z-index: 6;
    top: calc(
      var(--type-strike-top-offset) + var(--type-strike-height) + 3px
    );
    left: 50%;
    width: var(--type-element-width);
    height: calc(var(--type-element-height) + 18px);
    transform: translateX(-50%);
    transform-origin: 50% 100%;
    perspective: 110px;
  }

  .typewriter-element-yoke::after {
    position: absolute;
    z-index: -1;
    top: calc(var(--type-element-height) - 3px);
    left: 50%;
    width: 3px;
    height: max(
      4px,
      calc(
        var(--line-aperture) / 2 + 17px - var(--type-strike-top-offset) -
          var(--type-strike-height) - var(--type-element-height)
      )
    );
    transform: translateX(-50%);
    border-radius: 1px 1px 3px 3px;
    background: linear-gradient(90deg, #242927, #747b76 48%, #292f2c);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.52);
    content: "";
  }

  .typewriter-print-element {
    position: absolute;
    top: 0;
    left: 50%;
    display: block;
    width: var(--type-element-width);
    height: var(--type-element-height);
    transform: translateX(-50%);
    transition: filter 60ms ease;
  }

  .typewriter-print-element::after {
    position: absolute;
    z-index: 3;
    right: -2px;
    bottom: -2px;
    left: -2px;
    height: 46%;
    clip-path: polygon(0 30%, 100% 30%, 84% 100%, 16% 100%);
    border-top: 1px solid rgba(188, 193, 184, 0.2);
    background: linear-gradient(180deg, #303633, #111615 62%, #080b0a);
    box-shadow: 0 2px 2px rgba(0, 0, 0, 0.46);
    content: "";
  }

  .typewriter-element-shell {
    position: absolute;
    z-index: 1;
    box-sizing: border-box;
    display: block;
    width: 100%;
    height: 100%;
    transform: rotateY(var(--printing-element-rotate)) rotateX(var(--printing-element-tilt));
    transform-style: preserve-3d;
    border: 1px solid var(--typewriter-element-border);
    border-radius: 48% 48% 46% 46% / 44% 44% 52% 52%;
    background:
      radial-gradient(ellipse at 50% 20%, var(--typewriter-element-highlight), transparent 40%),
      linear-gradient(
        180deg,
        var(--typewriter-element-top) 0,
        var(--typewriter-element-mid) 58%,
        var(--typewriter-element-deep) 100%
      );
    box-shadow:
      inset 0 1px var(--typewriter-element-highlight),
      inset 0 -3px 4px rgba(0, 0, 0, 0.42),
      0 2px 2px rgba(0, 0, 0, 0.5);
    transition:
      transform var(--print-carrier-step-duration) cubic-bezier(0.18, 0.78, 0.24, 1),
      filter 60ms ease;
  }

  .typewriter-strike-face {
    position: absolute;
    z-index: 4;
    top: calc((var(--type-strike-height) + 0.5px) * -1);
    left: 50%;
    box-sizing: border-box;
    width: var(--type-strike-width);
    height: var(--type-strike-height);
    transform: translateX(-50%);
    border: 1px solid #050706;
    border-radius: 999px;
    background:
      linear-gradient(90deg, rgba(255, 255, 255, 0.05), transparent 34% 66%, rgba(255, 255, 255, 0.05)),
      linear-gradient(180deg, #292e2b, #0c0f0e 58%, #030504);
    box-shadow:
      0 0 0 1px rgba(213, 215, 205, 0.24),
      0 1px 2px rgba(0, 0, 0, 0.66);
    font-style: normal;
    transform-origin: 50% 100%;
  }

  .typewriter-strike-face::after {
    position: absolute;
    top: 100%;
    left: 50%;
    width: 3px;
    height: 4px;
    transform: translateX(-50%);
    border-radius: 0 0 1px 1px;
    background: linear-gradient(
      90deg,
      var(--typewriter-element-deep),
      var(--typewriter-element-top) 48%,
      var(--typewriter-element-deep)
    );
    content: "";
  }

  .typewriter-element-yoke.is-striking {
    animation: selectric-element-strike var(--typewriter-strike-duration) ease-in-out both;
  }

  .printing-element-striking .typewriter-ribbon-gate {
    animation: selectric-ribbon-lift var(--typewriter-strike-duration) linear both;
  }

  .typewriter-element-yoke.is-striking .typewriter-strike-face {
    animation: typewriter-strike-face-press var(--typewriter-strike-duration) linear both;
  }

  .margin-warning .typewriter-carrier-body {
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.11), transparent 27%),
      linear-gradient(180deg, #6b573d, #443725 46%, #211b13);
  }

  .margin-warning .typewriter-print-element {
    filter: drop-shadow(0 0 3px color-mix(in srgb, var(--typewriter-warning) 62%, transparent));
  }

  @keyframes selectric-element-strike {
    0% {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
    }
    12% {
      transform: translateX(-50%) translateY(1.5px);
      opacity: 1;
    }
    40%, 55% {
      transform: translateX(-50%) translateY(-6px);
      opacity: 1;
    }
    70% { transform: translateX(-50%) translateY(1.2px); }
    86% { transform: translateX(-50%) translateY(-0.6px); }
    100% {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
    }
  }

  @keyframes selectric-ribbon-lift {
    0%, 100% { transform: translateX(-50%) translateY(0); }
    38%, 56% { transform: translateX(-50%) translateY(-4px); }
    72% { transform: translateX(-50%) translateY(0.75px); }
  }

  @keyframes typewriter-strike-face-press {
    0%, 100% {
      transform: translateX(-50%) scale(1);
      filter: brightness(1);
    }
    40%, 55% {
      transform: translateX(-50%) scaleX(1.08) scaleY(0.72);
      filter: brightness(0.72);
    }
    70% {
      transform: translateX(-50%) scaleX(0.96) scaleY(1.08);
      filter: brightness(1.12);
    }
  }

  @keyframes typewriter-detent-release {
    0% { transform: rotate(-7deg) translateY(2px); opacity: 0.48; }
    42% { transform: rotate(8deg) translateY(-1px); opacity: 1; }
    72% { transform: rotate(-2deg); opacity: 0.9; }
    100% { transform: rotate(0); opacity: 0; }
  }

  @keyframes typewriter-index-seat {
    0% { filter: brightness(0.86); }
    48% { filter: brightness(1.2); }
    100% { filter: brightness(1); }
  }
  .literary-caret-mark,
  .literary-completion-mark,
  .literary-folio-trail {
    position: absolute;
    z-index: 3;
    pointer-events: none;
  }

  .literary-caret-mark {
    width: 11px;
    border-left: 1px solid rgba(137, 91, 57, 0.58);
  }

  .literary-caret-mark::before,
  .literary-caret-mark::after {
    position: absolute;
    left: -1px;
    width: 5px;
    height: 1px;
    background: rgba(137, 91, 57, 0.58);
    content: "";
  }

  .literary-caret-mark::before { top: 0; }
  .literary-caret-mark::after { bottom: 0; }

  .literary-completion-mark {
    width: 9px;
    height: 9px;
    transform: translateY(-50%) rotate(45deg);
    border: 1px solid rgba(143, 93, 57, 0.62);
    animation: literary-mark 650ms ease-out both;
  }

  .literary-completion-mark.paragraph {
    border-radius: 50%;
    background: rgba(143, 93, 57, 0.12);
  }

  @keyframes literary-mark {
    from { opacity: 0; }
    32% { opacity: 0.9; }
    to { opacity: 0; }
  }

  .literary-folio-trail {
    right: 12mm;
    display: flex;
    align-items: center;
    gap: 3px;
    height: 8px;
  }

  .literary-folio-trail span {
    width: 5px;
    height: 1px;
    background: rgba(132, 91, 58, 0.36);
  }

  .paper-editor-mount :global(.ProseMirror),
  .paper-measure-host :global(.ProseMirror) {
    box-sizing: border-box;
    width: 210mm;
    min-height: 297mm;
    margin: 0;
    outline: none;
    background: transparent;
    padding: 22mm 20mm 18mm;
    color: #28231f;
    caret-color: var(--writing-caret);
    font-family: var(--paper-font);
    font-size: 11.5pt;
    font-variant-ligatures: contextual common-ligatures;
    font-kerning: normal;
    line-height: 1.75;
    text-rendering: optimizeLegibility;
    word-break: normal;
    overflow-wrap: break-word;
  }

  .writing-typewriter .paper-editor-mount :global(.ProseMirror),
  .writing-typewriter .paper-measure-host :global(.ProseMirror) {
    font-size: 10.75pt;
    font-synthesis: weight;
    font-variant-ligatures: none;
    letter-spacing: 0.01em;
    line-height: 1.85;
  }

  .writing-typewriter .paper-editor-mount :global(.ProseMirror) {
    caret-color: transparent;
  }

  .writing-flow .paper-editor-mount :global(.ProseMirror),
  .writing-flow .paper-measure-host :global(.ProseMirror) {
    font-size: 11pt;
    letter-spacing: -0.008em;
    line-height: 1.78;
  }

  .writing-flow .paper-editor-mount :global(.ProseMirror) {
    width: 100%;
    min-height: 100%;
    padding: 72px 34px 180px;
    color: color-mix(in srgb, var(--ink-strong) 94%, #26302c);
  }

  .writing-flow .paper-editor-mount :global(.paper-page-break) {
    width: 100%;
    height: 0 !important;
  }

  .writing-literary .paper-editor-mount :global(.ProseMirror),
  .writing-literary .paper-measure-host :global(.ProseMirror) {
    font-size: 11.25pt;
    line-height: 1.9;
  }

  .writing-literary .paper-editor-mount :global(.is-settling-ink) {
    animation: ink-settle 240ms cubic-bezier(0.2, 0.72, 0.28, 1);
  }

  .writing-typewriter .paper-editor-mount :global(.is-typewriter-imprint) {
    animation: typewriter-imprint 140ms steps(2, end);
  }

  @keyframes ink-settle {
    from {
      color: color-mix(in srgb, var(--accent) 68%, #28231f);
      text-shadow: 0 0 0.8px color-mix(in srgb, var(--accent) 35%, transparent);
    }
    to {
      color: inherit;
      text-shadow: none;
    }
  }

  @keyframes typewriter-imprint {
    from {
      color: #0e0d0c;
      text-shadow: 0 0 0.6px rgba(24, 20, 17, 0.68);
    }
    to {
      color: inherit;
      text-shadow: none;
    }
  }

  .paper-editor-mount :global(.ProseMirror > *:first-child) { margin-top: 0; }
  .paper-editor-mount :global(.ProseMirror > *:last-child) { margin-bottom: 0; }
  .paper-editor-mount :global(.ProseMirror p) {
    margin: 0 0 0.95em;
    text-align: left;
  }
  .paper-editor-mount :global(.ProseMirror h1),
  .paper-editor-mount :global(.ProseMirror h2),
  .paper-editor-mount :global(.ProseMirror h3),
  .paper-editor-mount :global(.ProseMirror h4) {
    position: relative;
    color: #211d1a;
    font-family: var(--paper-font);
    font-weight: 700;
    letter-spacing: -0.025em;
    text-wrap: balance;
  }
  .writing-typewriter .paper-editor-mount :global(.ProseMirror h1),
  .writing-typewriter .paper-editor-mount :global(.ProseMirror h2),
  .writing-typewriter .paper-editor-mount :global(.ProseMirror h3),
  .writing-typewriter .paper-editor-mount :global(.ProseMirror h4) {
    font-weight: 600;
    letter-spacing: 0.025em;
  }
  .writing-literary .paper-editor-mount :global(.ProseMirror h1) {
    letter-spacing: -0.035em;
  }
  .writing-literary .paper-editor-mount :global(.ProseMirror h1::after) {
    display: block;
    width: 18mm;
    height: 1px;
    margin: 6mm auto 0;
    background: linear-gradient(90deg, transparent, rgba(128, 86, 52, 0.42), transparent);
    content: "";
  }
  .writing-flow .paper-editor-mount :global(.ProseMirror h1),
  .writing-flow .paper-editor-mount :global(.ProseMirror h2),
  .writing-flow .paper-editor-mount :global(.ProseMirror h3),
  .writing-flow .paper-editor-mount :global(.ProseMirror h4) {
    color: var(--ink-strong);
    font-weight: 650;
    letter-spacing: -0.018em;
  }
  .writing-flow .paper-editor-mount :global(.ProseMirror blockquote) {
    border-left-color: color-mix(in srgb, var(--link) 54%, transparent);
    color: var(--ink-muted);
  }
  .writing-flow .paper-editor-mount :global(.ProseMirror pre) {
    border-color: color-mix(in srgb, var(--rule) 70%, transparent);
    background: color-mix(in srgb, var(--surface-raised) 56%, transparent);
    color: var(--ink);
  }
  .paper-editor-mount :global(.ProseMirror h1) {
    margin: 4mm 0 12mm;
    font-size: 24pt;
    line-height: 1.34;
    text-align: center;
  }
  .paper-editor-mount :global(.ProseMirror h2) {
    margin: 1.85em 0 0.68em;
    font-size: 17pt;
    line-height: 1.42;
  }
  .paper-editor-mount :global(.ProseMirror h3) {
    margin: 1.55em 0 0.58em;
    font-size: 13.5pt;
    line-height: 1.48;
  }
  .paper-editor-mount :global(.ProseMirror h4) {
    margin: 1.35em 0 0.5em;
    font-size: 11.5pt;
  }
  .paper-editor-mount :global(.ProseMirror blockquote),
  .paper-measure-host :global(.ProseMirror blockquote) {
    margin: 1.25em 0;
    border-left: 2px solid #a98675;
    padding-block: 0.15em;
    padding-inline: 1.1em 0;
    color: #5c534d;
  }
  .paper-editor-mount :global(.ProseMirror blockquote > :first-child),
  .paper-measure-host :global(.ProseMirror blockquote > :first-child) {
    margin-top: 0;
  }
  .paper-editor-mount :global(.ProseMirror blockquote > :last-child),
  .paper-measure-host :global(.ProseMirror blockquote > :last-child) {
    margin-bottom: 0;
  }
  .paper-editor-mount :global(.ProseMirror ul),
  .paper-editor-mount :global(.ProseMirror ol) {
    margin: 0.9em 0 1em;
    padding-left: 1.65em;
  }
  .paper-editor-mount :global(.ProseMirror li) { margin: 0.28em 0; }
  .paper-editor-mount :global(.ProseMirror li p) { margin: 0; }
  .paper-editor-mount :global(.ProseMirror pre) {
    overflow: hidden;
    margin: 1.25em 0;
    border: 1px solid #d3ccc5;
    border-radius: 4px;
    background: #f5f2ee;
    padding: 0.85em 1em;
    font: 9pt/1.6 NanumGothicCoding, monospace;
    white-space: pre-wrap;
  }
  .paper-editor-mount :global(.ProseMirror code) {
    border-radius: 3px;
    background: rgba(91, 79, 69, 0.08);
    padding: 0.08em 0.25em;
    font-family: NanumGothicCoding, monospace;
    font-size: 0.88em;
  }
  .writing-typewriter .paper-editor-mount :global(.ProseMirror pre),
  .writing-typewriter .paper-editor-mount :global(.ProseMirror code) {
    font-family: var(--paper-font);
  }
  .paper-editor-mount :global(.ProseMirror pre code) { background: transparent; padding: 0; }
  .paper-editor-mount :global(.ProseMirror a) {
    color: #315f68;
    text-decoration-thickness: 0.06em;
    text-underline-offset: 0.16em;
  }
  .paper-editor-mount :global(.ProseMirror table) {
    width: 100%;
    margin: 1.25em 0;
    border-collapse: collapse;
    font-size: 9pt;
  }
  .paper-editor-mount :global(.ProseMirror th),
  .paper-editor-mount :global(.ProseMirror td) {
    border: 0.75pt solid #b8b0aa;
    padding: 0.5em 0.62em;
    text-align: left;
    vertical-align: top;
  }
  .paper-editor-mount :global(.ProseMirror th) { background: #f0ece7; }
  .paper-editor-mount :global(.ProseMirror img) {
    display: block;
    max-width: 100%;
    max-height: 235mm;
    margin: 1.3em auto;
    object-fit: contain;
  }
  .paper-editor-mount :global(.editorial-image) {
    display: grid;
    min-height: 34mm;
    margin: 1.3em 0;
    place-items: center;
  }
  .paper-editor-mount :global(.editorial-image img) {
    margin: 0 auto;
  }
  .paper-editor-mount :global(.editorial-image img[hidden]),
  .paper-editor-mount :global(.editorial-image-placeholder[hidden]) {
    display: none;
  }
  .paper-editor-mount :global(.editorial-image-placeholder) {
    display: grid;
    box-sizing: border-box;
    width: 100%;
    min-height: 34mm;
    place-items: center;
    border: 0.75pt dashed #c5bbb3;
    border-radius: 4px;
    background: #f5f1ec;
    padding: 1.2em;
    color: #786e67;
    font: 9pt/1.55 var(--ui-font);
    text-align: center;
  }
  .paper-editor-mount :global(.editorial-image[data-state="remote"] .editorial-image-placeholder) {
    border-style: solid;
  }
  .paper-editor-mount :global(.inline-math) {
    display: inline-block;
    margin: 0 0.08em;
    padding: 0 0.06em;
    color: #29231f;
    vertical-align: -0.08em;
  }
  .paper-editor-mount :global(.display-math) {
    overflow: hidden;
    margin: 1.45em 0;
    padding: 0.6em 0;
    color: #29231f;
    text-align: center;
  }
  .paper-editor-mount :global(aside[data-footnote-definition]) {
    display: grid;
    grid-template-columns: 2.2em minmax(0, 1fr);
    gap: 0.3em;
    margin: 0.55em 0;
    color: #554d47;
    font-size: 9pt;
    line-height: 1.62;
  }
  .paper-editor-mount :global(sup[data-footnote-reference]) {
    color: #315f68;
    font-size: 0.72em;
    font-weight: 600;
    cursor: default;
  }
  .paper-editor-mount :global(.ProseMirror .is-empty::before) {
    height: 0;
    float: left;
    color: #a49a92;
    content: attr(data-placeholder);
    pointer-events: none;
  }
  .paper-editor-mount :global(.ProseMirror h1.is-empty::before),
  .paper-editor-mount :global(.ProseMirror h2.is-empty::before),
  .paper-editor-mount :global(.ProseMirror h3.is-empty::before),
  .paper-editor-mount :global(.ProseMirror h4.is-empty::before) {
    position: absolute;
    inset: 0 0 auto;
    width: 100%;
    height: auto;
    float: none;
    text-align: inherit;
  }
  .paper-editor-mount :global(.editor-ghost-text) {
    color: #9a8e85;
    font-style: normal;
    opacity: 0.72;
    pointer-events: none;
    white-space: pre-wrap;
  }
  .paper-editor-mount :global(.editor-ghost-text kbd) {
    margin-left: 0.55em;
    border: 0.75pt solid #c5bbb3;
    border-radius: 3px;
    background: #f4efe9;
    padding: 0.05em 0.35em;
    color: #7d726a;
    font: 7.5pt/1.4 var(--ui-font);
    vertical-align: 0.12em;
  }
  .paper-editor-mount :global(.paper-page-break) {
    display: block;
    box-sizing: border-box;
    width: 100%;
    height: calc(var(--page-rest) + var(--paper-gap));
    margin: 0;
    padding: 0;
    pointer-events: none;
    user-select: none;
  }
  .writing-flow .paper-editor-mount :global(.ProseMirror > *) {
    opacity: 0.4;
    transition: opacity 180ms ease, color 180ms ease;
  }

  .writing-flow .paper-editor-mount :global(.ProseMirror > .is-active-writing-block),
  .writing-flow .paper-editor-mount :global(.ProseMirror > blockquote:has(.is-active-writing-block)),
  .writing-flow .paper-editor-mount :global(.ProseMirror > ul:has(.is-active-writing-block)),
  .writing-flow .paper-editor-mount :global(.ProseMirror > ol:has(.is-active-writing-block)),
  .writing-flow .paper-editor-mount :global(.ProseMirror > table:has(.is-active-writing-block)) {
    opacity: 1;
  }

  .flow-session-dock {
    position: absolute;
    z-index: 8;
    right: 50%;
    bottom: 18px;
    display: flex;
    min-width: min(560px, calc(100% - 48px));
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    transform: translateX(50%);
    border: 1px solid color-mix(in srgb, var(--rule) 68%, transparent);
    border-radius: 16px;
    background: color-mix(in srgb, var(--surface-raised) 88%, transparent);
    padding: 9px 13px 9px 15px;
    box-shadow: 0 12px 34px color-mix(in srgb, var(--ink-strong) 12%, transparent);
    backdrop-filter: blur(14px);
  }

  .flow-session-copy {
    display: flex;
    align-items: baseline;
    gap: 13px;
    color: var(--ink-muted);
    font-family: var(--ui-font);
  }

  .flow-session-copy small {
    color: var(--ink-faint);
    font-size: var(--type-micro);
    font-weight: 700;
    letter-spacing: 0.08em;
  }

  .flow-session-copy strong {
    color: var(--ink-strong);
    font-size: 14px;
    font-variant-numeric: tabular-nums;
  }

  .flow-session-copy strong span {
    margin-left: 3px;
    color: var(--ink-faint);
    font-size: var(--type-micro);
    font-weight: 600;
  }

  .flow-session-trace {
    display: flex;
    min-width: 86px;
    align-items: center;
    justify-content: flex-end;
    gap: 5px;
  }

  .flow-session-trace span {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--link) 62%, transparent);
  }

  .flow-session-trace span.paragraph {
    width: 8px;
    height: 2px;
    border-radius: 1px;
    background: color-mix(in srgb, var(--accent) 72%, transparent);
  }

  .focus-paragraph .paper-editor-mount :global(.ProseMirror > *) { opacity: 0.36; transition: opacity 120ms ease; }
  .focus-paragraph .paper-editor-mount :global(.ProseMirror > .is-active-writing-block),
  .focus-paragraph .paper-editor-mount :global(.ProseMirror > blockquote:has(.is-active-writing-block)),
  .focus-paragraph .paper-editor-mount :global(.ProseMirror > ul:has(.is-active-writing-block)),
  .focus-paragraph .paper-editor-mount :global(.ProseMirror > ol:has(.is-active-writing-block)) { opacity: 1; }

  .focus-sentence .paper-editor-mount :global(.ProseMirror > *) {
    opacity: 0.32;
    transition: opacity 120ms ease;
  }
  .focus-sentence .paper-editor-mount :global(.ProseMirror > .is-active-writing-block),
  .focus-sentence .paper-editor-mount :global(.ProseMirror > blockquote:has(.is-active-writing-block)),
  .focus-sentence .paper-editor-mount :global(.ProseMirror > ul:has(.is-active-writing-block)),
  .focus-sentence .paper-editor-mount :global(.ProseMirror > ol:has(.is-active-writing-block)) {
    opacity: 1;
    color: #8b8179;
  }
  .focus-sentence .paper-editor-mount :global(.is-active-writing-sentence) {
    color: #28231f;
  }

  .paper-editor-mount :global(.is-ai-context-selection) {
    border-radius: 2px;
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--accent) 58%, transparent);
  }

  .paper-toolbar-note {
    position: absolute;
    z-index: 8;
    top: 10px;
    right: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid color-mix(in srgb, var(--rule) 72%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-raised) 91%, transparent);
    padding: 5px 9px;
    box-shadow: var(--shadow-contact);
    color: var(--ink-muted);
    font: var(--type-micro)/1.2 var(--ui-font);
    backdrop-filter: blur(7px);
  }
  .paper-toolbar-note small { color: var(--accent); }

  .paper-page-navigator {
    position: absolute;
    z-index: 8;
    bottom: 10px;
    left: 50%;
    display: flex;
    align-items: center;
    gap: 3px;
    transform: translateX(-50%);
    border: 1px solid var(--control-border);
    border-radius: 999px;
    background: color-mix(in srgb, var(--control-bg) 92%, transparent);
    padding: 3px;
    box-shadow: var(--shadow-contact);
    color: var(--control-fg-muted);
    font: var(--type-micro)/1 var(--ui-font);
    backdrop-filter: blur(7px);
  }
  .paper-page-navigator button {
    display: grid;
    width: 28px;
    height: 25px;
    place-items: center;
    border-radius: 999px;
    font-size: 19px;
  }
  .paper-page-navigator span { min-width: 48px; text-align: center; }

  .paper-measure-host {
    position: fixed;
    z-index: -100;
    top: 0;
    left: -300vw;
    width: 210mm;
    visibility: hidden;
    pointer-events: none;
  }
  .paper-measure-host :global(.paper-measure-document) {
    min-height: 0 !important;
    background: transparent !important;
  }

  @media (max-width: 760px) {
    .typewriter-machine { --typewriter-frame-width: calc(100% - 14px); }
    .typewriter-carrier-track { width: calc(100% - 34px); }
    .writing-flow .paper-viewport {
      padding-right: 20px;
      padding-bottom: var(--flow-bottom-runway);
      padding-left: 20px;
    }
    .writing-flow .paper-editor-mount :global(.ProseMirror) {
      padding-right: 22px;
      padding-left: 22px;
    }
    .flow-session-dock {
      min-width: calc(100% - 32px);
      gap: 10px;
    }
    .flow-session-copy { gap: 8px; }
    .flow-session-copy small { display: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .typewriter-print-carrier,
    .typewriter-element-yoke,
    .typewriter-print-element,
    .typewriter-element-shell,
    .typewriter-strike-face,
    .typewriter-ribbon-gate,
    .typewriter-paper-wrap,
    .typewriter-platen,
    .typewriter-bail-roller,
    .typewriter-platen-knob > i,
    .typewriter-index-wheel,
    .typewriter-detent-pawl,
    .writing-flow .paper-editor-mount :global(.ProseMirror > *) {
      transition-duration: 0.001ms !important;
      animation-duration: 0.001ms !important;
    }
    .writing-literary .paper-editor-mount :global(.is-settling-ink),
    .writing-typewriter .paper-editor-mount :global(.is-typewriter-imprint),
    .literary-completion-mark {
      animation-duration: 0.001ms !important;
    }
  }

  @media (forced-colors: active) {
    .writing-typewriter .paper-editor-mount :global(.ProseMirror) {
      caret-color: CanvasText !important;
    }
    .typewriter-print-carrier { display: none; }
    .typewriter-frame-rear,
    .typewriter-frame-front,
    .typewriter-rail-recess,
    .typewriter-fixed-guide-rail,
    .typewriter-front-bevel,
    .typewriter-typing-well,
    .typewriter-typing-well::after,
    .typewriter-platen-endcap,
    .typewriter-platen-endcap::before,
    .typewriter-platen-endcap::after,
    .typewriter-platen-bearing,
    .typewriter-bail-pivot,
    .typewriter-paper-wrap,
    .typewriter-platen,
    .typewriter-platen::before,
    .typewriter-platen::after,
    .typewriter-bail-arm,
    .typewriter-bail-arm > i,
    .typewriter-paper-bail,
    .typewriter-paper-bail::before,
    .typewriter-paper-bail::after,
    .typewriter-bail-roller,
    .typewriter-platen-knob,
    .typewriter-platen-knob > i,
    .typewriter-index-wheel,
    .typewriter-detent-pawl,
    .typewriter-carrier-track {
      border-color: CanvasText;
      background: Canvas;
      box-shadow: none;
      filter: none;
      forced-color-adjust: none;
    }
    .typewriter-paper-scale {
      border-color: CanvasText;
      background: CanvasText;
      box-shadow: none;
      forced-color-adjust: none;
    }
  }

  @media print {
    @page { size: A4; margin: 0; }
    .paper-editor-shell,
    .paper-scroller,
    .paper-viewport {
      width: auto;
      height: auto;
      overflow: visible;
      background: white;
    }
    .paper-viewport { display: block; padding: 0; }
    .writing-typewriter .paper-scroller {
      -webkit-mask-image: none;
      mask-image: none;
    }
    .paper-window {
      width: 210mm !important;
      height: auto !important;
      overflow: visible;
      transform: none !important;
    }
    .paper-stack { width: 210mm !important; min-height: 0 !important; transform: none !important; }
    .paper-sheet-layer { display: flex !important; gap: 0; }
    .paper-sheet {
      border: 0;
      background-color: var(--sheet);
      background-image: var(--hanji-texture);
      box-shadow: none;
      break-after: page;
    }
    .writing-flow .paper-editor-mount {
      width: 210mm !important;
      min-height: 297mm !important;
    }
    .writing-flow .paper-editor-mount :global(.ProseMirror) {
      width: 210mm !important;
      min-height: 297mm !important;
      padding: 22mm 20mm 18mm !important;
    }
    .paper-editor-mount :global(.paper-page-break) { height: var(--page-rest); }
    .writing-flow .paper-editor-mount :global(.ProseMirror > *) { opacity: 1; }
    .paper-toolbar-note,
    .paper-page-navigator,
    .paper-measure-host,
    .typewriter-machine,
    .literary-caret-mark,
    .literary-completion-mark,
    .literary-folio-trail,
    .flow-session-dock { display: none; }
  }
</style>
