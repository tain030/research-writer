<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
  import {
    bracketMatching,
    defaultHighlightStyle,
    indentUnit,
    syntaxHighlighting,
  } from "@codemirror/language";
  import { markdown } from "@codemirror/lang-markdown";
  import { search, searchKeymap } from "@codemirror/search";
  import {
    Annotation,
    Compartment,
    EditorState,
    Transaction,
  } from "@codemirror/state";
  import {
    drawSelection,
    dropCursor,
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
  } from "@codemirror/view";
  import type { EditorApi } from "./Editor.svelte";
  import type {
    EditorChangeContext,
    EditorSelection,
    ScrollAnchor,
  } from "./types";

  interface Props {
    value: string;
    readOnly?: boolean;
    fontFamily?: string;
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
    fontFamily = "Pretendard",
    onready,
    onchange,
    onselection,
    onactivity,
    onscrollanchor,
    onfocuschange,
  }: Props = $props();

  let host: HTMLDivElement;
  let view: EditorView | null = null;
  let mounted = false;
  let lastValue = "";
  let lastSelectionSignature = "";
  let scrollFrame: number | null = null;
  let compositionNeedsCommit = false;
  const externalUpdate = Annotation.define<boolean>();
  const readOnlyCompartment = new Compartment();
  const editableCompartment = new Compartment();

  function selectionInfo(state = view?.state): EditorSelection {
    if (!state) return { from: 0, to: 0, text: "", line: 1 };
    const range = state.selection.main;
    const from = Math.min(range.anchor, range.head);
    const to = Math.max(range.anchor, range.head);
    return {
      from,
      to,
      text: state.sliceDoc(from, to),
      line: state.doc.lineAt(range.head).number,
    };
  }

  function notifySelection(state = view?.state): void {
    if (!state) return;
    const range = state.selection.main;
    const signature = `${range.anchor}:${range.head}:${state.doc.length}`;
    if (signature === lastSelectionSignature) return;
    lastSelectionSignature = signature;
    onselection?.(selectionInfo(state));
  }

  function currentAnchor(): ScrollAnchor {
    return {
      offset: view?.viewport.from ?? 0,
      source: "source",
    };
  }

  function scheduleScrollAnchor(): void {
    if (scrollFrame !== null) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      onscrollanchor?.(currentAnchor());
    });
  }

  function replaceRange(from: number, to: number, text: string): void {
    if (!view || readOnly) return;
    const safeFrom = Math.max(0, Math.min(from, view.state.doc.length));
    const safeTo = Math.max(safeFrom, Math.min(to, view.state.doc.length));
    view.dispatch({
      changes: { from: safeFrom, to: safeTo, insert: text },
      selection: { anchor: safeFrom + text.length },
      scrollIntoView: true,
    });
    view.focus();
  }

  function setSelection(from: number, to: number): void {
    if (!view) return;
    const safeFrom = Math.max(0, Math.min(from, view.state.doc.length));
    const safeTo = Math.max(safeFrom, Math.min(to, view.state.doc.length));
    view.dispatch({
      selection: { anchor: safeFrom, head: safeTo },
      effects: EditorView.scrollIntoView(safeTo, { y: "nearest" }),
    });
    view.focus();
  }

  function scrollToLine(line: number): void {
    if (!view) return;
    const safeLine = Math.max(1, Math.min(line, view.state.doc.lines));
    setSelection(view.state.doc.line(safeLine).from, view.state.doc.line(safeLine).from);
  }

  function scrollToAnchor(anchor: ScrollAnchor): void {
    if (!view) return;
    const offset = Math.max(0, Math.min(anchor.offset, view.state.doc.length));
    view.dispatch({ effects: EditorView.scrollIntoView(offset, { y: "start" }) });
  }

  function api(): EditorApi {
    return {
      focus: () => view?.focus(),
      getContent: () => view?.state.doc.toString() ?? "",
      getSelection: () => selectionInfo(),
      replaceRange,
      insertAtCursor: (text) => {
        const selected = selectionInfo();
        replaceRange(selected.from, selected.to, text);
      },
      setSelection,
      scrollToOffset: (offset) => setSelection(offset, offset),
      scrollToLine,
      getScrollAnchor: currentAnchor,
      scrollToAnchor,
      setGhostText: () => undefined,
      clearGhostText: () => undefined,
    };
  }

  const editorTheme = EditorView.theme({
    "&": {
      height: "100%",
      color: "var(--source-ink)",
      backgroundColor: "transparent",
    },
    ".cm-scroller": {
      fontFamily: "var(--source-font)",
      fontSize: "14px",
      lineHeight: "1.7",
      padding: "18px 0 72px",
      overflow: "auto",
    },
    ".cm-content": { padding: "0 26px", caretColor: "var(--accent)" },
    ".cm-line": { padding: "0 2px 0 8px" },
    ".cm-gutters": {
      minWidth: "48px",
      border: "0",
      borderRight: "1px solid var(--rule)",
      backgroundColor: "color-mix(in srgb, var(--paper-deep) 65%, transparent)",
      color: "var(--ink-faint)",
    },
    ".cm-activeLine, .cm-activeLineGutter": {
      backgroundColor: "color-mix(in srgb, var(--accent) 5%, transparent)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "color-mix(in srgb, var(--accent) 20%, transparent)",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
    ".cm-search": {
      border: "0",
      borderBottom: "1px solid var(--rule)",
      backgroundColor: "var(--surface-raised)",
      padding: "7px 10px",
    },
    ".cm-search input": {
      height: "28px",
      border: "1px solid var(--rule)",
      borderRadius: "5px",
      backgroundColor: "var(--paper)",
      color: "var(--ink)",
    },
    ".cm-search button": {
      height: "28px",
      border: "1px solid var(--rule)",
      borderRadius: "5px",
      backgroundColor: "var(--paper)",
      color: "var(--ink-muted)",
    },
    "&.cm-focused": { outline: "none" },
  });

  onMount(() => {
    mounted = true;
    lastValue = value;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        indentUnit.of("  "),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        search({ top: true }),
        EditorView.lineWrapping,
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
        editableCompartment.of(EditorView.editable.of(!readOnly)),
        editorTheme,
        EditorView.domEventHandlers({
          focus: () => {
            onfocuschange?.(true);
            return false;
          },
          blur: () => {
            onfocuschange?.(false);
            return false;
          },
          compositionend: () => {
            queueMicrotask(() => {
              if (!view || !compositionNeedsCommit) return;
              compositionNeedsCommit = false;
              const next = view.state.doc.toString();
              lastValue = next;
              onchange?.(next, { composing: false });
              onactivity?.();
            });
            return false;
          },
          scroll: () => {
            scheduleScrollAnchor();
            return false;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged) notifySelection(update.state);
          if (update.viewportChanged) scheduleScrollAnchor();
          if (!update.docChanged) return;
          const next = update.state.doc.toString();
          lastValue = next;
          const isExternal = update.transactions.some((transaction) =>
            transaction.annotation(externalUpdate),
          );
          if (isExternal) return;
          const composing = update.view.composing;
          onchange?.(next, { composing });
          if (composing) compositionNeedsCommit = true;
          else {
            compositionNeedsCommit = false;
            onactivity?.();
          }
        }),
      ],
    });
    view = new EditorView({ state, parent: host });
    onready?.(api());
    notifySelection(state);
  });

  $effect(() => {
    const externalValue = value;
    if (!mounted || !view || externalValue === lastValue) return;
    const selection = view.state.selection.main;
    const head = Math.min(selection.head, externalValue.length);
    lastValue = externalValue;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: externalValue },
      selection: { anchor: head },
      annotations: [externalUpdate.of(true), Transaction.addToHistory.of(false)],
    });
  });

  $effect(() => {
    const nextReadOnly = readOnly;
    if (!mounted || !view) return;
    view.dispatch({
      effects: [
        readOnlyCompartment.reconfigure(EditorState.readOnly.of(nextReadOnly)),
        editableCompartment.reconfigure(EditorView.editable.of(!nextReadOnly)),
      ],
    });
  });

  onDestroy(() => {
    mounted = false;
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    view?.destroy();
    view = null;
    onready?.(null);
  });
</script>

<div
  class="source-shell"
  style={`--source-font: "${fontFamily.replaceAll('"', '\\"')}", NanumGothicCoding, monospace`}
>
  <header class="source-heading">
    <div>
      <strong>Markdown 원문</strong>
      <span>원고와 실시간 동기화</span>
    </div>
    <kbd>Ctrl F</kbd>
  </header>
  <div class="source-editor" bind:this={host} aria-label="Markdown 원문 편집기"></div>
</div>

<style>
  .source-shell {
    --source-ink: color-mix(in srgb, var(--ink-strong) 94%, #20242a);
    display: grid;
    grid-template-rows: 42px minmax(0, 1fr);
    height: 100%;
    min-width: 0;
    overflow: hidden;
    border-left: 1px solid color-mix(in srgb, var(--rule) 82%, transparent);
    background-color: var(--paper);
    background-image: var(--hanji-texture);
    background-size: 320px 320px;
  }

  .source-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid var(--rule);
    padding: 0 14px 0 16px;
    color: var(--ink-muted);
    font-family: var(--ui-font);
  }

  .source-heading div {
    display: flex;
    min-width: 0;
    align-items: baseline;
    gap: 8px;
  }

  .source-heading strong {
    color: var(--ink-strong);
    font-size: var(--type-control);
  }

  .source-heading span,
  .source-heading kbd {
    color: var(--ink-faint);
    font-size: var(--type-micro);
  }

  .source-heading kbd {
    border: 1px solid var(--rule);
    border-radius: 4px;
    background: var(--paper-deep);
    padding: 2px 5px;
    font-family: var(--ui-font);
  }

  .source-editor {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .source-editor :global(.cm-editor) {
    height: 100%;
  }

  @media print {
    .source-shell {
      display: none;
    }
  }
</style>
