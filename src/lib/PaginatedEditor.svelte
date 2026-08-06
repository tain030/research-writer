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
    carriageReturnDuration as resolveCarriageReturnDuration,
    isTypebarKey,
    renderedTranslateX,
    resolveCarriageOrigin,
    resolveCarriageTarget,
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
    fontFamily = "Goorm Sans Code",
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
  const TYPEBAR_STRIKE_MS = 140;
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
  let carriageFrame: number | null = null;
  let workspaceFrame: number | null = null;
  let pageCount = $state(1);
  let viewedPageIndex = $state(0);
  let viewportWidth = $state(PAGE_WIDTH + 48);
  let viewportHeight = $state(PAGE_HEIGHT + 48);
  let continuousHeight = $state(PAGE_HEIGHT);
  let layoutBusy = $state(false);
  let activeFormatLabel = $state("");
  let caretLine = $state<CaretLineGeometry | null>(null);
  let caretAlignedToStrike = $state(false);
  let carriageShift = $state(0);
  let carriageOrigin = $state(0);
  let typewriterScrollbarGutter = $state(0);
  let carriageReturning = $state(false);
  let carriageStepping = $state(false);
  let carriageAdvancePending = false;
  let typebarStriking = $state(false);
  let typebarStrikeId = $state(0);
  let lineFeeding = $state(false);
  let platenRolling = $state(false);
  let platenDetenting = $state(false);
  let platenAngle = $state(0);
  let platenSurfaceOffset = $state(0);
  let platenDirection = $state<PlatenDirection>(0);
  let platenIntensity = $state(0);
  let platenDetentSequence = $state(0);
  let carriageReturnMs = $state(180);
  let marginWarning = $state(false);
  let literaryCompletion = $state<"sentence" | "paragraph" | null>(null);
  let nextTypebarStrikeId = 0;
  let lastPhysicalTypebarAt = Number.NEGATIVE_INFINITY;
  let typebarStrikeTimer: ReturnType<typeof setTimeout> | null = null;
  let carriageStepTimer: ReturnType<typeof setTimeout> | null = null;
  let returnTimer: ReturnType<typeof setTimeout> | null = null;
  let lineFeedFrame: number | null = null;
  let lineFeedTimer: ReturnType<typeof setTimeout> | null = null;
  let lineFeedTarget: number | null = null;
  let lineFeedPending = false;
  let programmaticScrollGuard = false;
  let programmaticScrollTarget: number | null = null;
  let literaryTimer: ReturnType<typeof setTimeout> | null = null;
  let lastCarriageLineTop: number | null = null;
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
      ? '"Goorm Sans Code", NanumGothicCoding, monospace'
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

  function resetCarriage(): void {
    cancelLineFeed(false);
    clearProgrammaticScrollMarker();
    carriageShift = 0;
    caretAlignedToStrike = false;
    marginWarning = false;
    lastCarriageLineTop = null;
    carriageAdvancePending = false;
  }

  function triggerCarriageReturn(feedLine = false): void {
    if (returnTimer) clearTimeout(returnTimer);
    carriageReturnMs = resolveCarriageReturnDuration(carriageShift);
    carriageReturning = true;
    returnTimer = setTimeout(() => {
      carriageReturning = false;
      returnTimer = null;
    }, carriageReturnMs);
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

  function cancelCarriageReturn(): void {
    if (returnTimer) clearTimeout(returnTimer);
    returnTimer = null;
    carriageReturning = false;
  }

  function stopTypebarStrike(): void {
    if (typebarStrikeTimer) clearTimeout(typebarStrikeTimer);
    typebarStrikeTimer = null;
    typebarStriking = false;
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
      scheduleCarriagePosition();
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
      scheduleCarriagePosition();
    }, 220);
  }

  function triggerTypebarStrike(): void {
    if (experience !== "typewriter" || !mounted) {
      return;
    }
    if (typebarStrikeTimer) clearTimeout(typebarStrikeTimer);
    typebarStrikeId = ++nextTypebarStrikeId;
    typebarStriking = true;
    typebarStrikeTimer = setTimeout(() => {
      typebarStriking = false;
      typebarStrikeTimer = null;
    }, TYPEBAR_STRIKE_MS);
  }

  function triggerCarriageStep(): void {
    if (carriageStepTimer) clearTimeout(carriageStepTimer);
    carriageStepping = true;
    carriageStepTimer = setTimeout(() => {
      carriageStepping = false;
      carriageStepTimer = null;
    }, 60);
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
      caretAlignedToStrike
    ) {
      return;
    }
    if (lineFeedFrame !== null) cancelLineFeed(true);
    updateCarriagePosition();
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
    scheduleCarriagePosition();
    return true;
  }

  function updateCarriagePosition(): void {
    if (
      !editor ||
      !editor.isFocused ||
      readOnly ||
      experience !== "typewriter"
    ) {
      resetCarriage();
      return;
    }
    if (
      !(editor.state.selection instanceof TextSelection) ||
      !editor.state.selection.empty
    ) {
      caretAlignedToStrike = false;
      marginWarning = false;
      lastCarriageLineTop = null;
      carriageAdvancePending = false;
      return;
    }
    if (!scroller || !paperWindow) {
      caretAlignedToStrike = false;
      marginWarning = false;
      return;
    }

    const aligned = alignTypewriterLine();
    try {
      const caret = editor.view.coordsAtPos(editor.state.selection.head);
      const scrollerBounds = scroller.getBoundingClientRect();
      const machineBounds = typewriterMachine?.getBoundingClientRect();
      const strikeBounds =
        machineBounds && machineBounds.width > 0
          ? machineBounds
          : scrollerBounds;
      const paperRect = paperWindow.getBoundingClientRect();
      const stack = editorMount.closest<HTMLElement>(".paper-stack");
      const stackRect = stack?.getBoundingClientRect();
      if (!stackRect || pageScale <= 0) return;
      const strikePoint = strikeBounds.left + strikeBounds.width * 0.5;
      const renderedShift = renderedTranslateX(
        getComputedStyle(paperWindow).transform,
      );
      if (renderedShift === null) {
        carriageAdvancePending = false;
        return;
      }
      if (machineBounds) {
        const nextOrigin = resolveCarriageOrigin({
          paperLeft: paperRect.left,
          paperWidth: paperRect.width,
          renderedShift,
          machineLeft: machineBounds.left,
          machineWidth: machineBounds.width,
        });
        if (nextOrigin !== null) carriageOrigin = nextOrigin;
      }
      const nextShift = resolveCarriageTarget({
        renderedShift,
        caretLeft: caret.left,
        strikePoint,
      });
      if (nextShift === null) {
        carriageAdvancePending = false;
        return;
      }
      const lineTop = (caret.top - stackRect.top) / pageScale;
      const lineHeight = Math.max(1, (caret.bottom - caret.top) / pageScale);
      if (
        carriageAdvancePending &&
        lastCarriageLineTop !== null &&
        !carriageReturning &&
        lineTop > lastCarriageLineTop + lineHeight * 0.55
      ) {
        triggerCarriageReturn(true);
      }
      lastCarriageLineTop = lineTop;
      carriageShift = nextShift;
      caretAlignedToStrike = aligned;
      carriageAdvancePending = false;
      const caretOnPaper = (caret.left - paperRect.left) / pageScale;
      marginWarning = caretOnPaper >= PAGE_WIDTH - 28 * MM_TO_PX;
    } catch {
      caretAlignedToStrike = false;
      carriageAdvancePending = false;
    }
  }

  function scheduleCarriagePosition(): void {
    if (carriageFrame !== null) cancelAnimationFrame(carriageFrame);
    carriageFrame = requestAnimationFrame(() => {
      carriageFrame = null;
      updateCarriagePosition();
    });
  }

  function notifySelection(): void {
    if (experience === "typewriter") markProgrammaticScroll();
    const block = updateActiveBlock();
    scheduleCaretLine();
    scheduleCarriagePosition();
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
        scheduleCarriagePosition();
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
      carriageAdvancePending = true;
      if (activity.kind === "enter") {
        if (!carriageReturning) triggerCarriageReturn(true);
      } else {
        cancelCarriageReturn();
        cancelLineFeed(true);
        triggerCarriageStep();
      }
      scheduleCarriagePosition();
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
      scheduleCarriagePosition();
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

  function centerCarriageForFreeScroll(): void {
    if (experience !== "typewriter") return;
    clearProgrammaticScrollMarker();
    if (lineFeedFrame !== null || lineFeedPending) cancelLineFeed(false);
    if (carriageFrame !== null) cancelAnimationFrame(carriageFrame);
    carriageFrame = null;
    cancelCarriageReturn();
    if (carriageStepTimer) clearTimeout(carriageStepTimer);
    carriageStepTimer = null;
    carriageStepping = false;
    carriageAdvancePending = false;
    lastCarriageLineTop = null;
    marginWarning = false;
    caretAlignedToStrike = false;
    carriageShift = 0;
  }

  function handleFreeScrollIntent(): void {
    centerCarriageForFreeScroll();
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
      centerCarriageForFreeScroll();
    }
  }

  function handleScroll(): void {
    const programmatic =
      experience === "typewriter" && consumeProgrammaticScroll();
    updatePlatenFromScroll();
    if (experience === "typewriter" && programmatic) {
      caretAlignedToStrike = caretMatchesTypewriterStrike();
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
              pendingInput?.kind === "character" &&
              performance.now() - lastPhysicalTypebarAt > 80
            ) {
              triggerTypebarStrike();
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
              resetCarriage();
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
              if (experience === "typewriter") triggerCarriageReturn(true);
              pendingInput.paragraphHadContent = Boolean(
                view.state.selection.$from.parent.textContent.trim(),
              );
            }
          }
          if (
            experience === "typewriter" &&
            isTypebarKey(event)
          ) {
            lastPhysicalTypebarAt = performance.now();
            triggerTypebarStrike();
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
        if (experience === "typewriter") markProgrammaticScroll();
        emitChange();
        updateActiveBlock();
        scheduleLayout();
        scheduleCaretLine();
        scheduleCarriagePosition();
      },
      onSelectionUpdate: ({ transaction }) => {
        if (
          experience === "typewriter" &&
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
    measureViewport();
    resetPlatenMotion(experience === "typewriter");
    scheduleLayout();
    notifySelection();
    onready?.(api());
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
      if (readOnly) caretLine = null;
      else scheduleCaretLine();
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
        resetCarriage();
        resetPlatenMotion(false);
      } else if (changed) {
        resetPlatenMotion(true);
      }
      if (nextExperience !== "flow") lastFlowBlock = null;
      scheduleLayout();
      scheduleCaretLine();
      scheduleCarriagePosition();
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
    if (carriageFrame !== null) cancelAnimationFrame(carriageFrame);
    if (workspaceFrame !== null) cancelAnimationFrame(workspaceFrame);
    stopTypebarStrike();
    cancelLineFeed(false);
    if (carriageStepTimer) clearTimeout(carriageStepTimer);
    if (returnTimer) clearTimeout(returnTimer);
    if (literaryTimer) clearTimeout(literaryTimer);
    scroller?.removeEventListener("pointerdown", handleScrollPointerDown);
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
  class:typewriter-strike-point-visible={experience === "typewriter" && caretAlignedToStrike && Boolean(caretLine)}
  class:carriage-returning={carriageReturning}
  class:carriage-stepping={carriageStepping}
  class:typebar-striking={typebarStriking}
  class:line-feeding={lineFeeding}
  class:platen-rolling={platenRolling}
  class:platen-detenting={platenDetenting}
  class:margin-warning={marginWarning}
  class="paper-editor-shell"
  style={`--paper-font:"${fontFamily.replaceAll('"', '\\"')}", ${paperFontFallback};--paper-scale:${pageScale};--paper-gap:${PAGE_GAP}px;--carriage-origin:${carriageOrigin}px;--carriage-shift:${carriageShift}px;--carriage-track-duration:90ms;--carriage-step-duration:48ms;--carriage-return-duration:${carriageReturnMs}ms;--typewriter-strike-duration:${TYPEBAR_STRIKE_MS}ms;--typewriter-scrollbar-gutter:${typewriterScrollbarGutter}px;--typewriter-paper-width:${PAGE_WIDTH * pageScale}px;--typewriter-strike-bottom:${typewriterStrikeBottom}px;--typewriter-strike-y:calc(100% - var(--typewriter-strike-bottom));--typewriter-line-aperture:${typewriterLineAperture}px;--typewriter-platen-angle:${platenAngle}deg;--typewriter-platen-surface:${platenSurfaceOffset}px;--typewriter-platen-intensity:${platenIntensity};--typewriter-paper-tension:${typewriterPaperTension}px;--typewriter-platen-pitch:${typewriterPlatenPitch}px;--flow-width:${flowWidth}px;--typewriter-top-runway:${typewriterTopRunway}px;--typewriter-bottom-runway:${typewriterBottomRunway}px;--flow-top-runway:${flowTopRunway}px;--flow-bottom-runway:${flowBottomRunway}px`}
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
      class:active={caretAlignedToStrike && Boolean(caretLine)}
      class="typewriter-machine"
      bind:this={typewriterMachine}
      style={`--line-aperture:var(--typewriter-line-aperture);--strike-caret-height:${Math.max(16, Math.min(50, (caretLine?.height ?? 22) * pageScale - 2))}px`}
      data-platen-detent={platenDetentSequence}
      aria-hidden="true"
    >
      <div class="typewriter-frame-rear">
        <span class="typewriter-rail-recess"></span>
        <span class="typewriter-fixed-guide-rail"></span>
      </div>
      <div class="typewriter-typebasket"></div>
      <div class="typewriter-carriage-layer typewriter-carriage-underlay">
        <span class="typewriter-moving-channel"></span>
        <span class="typewriter-bearing-shoe is-left"><i></i></span>
        <span class="typewriter-bearing-shoe is-right"><i></i></span>
      </div>
      <div class="typewriter-frame-front">
        <span class="typewriter-front-bevel"></span>
        <span class="typewriter-typing-well"></span>
      </div>
      <div class="typewriter-carriage-layer typewriter-carriage-upper">
        <span class="typewriter-carriage-side-plate is-left">
          <i class="typewriter-platen-bearing"></i>
          <i class="typewriter-bail-pivot"></i>
        </span>
        <span class="typewriter-carriage-side-plate is-right">
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
        <span class="typewriter-carriage-knob is-left"><i></i></span>
        <span class="typewriter-carriage-knob is-right"><i></i></span>
        <span class="typewriter-index-wheel"></span>
        {#if platenDetenting}
          {#key platenDetentSequence}
            <span class="typewriter-detent-pawl"></span>
          {/key}
        {/if}
        <span class="typewriter-return-lever">
          <i></i>
        </span>
      </div>
      <div class="typewriter-strike-rail">
        <span class="typewriter-ribbon-band"></span>
        <span class="typewriter-segment"></span>
        {#if caretAlignedToStrike && caretLine}
          <span class="typewriter-strike-caret"></span>
        {/if}
        <span class="typewriter-type-guide">
          {#if caretAlignedToStrike && caretLine && typebarStriking}
            {#key typebarStrikeId}
              <span class="typewriter-ribbon-vibrator"></span>
              <span class="typewriter-live-typebar">
                <i class="typewriter-type-slug"></i>
              </span>
            {/key}
          {/if}
        </span>
      </div>
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

  .writing-typewriter .paper-window {
    transform: translate3d(var(--carriage-shift), 0, 0);
    transition: transform var(--carriage-track-duration) cubic-bezier(0.2, 0.72, 0.28, 1);
    will-change: transform;
  }

  .writing-typewriter.carriage-stepping .paper-window {
    transition: transform var(--carriage-step-duration) cubic-bezier(0.18, 0.78, 0.24, 1);
  }

  .writing-typewriter.carriage-returning .paper-window {
    transition-duration: var(--carriage-return-duration);
    transition-timing-function: cubic-bezier(0.16, 0.92, 0.26, 1.08);
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

  .writing-flow .paper-editor-mount {
    width: 100%;
    min-height: 100%;
  }

  /*
   * A full-scale portable typewriter cropped by the bottom of the viewport.
   * The carriage follows the paper while the type guide and chassis stay fixed.
   */
  .typewriter-machine {
    --typewriter-enamel: #294744;
    --typewriter-enamel-deep: #172824;
    --typewriter-enamel-light: #466963;
    --typewriter-rubber: #111413;
    --typewriter-metal: #b8bcb7;
    --typewriter-metal-deep: #686f6c;
    --typewriter-metal-dark: #343a37;
    --typewriter-ribbon: #171617;
    --typewriter-grip: #5b2f2a;
    --typewriter-warning: #d19a53;
    position: absolute;
    z-index: 6;
    inset: 0;
    right: var(--typewriter-scrollbar-gutter);
    overflow: hidden;
    isolation: isolate;
    pointer-events: none;
  }

  .typewriter-typebasket {
    position: absolute;
    z-index: 3;
    top: calc(var(--typewriter-strike-y) + var(--line-aperture) / 2 - 4px);
    left: 50%;
    width: 120px;
    height: 36px;
    transform: translate(-50%, 9px) scale(0.94);
    clip-path: polygon(12% 0, 88% 0, 100% 100%, 0 100%);
    background:
      repeating-conic-gradient(from 248deg at 50% 118%, transparent 0deg 7deg, rgba(184, 188, 183, 0.42) 7.2deg 8deg),
      radial-gradient(ellipse at 50% 112%, #0c100f 0 40%, #424a47 42% 52%, transparent 54%);
    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.48));
    opacity: 0;
    transition: opacity 54ms ease-out, transform 72ms cubic-bezier(0.2, 0.76, 0.28, 1);
  }

  .typebar-striking .typewriter-typebasket {
    transform: translate(-50%, 0) scale(1);
    opacity: 0.42;
  }

  .typewriter-paper-wrap {
    position: absolute;
    z-index: 2;
    top: calc(var(--line-aperture) / 2 + 3px);
    right: 44px;
    left: 44px;
    height: 22px;
    transform-origin: top center;
    border-radius: 0 0 48% 48% / 0 0 15px 15px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.3), rgba(105, 111, 106, 0.055) 48%, rgba(37, 41, 39, 0.2)),
      var(--typewriter-sheet);
    box-shadow:
      inset 0 -6px 8px rgba(44, 39, 31, 0.16),
      0 1px 2px rgba(0, 0, 0, 0.2);
  }

  .typewriter-platen {
    position: absolute;
    z-index: 3;
    top: calc(var(--line-aperture) / 2 + 7px);
    right: 26px;
    left: 26px;
    height: 18px;
    border: 1px solid #080a0b;
    border-radius: 999px;
    background:
      repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.025) 0 1px, transparent 1px 4px),
      linear-gradient(180deg, #333735 0, #1d211f 27%, var(--typewriter-rubber) 66%, #272c29 100%);
    background-size: auto 8px, auto;
    box-shadow:
      inset 0 2px 2px rgba(255, 255, 255, 0.09),
      inset 0 -2px 3px rgba(0, 0, 0, 0.9),
      0 2px 4px rgba(0, 0, 0, 0.32);
  }

  .typewriter-paper-scale {
    position: absolute;
    z-index: 4;
    top: calc(var(--line-aperture) / 2 + 1px);
    right: 44px;
    left: 44px;
    height: 8px;
    border-top: 1px solid rgba(207, 211, 207, 0.72);
    background: repeating-linear-gradient(90deg, rgba(210, 214, 211, 0.55) 0 1px, transparent 1px 18px);
    mask-image: linear-gradient(90deg, transparent, #000 5%, #000 95%, transparent);
    opacity: 0.42;
  }

  .typewriter-paper-bail {
    position: absolute;
    z-index: 6;
    top: calc(var(--line-aperture) / -2 - 13px);
    right: 44px;
    left: 44px;
    height: 2px;
    border-radius: 999px;
    background: linear-gradient(180deg, #d4d7d3, #777d79 62%, #424844);
    box-shadow:
      0 1px 2px rgba(0, 0, 0, 0.32),
      inset 0 1px rgba(255, 255, 255, 0.64);
  }

  .typewriter-bail-roller {
    position: absolute;
    top: -4px;
    width: 31px;
    height: 10px;
    transform: translateX(-50%);
    border: 1px solid #111516;
    border-radius: 999px;
    background: linear-gradient(180deg, #424744, #141716 56%, #292e2b);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.11),
      0 1px 2px rgba(0, 0, 0, 0.28);
  }

  .typewriter-bail-roller.is-first { left: 12%; }
  .typewriter-bail-roller.is-second { left: 37%; }
  .typewriter-bail-roller.is-third { left: 63%; }
  .typewriter-bail-roller.is-fourth { left: 88%; }

  .typewriter-carriage-knob {
    position: absolute;
    z-index: 4;
    top: calc(var(--line-aperture) / 2 + 8px);
    width: 29px;
    height: 22px;
    border: 1px solid #080a0b;
    border-radius: 8px;
    background:
      repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.06) 0 1px, transparent 1px 4px),
      linear-gradient(180deg, #303432, var(--typewriter-rubber) 60%, #232825);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.12),
      0 2px 5px rgba(0, 0, 0, 0.42);
  }

  .typewriter-carriage-knob::before {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 9px;
    height: 9px;
    transform: translate(-50%, -50%);
    border: 1px solid var(--typewriter-metal-deep);
    border-radius: 50%;
    background: linear-gradient(145deg, #c3c7c2, #646b67 54%, #242a27);
    content: "";
  }

  .typewriter-carriage-knob.is-left { left: -14px; }
  .typewriter-carriage-knob.is-right { right: -14px; }

  .typewriter-return-lever {
    position: absolute;
    z-index: 9;
    top: calc(var(--line-aperture) / 2 + 5px);
    right: calc(100% - 30px);
    width: 126px;
    height: 4px;
    transform: rotate(8deg);
    transform-origin: right center;
    border: 1px solid #444b48;
    border-radius: 999px;
    background: linear-gradient(180deg, #d9dcd8, #969c98 46%, #5b625f);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.62),
      0 2px 4px rgba(0, 0, 0, 0.32);
  }

  .typewriter-return-lever::after {
    position: absolute;
    top: 50%;
    right: -5px;
    width: 10px;
    height: 10px;
    transform: translateY(-50%);
    border: 1px solid #343a38;
    border-radius: 50%;
    background: radial-gradient(circle at 38% 34%, #e2e4df, #747b78 48%, #202624 76%);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.42),
      0 2px 3px rgba(0, 0, 0, 0.42);
    content: "";
  }

  .typewriter-return-lever i {
    position: absolute;
    top: -5px;
    left: -3px;
    width: 31px;
    height: 12px;
    border: 1px solid #0c0f10;
    border-radius: 9px 5px 5px 9px;
    background: linear-gradient(180deg, #76443c, var(--typewriter-grip) 58%, #38201d);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.12);
  }

  .carriage-returning .typewriter-return-lever {
    animation: typewriter-lever-return var(--carriage-return-duration) cubic-bezier(0.2, 0.74, 0.25, 1) both;
  }

  .typewriter-strike-rail {
    position: absolute;
    z-index: 7;
    top: var(--typewriter-strike-y);
    left: 50%;
    width: min(1020px, calc(100% - 34px));
    height: var(--line-aperture);
    transform: translate(-50%, -50%);
    transition:
      opacity 140ms ease,
      filter 140ms ease;
  }

  .typewriter-strike-rail::before {
    position: absolute;
    right: 38%;
    bottom: -8px;
    left: 38%;
    height: 9px;
    background: radial-gradient(ellipse at 50% 0, rgba(8, 12, 11, 0.18), transparent 68%);
    content: "";
  }

  .typewriter-strike-rail::after {
    position: absolute;
    right: 16%;
    bottom: -11px;
    left: 16%;
    height: 1px;
    background: linear-gradient(
      90deg,
      transparent,
      rgba(184, 188, 183, 0.14) 12%,
      rgba(184, 188, 183, 0.32) 50%,
      rgba(184, 188, 183, 0.14) 88%,
      transparent
    );
    content: "";
  }

  .typewriter-ribbon-band {
    position: absolute;
    z-index: 1;
    right: 19%;
    bottom: -11px;
    left: 19%;
    height: 5px;
    border-top: 1px solid rgba(107, 70, 62, 0.38);
    border-bottom: 1px solid #080a0b;
    background:
      linear-gradient(180deg, #282222, var(--typewriter-ribbon) 62%, #0b0c0b);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.32);
    opacity: 0.82;
  }

  .typewriter-segment {
    position: absolute;
    z-index: 2;
    bottom: -29px;
    left: 50%;
    width: 88px;
    height: 20px;
    transform: translateX(-50%);
    clip-path: polygon(9% 100%, 0 32%, 12% 5%, 35% 0, 65% 0, 88% 5%, 100% 32%, 91% 100%);
    border-top: 1px solid rgba(207, 211, 206, 0.48);
    background: linear-gradient(180deg, #777e7a 0, #3e4643 22%, #171d1b 72%, #0e1311 100%);
    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.46));
    opacity: 0.86;
  }

  .typewriter-machine.active .typewriter-strike-rail { opacity: 1; }

  .typewriter-type-guide {
    position: absolute;
    z-index: 4;
    bottom: -25px;
    left: 50%;
    width: 36px;
    height: 25px;
    transform: translateX(-50%);
    clip-path: polygon(0 100%, 10% 25%, 35% 25%, 43% 0, 57% 0, 65% 25%, 90% 25%, 100% 100%);
    background: linear-gradient(90deg, #202624, #6f7773 25%, #b8bcb7 49%, #686f6c 73%, #191f1d);
    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.5));
    transition: filter 120ms ease;
  }

  .typewriter-live-typebar {
    position: absolute;
    z-index: 3;
    bottom: -24px;
    left: 50%;
    box-sizing: border-box;
    width: 4px;
    height: 60px;
    transform-origin: 50% 100%;
    border: 1px solid #3f4644;
    border-radius: 2px;
    background: linear-gradient(90deg, #252a28, #a9ada8 48%, #363c39);
    box-shadow:
      inset 1px 0 rgba(255, 255, 255, 0.16),
      0 2px 3px rgba(0, 0, 0, 0.42);
    backface-visibility: hidden;
    pointer-events: none;
    animation: typewriter-typebar-strike var(--typewriter-strike-duration) linear both;
  }

  .typewriter-type-slug {
    position: absolute;
    top: -6px;
    left: 50%;
    box-sizing: border-box;
    width: 13px;
    height: 7px;
    transform: translateX(-50%);
    border: 1px solid #292e2c;
    border-radius: 2px;
    background: linear-gradient(180deg, #b8bbb6, #555b58 58%, #1f2422);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.28),
      0 1px 2px rgba(0, 0, 0, 0.45);
  }

  .typewriter-ribbon-vibrator {
    position: absolute;
    z-index: 2;
    top: 7px;
    left: 50%;
    box-sizing: border-box;
    width: 18px;
    height: 9px;
    border-top: 2px solid #171314;
    border-right: 2px solid #929793;
    border-left: 2px solid #929793;
    border-radius: 5px 5px 1px 1px;
    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.46));
    pointer-events: none;
    animation: typewriter-ribbon-lift var(--typewriter-strike-duration) linear both;
  }

  .margin-warning .typewriter-type-guide {
    border-bottom-color: #8d6030;
  }

  .line-feeding .typewriter-platen {
    animation: typewriter-platen-feed 160ms linear both;
  }

  .line-feeding .typewriter-paper-wrap {
    animation: typewriter-paper-feed 160ms cubic-bezier(0.2, 0.72, 0.26, 1) both;
  }

  .line-feeding .typewriter-carriage-knob::before {
    animation: typewriter-knob-feed 160ms linear both;
  }

  @keyframes typewriter-typebar-strike {
    0% {
      transform: translateX(-50%) translateY(20px) rotateX(62deg);
      opacity: 0;
    }
    12% {
      transform: translateX(-50%) translateY(14px) rotateX(48deg);
      opacity: 0.38;
    }
    30% {
      transform: translateX(-50%) translateY(1px) rotateX(8deg);
      opacity: 1;
      animation-timing-function: cubic-bezier(0.1, 0.72, 0.2, 1);
    }
    32%, 39% {
      transform: translateX(-50%) translateY(-2px) rotateX(0deg);
      opacity: 1;
    }
    46% {
      transform: translateX(-50%) translateY(2px) rotateX(12deg);
      opacity: 0.86;
      animation-timing-function: cubic-bezier(0.22, 0.05, 0.36, 1);
    }
    100% {
      transform: translateX(-50%) translateY(20px) rotateX(62deg);
      opacity: 0;
    }
  }

  @keyframes typewriter-ribbon-lift {
    0%, 16%, 100% {
      transform: translateX(-50%) translateY(7px);
      opacity: 0;
    }
    24% {
      transform: translateX(-50%) translateY(2px);
      opacity: 0.72;
    }
    30%, 42% {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
    }
    55% {
      transform: translateX(-50%) translateY(7px);
      opacity: 0;
    }
  }

  @keyframes typewriter-lever-return {
    0% { transform: rotate(8deg); }
    44% { transform: rotate(2deg); }
    100% { transform: rotate(8deg); }
  }

  @keyframes typewriter-platen-feed {
    from { background-position: 0 0, 0 0; }
    to { background-position: 0 8px, 0 0; }
  }

  @keyframes typewriter-paper-feed {
    0% { transform: translateY(4px) scaleY(0.92); filter: brightness(0.94); }
    100% { transform: translateY(0) scaleY(1); filter: brightness(1); }
  }

  @keyframes typewriter-knob-feed {
    from { transform: translate(-50%, -50%) rotate(0deg); }
    to { transform: translate(-50%, -50%) rotate(24deg); }
  }

  /*
   * Contemporary precision-instrument skin. The paper and carriage mechanics
   * stay legible, while colored enamel and decorative vintage hardware are
   * deliberately removed from the visible machine edge.
   */
  .typewriter-machine {
    --typewriter-enamel: var(--typewriter-body);
    --typewriter-enamel-deep: var(--typewriter-body-deep);
    --typewriter-enamel-light: var(--typewriter-body-light);
    --typewriter-rubber: #080a0b;
    --typewriter-metal: #d8d8d3;
    --typewriter-metal-deep: #808583;
    --typewriter-metal-dark: #3e4445;
    --typewriter-ribbon: #090a0b;
    --typewriter-grip: #121516;
    --typewriter-warning: #c79a54;
  }

  .typewriter-typebasket {
    top: calc(var(--typewriter-strike-y) + var(--line-aperture) / 2 - 3px);
    width: 104px;
    height: 31px;
    transform: translate(-50%, 10px) scale(0.92);
    background:
      repeating-conic-gradient(
        from 250deg at 50% 118%,
        transparent 0deg 8.5deg,
        rgba(192, 194, 190, 0.48) 8.8deg 9.6deg
      ),
      radial-gradient(ellipse at 50% 114%, #080a0b 0 42%, #343a3b 44% 51%, transparent 53%);
    opacity: 0;
  }

  .typebar-striking .typewriter-typebasket {
    transform: translate(-50%, 10px) scale(0.92);
    opacity: 0.18;
  }

  .typewriter-paper-wrap {
    top: calc(var(--line-aperture) / 2 + 3px);
    right: 43px;
    left: 43px;
    height: 23px;
    transform: translateY(var(--typewriter-paper-tension));
    border-radius: 0 0 50% 50% / 0 0 13px 13px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.34), rgba(91, 98, 94, 0.045) 50%, rgba(24, 28, 26, 0.2)),
      var(--typewriter-sheet);
    box-shadow:
      inset 0 -7px 8px rgba(35, 32, 27, 0.17),
      0 1px 2px rgba(0, 0, 0, 0.24);
    transition: transform 72ms cubic-bezier(0.2, 0.72, 0.28, 1);
  }

  .typewriter-platen {
    top: calc(var(--line-aperture) / 2 + 6px);
    right: 25px;
    left: 25px;
    height: 20px;
    border-color: #020303;
    background:
      repeating-linear-gradient(
        0deg,
        rgba(255, 255, 255, 0.026) 0 1px,
        transparent 1px 5px
      ),
      linear-gradient(180deg, #323638 0, #171a1b 25%, #070809 62%, #202425 100%);
    background-position:
      0 calc(0px - var(--typewriter-platen-surface)),
      0 0;
    background-size: auto 10px, auto;
    box-shadow:
      inset 0 2px 2px rgba(255, 255, 255, 0.1),
      inset 0 -3px 4px rgba(0, 0, 0, 0.94),
      0 2px 5px rgba(0, 0, 0, 0.44);
  }

  .typewriter-platen::after {
    position: absolute;
    top: 3px;
    right: 14px;
    left: 14px;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(231, 232, 227, 0.12), transparent);
    content: "";
  }

  .typewriter-paper-scale {
    top: calc(var(--line-aperture) / 2);
    right: 43px;
    left: 43px;
    height: 7px;
    border-color: rgba(219, 220, 216, 0.62);
    background: repeating-linear-gradient(
      90deg,
      rgba(218, 219, 214, 0.5) 0 1px,
      transparent 1px 12px,
      rgba(218, 219, 214, 0.3) 12px 13px,
      transparent 13px 24px
    );
    opacity: 0.46;
  }

  .typewriter-paper-bail {
    top: calc(var(--line-aperture) / -2 - 12px);
    right: 42px;
    left: 42px;
    height: 2px;
    background: linear-gradient(180deg, #eeeeea, #9a9e9b 58%, #4f5555);
    box-shadow:
      0 1px 2px rgba(0, 0, 0, 0.36),
      inset 0 1px rgba(255, 255, 255, 0.7);
  }

  .typewriter-bail-roller {
    top: -3px;
    width: 27px;
    height: 8px;
    border-color: #050607;
    background:
      repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.035) 0 1px, transparent 1px 4px),
      linear-gradient(180deg, #303435, #090b0c 58%, #1d2021);
    background-position:
      0 calc(0px - var(--typewriter-platen-surface)),
      0 0;
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.1),
      0 1px 2px rgba(0, 0, 0, 0.36);
  }

  .typewriter-carriage-knob {
    top: calc(var(--line-aperture) / 2 + 3px);
    width: 30px;
    height: 30px;
    border-color: #040506;
    border-radius: 50%;
    background: radial-gradient(circle at 38% 30%, #34393a, #151819 46%, #080a0b 78%);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.12),
      inset 0 -2px 3px rgba(0, 0, 0, 0.72),
      0 2px 6px rgba(0, 0, 0, 0.5);
  }

  .typewriter-carriage-knob::before { display: none; }

  .typewriter-carriage-knob.is-left { left: -13px; }
  .typewriter-carriage-knob.is-right { right: -13px; }

  .typewriter-carriage-knob > i {
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
  }

  .typewriter-index-wheel {
    position: absolute;
    z-index: 5;
    top: calc(var(--line-aperture) / 2 + 9px);
    left: 20px;
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
    transition: opacity 72ms ease;
  }

  .typewriter-detent-pawl {
    position: absolute;
    z-index: 7;
    top: calc(var(--line-aperture) / 2 + 3px);
    left: 29px;
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

  .typewriter-return-lever {
    height: 3px;
    border: 0;
    background: linear-gradient(180deg, #e2e2dd, #989d9a 48%, #555b5a);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.72),
      0 2px 3px rgba(0, 0, 0, 0.36);
  }

  .typewriter-return-lever i {
    top: -4px;
    left: -2px;
    width: 29px;
    height: 10px;
    border-color: #050607;
    border-radius: 8px 3px 3px 8px;
    background: linear-gradient(180deg, #292d2f, #111415 62%, #090b0c);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.1),
      0 1px 2px rgba(0, 0, 0, 0.44);
  }

  .typewriter-strike-rail::before {
    right: 44%;
    bottom: -8px;
    left: 44%;
    height: 8px;
    background: radial-gradient(ellipse at 50% 0, rgba(0, 0, 0, 0.28), transparent 72%);
  }

  .typewriter-strike-rail::after { display: none; }

  .typewriter-ribbon-band {
    right: 24%;
    bottom: -9px;
    left: 24%;
    height: 3px;
    border-color: #020303;
    background: linear-gradient(180deg, #202324, #070809 68%);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.46);
    opacity: 0.9;
  }

  .typewriter-segment {
    bottom: -25px;
    width: 74px;
    height: 16px;
    border-color: rgba(222, 223, 218, 0.52);
    background: linear-gradient(180deg, #858b88 0, #444a4a 26%, #171b1c 72%, #090b0c 100%);
    opacity: 0.78;
  }

  .typewriter-type-guide {
    bottom: -29px;
    width: 24px;
    height: 28px;
    clip-path: none;
    border: 0;
    border-bottom: 4px solid #696f6d;
    border-radius: 0 0 4px 4px;
    background: transparent;
    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.6));
    perspective: 90px;
    perspective-origin: 50% 100%;
    overflow: visible;
  }

  .typewriter-type-guide::before {
    position: absolute;
    top: 1px;
    bottom: 0;
    left: 2px;
    width: 4px;
    clip-path: polygon(38% 0, 100% 0, 100% 100%, 0 100%, 0 22%);
    background: linear-gradient(90deg, #777d7b, #deded9 56%, #767c7a);
    content: "";
  }

  .typewriter-type-guide::after {
    position: absolute;
    top: 1px;
    right: 2px;
    bottom: 0;
    width: 4px;
    clip-path: polygon(0 0, 62% 0, 100% 22%, 100% 100%, 0 100%);
    background: linear-gradient(90deg, #6b716f, #d1d1cc 48%, #686e6c);
    content: "";
  }

  .line-feeding .typewriter-platen,
  .line-feeding .typewriter-paper-wrap,
  .line-feeding .typewriter-carriage-knob::before {
    animation: none;
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

  /* A cropped precision rail supports the moving carriage without exposing a body shell. */
  .typewriter-machine {
    --typewriter-frame-width: min(940px, calc(100% - 18px));
    --typewriter-carriage-width: calc(var(--typewriter-paper-width) + 104px);
    --typewriter-frame-top: calc(
      var(--typewriter-strike-y) + var(--line-aperture) / 2 + 13px
    );
    --typewriter-platen-center: calc(var(--line-aperture) / 2 + 16px);
    --typewriter-frame-surface: var(--typewriter-chassis-surface);
    --typewriter-frame-facet: var(--typewriter-chassis-deck-overlay);
    --typewriter-frame-face: var(--typewriter-chassis-front-overlay);
    --typewriter-carriage-surface: var(--typewriter-endcap-surface);
    --typewriter-bearing-surface: var(--typewriter-race-surface);
    --typewriter-channel-surface: var(--typewriter-support-surface);
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
      var(--typewriter-frame-surface) 25% 100%
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
    background: var(--typewriter-bearing-surface);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.36),
      inset 0 -2px 2px rgba(0, 0, 0, 0.8),
      0 3px 5px rgba(0, 0, 0, 0.54);
  }

  .typewriter-carriage-layer {
    position: absolute;
    top: var(--typewriter-strike-y);
    left: calc(50% + var(--carriage-origin));
    width: var(--typewriter-carriage-width);
    height: 1px;
    transform: translate3d(calc(-50% + var(--carriage-shift)), 0, 0);
    transition: transform var(--carriage-track-duration) cubic-bezier(0.2, 0.72, 0.28, 1);
    will-change: transform;
  }

  .typewriter-carriage-underlay { z-index: 3; }
  .typewriter-carriage-upper { z-index: 5; }

  .writing-typewriter.carriage-stepping .typewriter-carriage-layer {
    transition: transform var(--carriage-step-duration) cubic-bezier(0.18, 0.78, 0.24, 1);
  }

  .writing-typewriter.carriage-returning .typewriter-carriage-layer {
    transition-duration: var(--carriage-return-duration);
    transition-timing-function: cubic-bezier(0.16, 0.92, 0.26, 1.08);
  }

  .typewriter-moving-channel {
    position: absolute;
    top: calc(var(--line-aperture) / 2 + 17px);
    right: 17px;
    left: 17px;
    height: 9px;
    clip-path: polygon(0 18%, 1.2% 0, 98.8% 0, 100% 18%, 99.2% 100%, 0.8% 100%);
    background: var(--typewriter-channel-surface);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.24),
      inset 0 -4px 5px rgba(0, 0, 0, 0.68),
      0 4px 7px var(--typewriter-contact-shadow);
  }

  .typewriter-moving-channel::before {
    position: absolute;
    top: 2px;
    right: 12px;
    left: 12px;
    height: 2px;
    background: linear-gradient(
      90deg,
      transparent,
      rgba(232, 233, 228, 0.42) 8%,
      rgba(232, 233, 228, 0.18) 50%,
      rgba(232, 233, 228, 0.42) 92%,
      transparent
    );
    content: "";
  }

  .typewriter-bearing-shoe {
    position: absolute;
    z-index: 2;
    top: calc(var(--line-aperture) / 2 + 19px);
    width: 76px;
    height: 11px;
    clip-path: polygon(7% 0, 93% 0, 100% 38%, 86% 100%, 14% 100%, 0 38%);
    background: linear-gradient(
      180deg,
      #747a78 0,
      #343a3a 30%,
      #111516 72%,
      #060809 100%
    );
    filter: drop-shadow(0 3px 3px var(--typewriter-contact-shadow));
  }

  .typewriter-bearing-shoe.is-left { left: 18%; }
  .typewriter-bearing-shoe.is-right { right: 18%; }

  .typewriter-bearing-shoe > i {
    position: absolute;
    top: 2px;
    right: 8px;
    left: 8px;
    height: 5px;
    border-radius: 999px;
    background: var(--typewriter-bearing-surface);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.42),
      inset 0 -2px 2px rgba(0, 0, 0, 0.76),
      0 2px 3px rgba(0, 0, 0, 0.62);
  }

  .typewriter-frame-front {
    z-index: 4;
    top: calc(var(--typewriter-frame-top) + 11px);
    height: 7px;
    clip-path: polygon(0.8% 0, 99.2% 0, 100% 100%, 0 100%);
    background:
      var(--typewriter-frame-face),
      var(--typewriter-frame-surface);
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
    background: var(--typewriter-frame-facet);
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

  .typewriter-carriage-side-plate {
    position: absolute;
    z-index: 6;
    top: calc(var(--line-aperture) / 2 + 1px);
    width: 44px;
    height: 48px;
    background: var(--typewriter-carriage-surface);
    box-shadow:
      inset 0 1px var(--typewriter-endcap-inset-highlight),
      inset 0 -8px 10px -9px var(--typewriter-endcap-inset-shadow);
    filter: drop-shadow(0 4px 5px var(--typewriter-endcap-cast-shadow));
  }

  .typewriter-carriage-side-plate.is-left {
    left: 0;
    clip-path: polygon(0 14%, 20% 0, 100% 0, 100% 72%, 78% 100%, 18% 100%, 0 82%);
  }

  .typewriter-carriage-side-plate.is-right {
    right: 0;
    clip-path: polygon(0 0, 80% 0, 100% 14%, 100% 82%, 82% 100%, 22% 100%, 0 72%);
  }

  .typewriter-carriage-side-plate::before {
    position: absolute;
    top: 1px;
    right: 5px;
    left: 5px;
    height: 5px;
    background: linear-gradient(180deg, var(--typewriter-body-inset-highlight), transparent);
    content: "";
    opacity: 0.72;
  }

  .typewriter-carriage-side-plate::after {
    position: absolute;
    bottom: -1px;
    width: 18px;
    height: 14px;
    clip-path: polygon(14% 0, 86% 0, 100% 100%, 0 100%);
    background: var(--typewriter-channel-surface);
    box-shadow: inset 0 2px 3px rgba(0, 0, 0, 0.48);
    content: "";
  }

  .typewriter-carriage-side-plate.is-left::after { right: 4px; }
  .typewriter-carriage-side-plate.is-right::after { left: 4px; }

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

  .typewriter-carriage-side-plate.is-left .typewriter-platen-bearing { right: 10px; }
  .typewriter-carriage-side-plate.is-right .typewriter-platen-bearing { left: 10px; }

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

  .typewriter-carriage-side-plate.is-left .typewriter-bail-pivot { left: 5px; }
  .typewriter-carriage-side-plate.is-right .typewriter-bail-pivot { right: 5px; }

  .typewriter-paper-wrap {
    z-index: 5;
    top: calc(var(--line-aperture) / 2 + 3px);
    right: auto;
    left: 50%;
    width: var(--typewriter-paper-width);
    height: 24px;
    transform: translate3d(-50%, var(--typewriter-paper-tension), 0);
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
    z-index: 4;
    top: calc(var(--line-aperture) / 2 + 5px);
    right: 24px;
    left: 24px;
    height: 22px;
    border: 1px solid #020303;
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
    z-index: 7;
    top: calc(var(--line-aperture) / 2 - 1px);
    right: 52px;
    left: 52px;
    height: 8px;
    border-color: rgba(219, 220, 216, 0.58);
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
    z-index: 9;
    top: calc(var(--line-aperture) / -2 - 12px);
    right: 52px;
    left: 52px;
    height: 3px;
    border: 0;
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
    top: -3px;
    width: 28px;
    height: 9px;
    border-color: #040506;
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

  .typewriter-carriage-knob {
    z-index: 7;
    top: calc(var(--line-aperture) / 2 + 1px);
    width: 30px;
    height: 30px;
    border-color: #040506;
    border-radius: 50%;
    background: radial-gradient(circle at 38% 30%, #3b4041, #171a1b 46%, #07090a 78%);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.13),
      inset 0 -3px 4px rgba(0, 0, 0, 0.74),
      0 3px 6px rgba(0, 0, 0, 0.56);
  }

  .typewriter-carriage-knob.is-left { left: -15px; }
  .typewriter-carriage-knob.is-right { right: -15px; }

  .typewriter-carriage-knob > i {
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
    z-index: 8;
    top: calc(var(--line-aperture) / 2 + 8px);
    left: 17px;
    width: 16px;
    height: 16px;
  }

  .typewriter-detent-pawl {
    z-index: 10;
    top: calc(var(--line-aperture) / 2 + 2px);
    left: 27px;
  }

  .typewriter-return-lever {
    z-index: 4;
    top: calc(var(--line-aperture) / 2 + 5px);
    right: calc(100% - 30px);
    left: auto;
    width: 126px;
    height: 4px;
    transform: rotate(8deg);
    transform-origin: right center;
    border: 0;
    background: linear-gradient(180deg, #e4e5e0, #969c99 48%, #4b5150);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.72),
      0 3px 4px rgba(0, 0, 0, 0.4);
  }

  .typewriter-return-lever i {
    top: -4px;
    left: -2px;
    width: 30px;
    height: 11px;
    border-color: #050607;
    border-radius: 8px 3px 3px 8px;
    background: linear-gradient(180deg, #313536, #111415 62%, #080a0b);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.11),
      0 2px 3px rgba(0, 0, 0, 0.48);
  }

  .typewriter-typebasket {
    z-index: 4;
    top: calc(var(--typewriter-strike-y) + var(--line-aperture) / 2 - 2px);
    width: 108px;
    height: 34px;
    transform: translate(-50%, 11px) scale(0.92);
    background:
      repeating-conic-gradient(
        from 250deg at 50% 118%,
        transparent 0deg 8.5deg,
        rgba(192, 194, 190, 0.5) 8.8deg 9.6deg
      ),
      radial-gradient(ellipse at 50% 114%, #080a0b 0 42%, #3a4040 44% 51%, transparent 53%);
  }

  .typebar-striking .typewriter-typebasket {
    transform: translate(-50%, 11px) scale(0.92);
    opacity: 0.18;
  }

  .typewriter-segment {
    bottom: -31px;
    width: 80px;
    height: 20px;
    clip-path: polygon(8% 100%, 0 35%, 12% 5%, 34% 0, 66% 0, 88% 5%, 100% 35%, 92% 100%);
    background: linear-gradient(180deg, #888e8b 0, #454b4a 24%, #171b1c 70%, #080a0b 100%);
    filter: drop-shadow(0 3px 3px rgba(0, 0, 0, 0.62));
    opacity: 0.84;
  }

  .typewriter-ribbon-band {
    right: auto;
    bottom: -10px;
    left: 50%;
    width: 196px;
    height: 4px;
    transform: translateX(-50%);
    border: 0;
    border-radius: 1px;
    background: linear-gradient(180deg, #252829, #050607 72%);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.06),
      0 2px 3px rgba(0, 0, 0, 0.52);
    opacity: 0.94;
  }

  .typewriter-ribbon-band::before,
  .typewriter-ribbon-band::after {
    position: absolute;
    top: -3px;
    width: 13px;
    height: 10px;
    border: 1px solid #080a0b;
    border-radius: 50%;
    background: radial-gradient(circle at 42% 35%, #666c6a, #171b1c 48%, #050708 74%);
    box-shadow:
      inset 0 1px rgba(255, 255, 255, 0.12),
      0 2px 3px rgba(0, 0, 0, 0.52);
    content: "";
  }

  .typewriter-ribbon-band::before { left: -5px; }
  .typewriter-ribbon-band::after { right: -5px; }

  .typewriter-type-guide {
    bottom: -29px;
    width: 24px;
    height: 28px;
    border-bottom: 4px solid #555b59;
    border-radius: 0 0 4px 4px;
    filter: drop-shadow(0 3px 2px rgba(0, 0, 0, 0.66));
    perspective: 90px;
    perspective-origin: 50% 100%;
    overflow: visible;
  }

  .typewriter-type-guide::before,
  .typewriter-type-guide::after {
    top: 1px;
    bottom: 1px;
    width: 4px;
  }

  .typewriter-type-guide::before {
    left: 2px;
    background: linear-gradient(90deg, #626866, #e1e2dd 58%, #707674);
  }

  .typewriter-type-guide::after {
    right: 2px;
    background: linear-gradient(90deg, #666c6a, #d4d5d0 48%, #5e6462);
  }

  .typewriter-strike-caret {
    position: absolute;
    z-index: 5;
    top: 50%;
    left: 50%;
    width: 1px;
    height: var(--strike-caret-height);
    transform: translate(-50%, -50%);
    border-radius: 1px;
    background: #555b5a;
    box-shadow: 0 0 0 1px rgba(232, 232, 227, 0.12);
    pointer-events: none;
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

  .typewriter-strike-point-visible .paper-editor-mount :global(.ProseMirror) {
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
    .typewriter-strike-rail {
      width: calc(100% - 18px);
    }
    .typewriter-machine { --typewriter-frame-width: calc(100% - 14px); }
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
    .writing-typewriter .paper-window,
    .typewriter-carriage-layer,
    .typewriter-strike-rail,
    .typewriter-typebasket,
    .typewriter-type-guide,
    .typewriter-live-typebar,
    .typewriter-type-slug,
    .typewriter-ribbon-vibrator,
    .typewriter-paper-wrap,
    .typewriter-platen,
    .typewriter-bail-roller,
    .typewriter-carriage-knob > i,
    .typewriter-index-wheel,
    .typewriter-detent-pawl,
    .typewriter-return-lever,
    .writing-flow .paper-editor-mount :global(.ProseMirror > *) {
      transition-duration: 0.001ms !important;
      animation-duration: 0.001ms !important;
    }
    .typewriter-live-typebar,
    .typewriter-ribbon-vibrator { display: none !important; }
    .typebar-striking .typewriter-typebasket { opacity: 0; }
    .writing-literary .paper-editor-mount :global(.is-settling-ink),
    .writing-typewriter .paper-editor-mount :global(.is-typewriter-imprint),
    .literary-completion-mark {
      animation-duration: 0.001ms !important;
    }
  }

  @media (forced-colors: active) {
    .typewriter-strike-point-visible .paper-editor-mount :global(.ProseMirror) {
      caret-color: CanvasText;
    }
    .typewriter-strike-caret,
    .typewriter-type-guide { display: none; }
    .typewriter-frame-rear,
    .typewriter-frame-front,
    .typewriter-rail-recess,
    .typewriter-fixed-guide-rail,
    .typewriter-moving-channel,
    .typewriter-moving-channel::before,
    .typewriter-bearing-shoe,
    .typewriter-bearing-shoe > i,
    .typewriter-front-bevel,
    .typewriter-typing-well,
    .typewriter-typing-well::after,
    .typewriter-typebasket,
    .typewriter-segment,
    .typewriter-carriage-side-plate,
    .typewriter-carriage-side-plate::before,
    .typewriter-carriage-side-plate::after,
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
    .typewriter-carriage-knob,
    .typewriter-carriage-knob > i,
    .typewriter-index-wheel,
    .typewriter-detent-pawl,
    .typewriter-return-lever,
    .typewriter-return-lever::after,
    .typewriter-return-lever i,
    .typewriter-type-guide {
      border-color: CanvasText;
      background: Canvas;
      box-shadow: none;
      filter: none;
      forced-color-adjust: none;
    }
    .typewriter-strike-rail::before { background: transparent; }
    .typewriter-strike-rail::after,
    .typewriter-paper-scale,
    .typewriter-ribbon-band,
    .typewriter-ribbon-band::before,
    .typewriter-ribbon-band::after {
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
