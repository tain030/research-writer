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
    StateEffect,
    StateField,
    Transaction,
  } from "@codemirror/state";
  import {
    Decoration,
    drawSelection,
    dropCursor,
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
    WidgetType,
    type DecorationSet,
  } from "@codemirror/view";
  import {
    writingActivity,
    writingInputFromBeforeInput,
    writingInputFromKeydown,
    type PendingWritingInput,
  } from "./writing-activity";
  import type {
    EditorApi,
    EditorChangeContext,
    EditorSelection,
    ScrollAnchor,
    WritingActivity,
  } from "./types";

  interface Props {
    value: string;
    readOnly?: boolean;
    fontFamily?: string;
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
    fontFamily = "Goorm Sans Code",
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
  let compositionBefore: string | null = null;
  let pendingInput: PendingWritingInput | null = null;
  const externalUpdate = Annotation.define<boolean>();
  const setSourceGhost = StateEffect.define<{ pos: number; text: string }>();
  const clearSourceGhost = StateEffect.define<null>();
  const readOnlyCompartment = new Compartment();
  const editableCompartment = new Compartment();

  interface SourceGhostState {
    pos: number | null;
    text: string;
    decorations: DecorationSet;
  }

  class SourceGhostWidget extends WidgetType {
    readonly text: string;

    constructor(text: string) {
      super();
      this.text = text;
    }

    eq(other: SourceGhostWidget): boolean {
      return other.text === this.text;
    }

    toDOM(): HTMLElement {
      const ghost = document.createElement("span");
      const hint = document.createElement("kbd");
      ghost.className = "cm-ghost-text";
      ghost.setAttribute("aria-hidden", "true");
      ghost.append(this.text);
      hint.textContent = "Tab";
      ghost.append(hint);
      return ghost;
    }

    ignoreEvent(): boolean {
      return true;
    }
  }

  function emptySourceGhost(): SourceGhostState {
    return { pos: null, text: "", decorations: Decoration.none };
  }

  const sourceGhostField = StateField.define<SourceGhostState>({
    create: emptySourceGhost,
    update(current, transaction) {
      let next =
        transaction.docChanged || transaction.selection
          ? emptySourceGhost()
          : current;
      for (const effect of transaction.effects) {
        if (effect.is(clearSourceGhost)) next = emptySourceGhost();
        if (effect.is(setSourceGhost)) {
          const pos = Math.max(0, Math.min(effect.value.pos, transaction.newDoc.length));
          const text = effect.value.text;
          next = text
            ? {
                pos,
                text,
                decorations: Decoration.set([
                  Decoration.widget({
                    widget: new SourceGhostWidget(text),
                    side: 100,
                  }).range(pos),
                ]),
              }
            : emptySourceGhost();
        }
      }
      return next;
    },
    provide: (field) =>
      EditorView.decorations.from(field, (value) => value.decorations),
  });

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
    pendingInput = { kind: "other", origin: "programmatic" };
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

  function clearGhostText(): void {
    if (!view || !view.state.field(sourceGhostField).text) return;
    view.dispatch({ effects: clearSourceGhost.of(null) });
  }

  function setGhostText(text: string): void {
    if (!view) return;
    const selection = view.state.selection.main;
    if (!selection.empty || !text) {
      clearGhostText();
      return;
    }
    view.dispatch({
      effects: setSourceGhost.of({ pos: selection.head, text }),
    });
  }

  function acceptGhostText(target: EditorView): boolean {
    const ghost = target.state.field(sourceGhostField);
    if (!ghost.text || ghost.pos === null) return false;
    pendingInput = { kind: "other", origin: "autocomplete" };
    target.dispatch({
      changes: { from: ghost.pos, insert: ghost.text },
      selection: { anchor: ghost.pos + ghost.text.length },
      effects: clearSourceGhost.of(null),
      scrollIntoView: true,
    });
    return true;
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
      setGhostText,
      clearGhostText,
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
    ".cm-ghost-text": {
      color: "var(--ink-ghost)",
      opacity: "0.78",
      whiteSpace: "pre-wrap",
      pointerEvents: "none",
    },
    ".cm-ghost-text kbd": {
      marginLeft: "0.55em",
      border: "1px solid var(--rule)",
      borderRadius: "3px",
      backgroundColor: "var(--paper-raised)",
      padding: "1px 4px",
      color: "var(--ink-faint)",
      fontFamily: "var(--ui-font)",
      fontSize: "10px",
    },
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
        sourceGhostField,
        keymap.of([
          { key: "Tab", run: acceptGhostText },
          {
            key: "Escape",
            run: () => {
              if (!view?.state.field(sourceGhostField).text) return false;
              clearGhostText();
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
        editableCompartment.of(EditorView.editable.of(!readOnly)),
        editorTheme,
        EditorView.domEventHandlers({
          focus: () => {
            onfocuschange?.(true);
            return false;
          },
          blur: () => {
            pendingInput = null;
            onfocuschange?.(false);
            return false;
          },
          compositionstart: () => {
            compositionBefore = view?.state.doc.toString() ?? lastValue;
            return false;
          },
          compositionend: () => {
            queueMicrotask(() => {
              if (!view || compositionBefore === null) return;
              const before = compositionBefore;
              compositionBefore = null;
              const next = view.state.doc.toString();
              lastValue = next;
              onchange?.(next, { composing: false });
              onactivity?.(
                writingActivity(
                  before,
                  next,
                  "source",
                  pendingInput ?? { kind: "character", origin: "keyboard" },
                ),
              );
              pendingInput = null;
            });
            return false;
          },
          beforeinput: (event) => {
            pendingInput = writingInputFromBeforeInput(event as InputEvent);
            if (pendingInput?.kind === "enter" && view) {
              const head = view.state.selection.main.head;
              pendingInput.paragraphHadContent = Boolean(
                view.state.doc.lineAt(head).text.trim(),
              );
            }
            return false;
          },
          keydown: (event) => {
            const keyboardInput = writingInputFromKeydown(event);
            if (!keyboardInput) return false;
            pendingInput = keyboardInput;
            if (keyboardInput.kind === "enter" && view) {
              const head = view.state.selection.main.head;
              pendingInput.paragraphHadContent = Boolean(
                view.state.doc.lineAt(head).text.trim(),
              );
            }
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
          if (!composing && compositionBefore === null) {
            onactivity?.(
              writingActivity(
                update.startState.doc.toString(),
                next,
                "source",
                pendingInput,
              ),
            );
            pendingInput = null;
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
  style={`--source-font: "${fontFamily.replaceAll('"', '\\"')}", "Goorm Sans Code", NanumGothicCoding, monospace`}
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
