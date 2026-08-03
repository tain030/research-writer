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
  import { Marked, marked as sharedMarked } from "marked";
  import {
    PaperPagination,
    paperPageBreaks,
    setPaperPageBreaks,
    type PaperPageBreak,
  } from "./paper-pagination";
  import { ResearchMarkdownExtensions } from "./research-markdown";
  import { FocusSentence } from "./focus-sentence";
  import {
    GhostText,
    clearEditorGhostText,
    editorGhostText,
    setEditorGhostText,
  } from "./ghost-text";
  import type {
    EditorApi,
    EditorChangeContext,
    EditorSelection,
    FocusMode,
    ScrollAnchor,
  } from "./types";

  export type PageFitMode = "page" | "width";

  interface Props {
    value: string;
    readOnly?: boolean;
    fallbackTitle?: string;
    documentPath?: string;
    fontFamily?: string;
    fitMode?: PageFitMode;
    focusMode?: FocusMode;
    typewriterMode?: boolean;
    soundEnabled?: boolean;
    resolveImage?: (relativePath: string) => Promise<string | null>;
    onready?: (api: EditorApi | null) => void;
    onchange?: (value: string, context: EditorChangeContext) => void;
    onselection?: (selection: EditorSelection) => void;
    onactivity?: () => void;
    onscrollanchor?: (anchor: ScrollAnchor) => void;
    onfocuschange?: (focused: boolean) => void;
  }

  let {
    value,
    readOnly = false,
    fallbackTitle = "제목 없는 원고",
    documentPath = "",
    fontFamily = "Pretendard",
    fitMode = "width",
    focusMode = "off",
    typewriterMode = true,
    soundEnabled = false,
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

  let scroller: HTMLDivElement;
  let viewport: HTMLDivElement;
  let editorMount: HTMLDivElement;
  let measureHost: HTMLDivElement;
  let editor: TiptapEditor | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let mounted = false;
  let internalUpdate = false;
  let composing = false;
  let lastValue = "";
  let frontmatter = "";
  let layoutFrame: number | null = null;
  let layoutTimer: ReturnType<typeof setTimeout> | null = null;
  let scrollFrame: number | null = null;
  let pageCount = $state(1);
  let viewedPageIndex = $state(0);
  let viewportWidth = $state(PAGE_WIDTH + 48);
  let viewportHeight = $state(PAGE_HEIGHT + 48);
  let layoutBusy = $state(false);
  let activeSyntax = $state("");
  let layoutWaiters: Array<() => void> = [];
  let resolvedImageDocument = "";
  let imageDocumentInitialized = false;
  const imageSourceCache = new Map<string, Promise<string | null>>();
  const imageViews = new Set<{ refresh: () => void }>();
  const imageWork = new Set<Promise<unknown>>();

  let pageScale = $derived.by(() => {
    const width = Math.max(1, viewportWidth - (fitMode === "page" ? 32 : 48));
    const widthScale = width / PAGE_WIDTH;
    if (fitMode === "width") return Math.max(0.35, Math.min(1.28, widthScale));
    const heightScale = Math.max(1, viewportHeight - 32) / PAGE_HEIGHT;
    return Math.max(0.2, Math.min(1.08, widthScale, heightScale));
  });
  let pagePeriod = $derived(PAGE_HEIGHT + PAGE_GAP);
  let stackHeight = $derived(PAGE_HEIGHT * pageCount + PAGE_GAP * (pageCount - 1));
  let visibleHeight = $derived(fitMode === "page" ? PAGE_HEIGHT : stackHeight);

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
    return frontmatter.length + serializedPrefix(position).length;
  }

  function sourceToDocumentPosition(offset: number): number {
    if (!editor) return 0;
    const target = Math.max(0, offset - frontmatter.length);
    const max = editor.state.doc.content.size;
    let low = 0;
    let high = max;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (serializedPrefix(middle).length <= target) low = middle;
      else high = middle - 1;
    }
    return Math.max(1, Math.min(low, max));
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
    const stack = editorMount.closest<HTMLElement>(".paper-stack");
    const stackRect = stack?.getBoundingClientRect();
    if (!stackRect) return viewedPageIndex + 1;
    const caret = editor.view.coordsAtPos(editor.state.selection.head);
    const unscaled = (caret.top - stackRect.top) / pageScale;
    return Math.max(1, Math.min(pageCount, Math.floor(unscaled / pagePeriod) + 1));
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

  function updateActiveBlock(): void {
    if (!editor) return;
    editor.view.dom
      .querySelectorAll(".is-active-writing-block")
      .forEach((element) => element.classList.remove("is-active-writing-block"));
    const dom = editor.view.domAtPos(editor.state.selection.head).node;
    const element = dom instanceof Element ? dom : dom.parentElement;
    const block = element?.closest<HTMLElement>(
      "h1,h2,h3,h4,h5,h6,p,blockquote,li,pre,table",
    );
    block?.classList.add("is-active-writing-block");

    const parent = editor.state.selection.$from.parent;
    const headingLevel = parent.type.name === "heading" ? Number(parent.attrs.level) : 0;
    if (headingLevel) activeSyntax = `${"#".repeat(headingLevel)} 제목`;
    else if (editor.isActive("bold")) activeSyntax = "** 굵게 **";
    else if (editor.isActive("italic")) activeSyntax = "* 기울임 *";
    else if (editor.isActive("code")) activeSyntax = "` 코드 `";
    else if (editor.isActive("blockquote")) activeSyntax = "> 인용";
    else if (editor.isActive("bulletList")) activeSyntax = "- 목록";
    else if (editor.isActive("orderedList")) activeSyntax = "1. 목록";
    else activeSyntax = "";
  }

  function notifySelection(): void {
    updateActiveBlock();
    const selected = selectionInfo();
    viewedPageIndex = Math.max(0, (selected.page ?? 1) - 1);
    onselection?.(selected);
    if (typewriterMode && fitMode === "width" && editor?.isFocused) {
      centerCaret();
    }
  }

  function centerCaret(): void {
    if (!editor || !scroller) return;
    const coordinates = editor.view.coordsAtPos(editor.state.selection.head);
    const viewportRect = scroller.getBoundingClientRect();
    const delta = coordinates.top - (viewportRect.top + viewportRect.height * 0.47);
    if (Math.abs(delta) > 18) scroller.scrollTop += delta;
  }

  function playKeystroke(): void {
    if (!soundEnabled || typeof AudioContext === "undefined") return;
    try {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.value = 112 + Math.random() * 10;
      gain.gain.setValueAtTime(0.018, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.035);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.04);
      oscillator.addEventListener("ended", () => void context.close(), { once: true });
    } catch {
      // Sound is deliberately optional and must never interrupt writing.
    }
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

  function emitChange(): void {
    if (!editor || internalUpdate) return;
    const next = canonicalMarkdown();
    if (next === lastValue || differsOnlyByTerminalBlankLines(next, lastValue)) {
      return;
    }
    lastValue = next;
    onchange?.(next, { composing: editor.view.composing || composing });
    if (!editor.view.composing && !composing) onactivity?.();
  }

  function outerHeight(element: HTMLElement): number {
    const style = getComputedStyle(element);
    return (
      element.getBoundingClientRect().height +
      (Number.parseFloat(style.marginTop) || 0) +
      (Number.parseFloat(style.marginBottom) || 0)
    );
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

  function splitTextBlockAcrossPages(
    block: HTMLElement,
    blockIndex: number,
    usedBeforeBlock: number,
  ): { breaks: PaperPageBreak[]; remainder: number } | null {
    const characters = measuredCharacters(block, blockIndex);
    if (characters.length < 2) return null;
    const blockRect = block.getBoundingClientRect();
    if (blockRect.height <= 0) return null;
    const bottoms = new Map<number, number>();
    const characterBottom = (index: number): number => {
      const cached = bottoms.get(index);
      if (cached !== undefined) return cached;
      const character = characters[index];
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

    const result: PaperPageBreak[] = [];
    let startIndex = 0;
    let segmentTop = blockRect.top;
    let available = PAGE_BODY - usedBeforeBlock;
    while (startIndex < characters.length) {
      const boundary = lastCharacterAtOrBefore(
        startIndex,
        segmentTop + available,
      );
      if (boundary < startIndex || boundary >= characters.length - 1) break;
      const boundaryBottom = characterBottom(boundary);
      const consumed = Math.max(0, boundaryBottom - segmentTop);
      result.push({
        pos: characters[boundary].modelPosition,
        restPx:
          Math.max(0, available - consumed) + PAGE_BOTTOM + PAGE_TOP,
      });
      startIndex = boundary + 1;
      segmentTop = boundaryBottom;
      available = PAGE_BODY;
    }
    if (result.length === 0) return null;
    const lastBottom = characterBottom(characters.length - 1);
    return {
      breaks: result,
      remainder: Math.max(0, lastBottom - segmentTop),
    };
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

  async function reflowPages(): Promise<void> {
    if (!editor || !mounted || !measureHost) return;
    layoutBusy = true;
    await document.fonts?.ready;
    await tick();
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
        image.decode ? image.decode().catch(() => undefined) : Promise.resolve(),
      ),
    );

    const blocks = Array.from(clone.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && !element.classList.contains("paper-page-break"),
    );
    const positions: number[] = [];
    editor.state.doc.forEach((_node, offset) => positions.push(offset));
    const breaks: PaperPageBreak[] = [];
    let used = 0;

    blocks.forEach((block, index) => {
      const height = outerHeight(block);
      const next = blocks[index + 1];
      const keepWithNext = /^H[1-6]$/.test(block.tagName) && Boolean(next);
      const required = height + (keepWithNext && next ? outerHeight(next) : 0);
      const splittable = ["P", "PRE"].includes(block.tagName);
      if (
        splittable &&
        used + height > PAGE_BODY + PAGE_EPSILON &&
        !keepWithNext
      ) {
        const split = splitTextBlockAcrossPages(block, index, used);
        if (split) {
          breaks.push(...split.breaks);
          used = split.remainder;
          return;
        }
      }
      if (index > 0 && used > 0 && used + required > PAGE_BODY + PAGE_EPSILON) {
        breaks.push({
          pos: positions[index] ?? 0,
          restPx: Math.max(0, PAGE_BODY - used) + PAGE_BOTTOM + PAGE_TOP,
        });
        used = 0;
      }
      used += height;
      if (used > PAGE_BODY && height > PAGE_BODY) {
        used = Math.min(PAGE_BODY, used % PAGE_BODY || PAGE_BODY);
      }
    });

    const current = paperPageBreaks(editor.view);
    if (!equalBreaks(current, breaks)) setPaperPageBreaks(editor.view, breaks);
    pageCount = Math.max(1, breaks.length + 1);
    viewedPageIndex = Math.min(viewedPageIndex, pageCount - 1);
    measureHost.replaceChildren();
    layoutBusy = false;
    resolveLayoutWaiters();
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
    if (!viewport) return;
    viewportWidth = viewport.clientWidth || PAGE_WIDTH + 48;
    viewportHeight = viewport.clientHeight || PAGE_HEIGHT + 48;
  }

  function handleScroll(): void {
    if (fitMode === "page" || scrollFrame !== null) return;
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
        StarterKit.configure({ link: { openOnClick: false } }),
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
        GhostText,
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
            return false;
          },
          compositionend: () => {
            composing = false;
            queueMicrotask(() => {
              emitChange();
              playKeystroke();
            });
            return false;
          },
          focus: () => {
            onfocuschange?.(true);
            return false;
          },
          blur: () => {
            onfocuschange?.(false);
            return false;
          },
        },
        handleKeyDown: (view, event) => {
          const ghost = editorGhostText(view);
          if (event.key === "Escape" && ghost) {
            clearEditorGhostText(view);
            return true;
          }
          if (event.key !== "Tab" || !ghost) return false;
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
        emitChange();
        if (!composing) playKeystroke();
        scheduleLayout();
      },
      onSelectionUpdate: notifySelection,
      onTransaction: ({ transaction }) => {
        if (transaction.docChanged) scheduleLayout();
      },
      onFocus: notifySelection,
    });
    resizeObserver = new ResizeObserver(measureViewport);
    resizeObserver.observe(viewport);
    measureViewport();
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
    if (mounted && editor) editor.setEditable(editable, false);
  });

  $effect(() => {
    fontFamily;
    fitMode;
    focusMode;
    void tick().then(scheduleLayout);
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
  class:fit-page={fitMode === "page"}
  class:focus-paragraph={focusMode === "paragraph"}
  class:focus-sentence={focusMode === "sentence"}
  class="paper-editor-shell"
  style={`--paper-font:"${fontFamily.replaceAll('"', '\\"')}", Pretendard, sans-serif;--paper-scale:${pageScale};--paper-gap:${PAGE_GAP}px`}
>
  <div class="paper-toolbar-note" aria-live="polite">
    <span>에디토리얼 A4</span>
    {#if activeSyntax}<small>{activeSyntax}</small>{/if}
    {#if layoutBusy}<small>조판 중…</small>{/if}
  </div>

  <div
    class:fit-page={fitMode === "page"}
    class="paper-scroller"
    bind:this={scroller}
    onscroll={handleScroll}
  >
    <div class="paper-viewport" bind:this={viewport}>
      <div
        class:fit-page={fitMode === "page"}
        class="paper-window"
        style={`width:${PAGE_WIDTH * pageScale}px;height:${visibleHeight * pageScale}px`}
      >
        <div
          class="paper-stack"
          style={`width:${PAGE_WIDTH}px;min-height:${stackHeight}px;transform:translateY(-${fitMode === "page" ? viewedPageIndex * pagePeriod * pageScale : 0}px) scale(${pageScale})`}
        >
          <div class="paper-sheet-layer" aria-hidden="true">
            {#each Array(pageCount) as _, index}
              <div class="paper-sheet"><span>{index + 1}</span></div>
            {/each}
          </div>
          <div class="paper-editor-mount" bind:this={editorMount}></div>
        </div>
      </div>
    </div>
  </div>

  {#if fitMode === "page" && pageCount > 1}
    <nav class="paper-page-navigator" aria-label="쪽 이동">
      <button aria-label="이전 쪽" disabled={viewedPageIndex === 0} onclick={() => changePage(-1)}>‹</button>
      <span>{viewedPageIndex + 1} / {pageCount}</span>
      <button aria-label="다음 쪽" disabled={viewedPageIndex >= pageCount - 1} onclick={() => changePage(1)}>›</button>
    </nav>
  {/if}

  <div class="paper-measure-host" bind:this={measureHost} aria-hidden="true"></div>
</div>

<style>
  .paper-editor-shell {
    position: relative;
    height: 100%;
    min-width: 0;
    overflow: hidden;
    background:
      radial-gradient(circle at 20% 0%, color-mix(in srgb, var(--sheet) 20%, transparent), transparent 38%),
      var(--desk);
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
    z-index: 1;
    width: 210mm;
    min-height: 297mm;
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
    caret-color: var(--accent);
    font-family: var(--paper-font);
    font-size: 11.5pt;
    font-variant-ligatures: contextual common-ligatures;
    font-kerning: normal;
    line-height: 1.75;
    text-rendering: optimizeLegibility;
    word-break: normal;
    overflow-wrap: break-word;
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
  .paper-editor-mount :global(.ProseMirror blockquote) {
    margin: 1.25em 0;
    border-left: 2px solid #a98675;
    padding: 0.15em 0 0.15em 1.1em;
    color: #5c534d;
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
    width: 170mm;
    height: calc(var(--page-rest) + var(--paper-gap));
    margin: 0;
    padding: 0;
    pointer-events: none;
    user-select: none;
  }
  .paper-editor-mount :global(.is-active-writing-block::before) {
    position: absolute;
    right: calc(100% + 8px);
    width: 7mm;
    color: #aa8878;
    font: 8pt/1.4 NanumGothicCoding, monospace;
    opacity: 0.72;
    text-align: right;
  }
  .paper-editor-mount :global(h1.is-active-writing-block::before) { content: "#"; }
  .paper-editor-mount :global(h2.is-active-writing-block::before) { content: "##"; }
  .paper-editor-mount :global(h3.is-active-writing-block::before) { content: "###"; }
  .paper-editor-mount :global(h4.is-active-writing-block::before) { content: "####"; }

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
    .paper-window { width: 210mm !important; height: auto !important; overflow: visible; }
    .paper-stack { min-height: 0 !important; transform: none !important; }
    .paper-sheet-layer { gap: 0; }
    .paper-sheet {
      border: 0;
      background-color: var(--sheet);
      background-image: var(--hanji-texture);
      box-shadow: none;
      break-after: page;
    }
    .paper-editor-mount :global(.paper-page-break) { height: var(--page-rest); }
    .paper-toolbar-note, .paper-page-navigator, .paper-measure-host { display: none; }
  }
</style>
