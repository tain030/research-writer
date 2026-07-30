<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    Compartment,
    EditorSelection,
    EditorState,
    type Range,
    StateEffect,
    StateField,
  } from "@codemirror/state";
  import {
    Decoration,
    EditorView,
    ViewPlugin,
    type ViewUpdate,
    WidgetType,
    drawSelection,
    dropCursor,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
    rectangularSelection,
  } from "@codemirror/view";
  import {
    defaultKeymap,
    history,
    historyKeymap,
    indentLess,
    indentMore,
  } from "@codemirror/commands";
  import {
    bracketMatching,
    defaultHighlightStyle,
    foldGutter,
    syntaxHighlighting,
    syntaxTree,
  } from "@codemirror/language";
  import { markdown } from "@codemirror/lang-markdown";
  import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
  import type {
    EditorSelection as SelectionInfo,
    FocusMode,
  } from "./types";
  import { sentenceRange } from "./markdown";

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
    measure?: number;
    focusMode?: FocusMode;
    typewriterMode?: boolean;
    soundEnabled?: boolean;
    onready?: (api: EditorApi | null) => void;
    onchange?: (value: string) => void;
    onselection?: (selection: SelectionInfo) => void;
    onactivity?: () => void;
    onghostaccept?: (text: string) => void;
  }

  let {
    value,
    readOnly = false,
    fontFamily = "Pretendard",
    measure = 68,
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
  let view: EditorView | null = null;
  let ghostText = "";
  let updatingFromOutside = false;
  let scrollScheduled = false;
  const appearance = new Compartment();
  const editability = new Compartment();
  const focus = new Compartment();

  class GhostWidget extends WidgetType {
    text: string;

    constructor(text: string) {
      super();
      this.text = text;
    }

    eq(other: GhostWidget): boolean {
      return other.text === this.text;
    }

    toDOM(): HTMLElement {
      const span = document.createElement("span");
      span.className = "cm-ghost-text";
      span.textContent = this.text;
      span.setAttribute("aria-hidden", "true");
      return span;
    }
  }

  const setGhost = StateEffect.define<{ position: number; text: string }>();
  const clearGhost = StateEffect.define<void>();
  const ghostField = StateField.define({
    create: () => Decoration.none,
    update(decorations, transaction) {
      let next = decorations.map(transaction.changes);
      if (transaction.docChanged || transaction.selection) next = Decoration.none;
      for (const effect of transaction.effects) {
        if (effect.is(setGhost)) {
          next = effect.value.text
            ? Decoration.set([
                Decoration.widget({
                  widget: new GhostWidget(effect.value.text),
                  side: 1,
                }).range(effect.value.position),
              ])
            : Decoration.none;
        }
        if (effect.is(clearGhost)) next = Decoration.none;
      }
      return next;
    },
    provide: (field) => EditorView.decorations.from(field),
  });

  function selectionInfo(current: EditorView): SelectionInfo {
    const range = current.state.selection.main;
    return {
      from: range.from,
      to: range.to,
      text: current.state.sliceDoc(range.from, range.to),
      line: current.state.doc.lineAt(range.head).number,
    };
  }

  function activeBlocks(current: EditorView): Array<[number, number]> {
    return current.state.selection.ranges.map((range) => {
      const doc = current.state.doc;
      let startLine = doc.lineAt(range.from);
      let endLine = doc.lineAt(range.to);
      while (startLine.number > 1) {
        const previous = doc.line(startLine.number - 1);
        if (!previous.text.trim()) break;
        startLine = previous;
      }
      while (endLine.number < doc.lines) {
        const next = doc.line(endLine.number + 1);
        if (!next.text.trim()) break;
        endLine = next;
      }
      return [startLine.from, endLine.to];
    });
  }

  function isActive(
    from: number,
    to: number,
    ranges: Array<[number, number]>,
  ): boolean {
    return ranges.some(([start, end]) => from <= end && to >= start);
  }

  function isFencedCode(current: EditorView, position: number): boolean {
    let node = syntaxTree(current.state).resolveInner(position, 1);
    while (node) {
      if (
        node.name.includes("FencedCode") ||
        node.name.includes("CodeBlock")
      ) {
        return true;
      }
      if (!node.parent) break;
      node = node.parent;
    }
    return false;
  }

  function hybridDecorations(current: EditorView) {
    const decorations: Range<Decoration>[] = [];
    const blocks = activeBlocks(current);
    const seen = new Set<number>();
    for (const visible of current.visibleRanges) {
      let position = visible.from;
      while (position <= visible.to) {
        const line = current.state.doc.lineAt(position);
        if (seen.has(line.number)) {
          position = line.to + 1;
          continue;
        }
        seen.add(line.number);
        const text = line.text;
        const heading = text.match(/^(#{1,6})\s+/);
        if (heading) {
          decorations.push(
            Decoration.line({
              class: `cm-md-heading cm-md-h${heading[1].length}`,
            }).range(line.from),
          );
        } else if (/^\s*>/.test(text)) {
          decorations.push(
            Decoration.line({ class: "cm-md-quote" }).range(line.from),
          );
        } else if (/^\s*(?:[-+*]|\d+\.)\s+/.test(text)) {
          decorations.push(
            Decoration.line({ class: "cm-md-list" }).range(line.from),
          );
        } else if (/^\[\^[^\]]+\]:/.test(text)) {
          decorations.push(
            Decoration.line({ class: "cm-md-footnote" }).range(line.from),
          );
        }

        const active = isActive(line.from, line.to, blocks);
        if (!active && !isFencedCode(current, line.from)) {
          const prefix = text.match(/^(#{1,6}\s+|>\s+)/);
          if (prefix) {
            decorations.push(
              Decoration.replace({}).range(
                line.from,
                line.from + prefix[0].length,
              ),
            );
          }
          for (const marker of text.matchAll(/\*\*|__|~~|`/g)) {
            const start = line.from + (marker.index ?? 0);
            decorations.push(
              Decoration.replace({}).range(start, start + marker[0].length),
            );
          }
          for (const link of text.matchAll(/(!?)\[([^\]]+)\]\(([^)]+)\)/g)) {
            const start = line.from + (link.index ?? 0);
            const labelStart = start + link[1].length + 1;
            const labelEnd = labelStart + link[2].length;
            decorations.push(
              Decoration.replace({}).range(start, labelStart),
              Decoration.mark({ class: "cm-md-link" }).range(
                labelStart,
                labelEnd,
              ),
              Decoration.replace({}).range(
                labelEnd,
                start + link[0].length,
              ),
            );
          }
        }
        if (line.to >= visible.to || line.number >= current.state.doc.lines)
          break;
        position = line.to + 1;
      }
    }
    return Decoration.set(decorations, true);
  }

  const hybridMarkdown = ViewPlugin.fromClass(
    class {
      decorations;

      constructor(current: EditorView) {
        this.decorations = hybridDecorations(current);
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged
        ) {
          this.decorations = hybridDecorations(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );

  function focusExtension(mode: FocusMode) {
    if (mode === "off") return [];
    return ViewPlugin.fromClass(
      class {
        decorations;

        constructor(current: EditorView) {
          this.decorations = focusDecorations(current, mode);
        }

        update(update: ViewUpdate) {
          if (
            update.docChanged ||
            update.selectionSet ||
            update.viewportChanged
          ) {
            this.decorations = focusDecorations(update.view, mode);
          }
        }
      },
      { decorations: (plugin) => plugin.decorations },
    );
  }

  function activeSentences(current: EditorView): Array<[number, number]> {
    const content = current.state.doc.toString();
    return current.state.selection.ranges.map((range) => {
      const sentence = sentenceRange(content, range.from, range.to);
      return [sentence.from, sentence.to];
    });
  }

  function focusDecorations(current: EditorView, mode: FocusMode) {
    const active =
      mode === "sentence" ? activeSentences(current) : activeBlocks(current);
    const decorations: Range<Decoration>[] = [];
    for (const visible of current.visibleRanges) {
      let position = visible.from;
      while (position <= visible.to) {
        const line = current.state.doc.lineAt(position);
        const intervals = active
          .filter(([start, end]) => start <= line.to && end >= line.from)
          .sort(([left], [right]) => left - right);
        if (!intervals.length) {
          decorations.push(
            Decoration.line({ class: "cm-focus-dim" }).range(line.from),
          );
        } else if (mode === "sentence" && line.from < line.to) {
          let cursor = line.from;
          for (const [start, end] of intervals) {
            const visibleStart = Math.max(line.from, start);
            const visibleEnd = Math.min(line.to, end);
            if (cursor < visibleStart) {
              decorations.push(
                Decoration.mark({ class: "cm-focus-dim" }).range(
                  cursor,
                  visibleStart,
                ),
              );
            }
            cursor = Math.max(cursor, visibleEnd);
          }
          if (cursor < line.to) {
            decorations.push(
              Decoration.mark({ class: "cm-focus-dim" }).range(
                cursor,
                line.to,
              ),
            );
          }
        }
        if (line.to >= visible.to || line.number >= current.state.doc.lines)
          break;
        position = line.to + 1;
      }
    }
    return Decoration.set(decorations);
  }

  function appearanceTheme(family: string, lineMeasure: number) {
    const safeMeasure = Math.min(92, Math.max(48, lineMeasure));
    return EditorView.theme({
      "&": {
        height: "100%",
        backgroundColor: "transparent",
        color: "var(--ink)",
      },
      ".cm-scroller": {
        fontFamily: `"${family.replaceAll('"', '\\"')}", MaruBuri, Georgia, serif`,
        fontSize: "var(--editor-size, 19px)",
        lineHeight: "1.92",
        overflow: "auto",
      },
      ".cm-content": {
        width: `${safeMeasure}ch`,
        maxWidth: "calc(100vw - 64px)",
        margin: "0 auto",
        padding: "22vh 0 36vh",
        caretColor: "var(--accent)",
      },
      ".cm-line": { padding: "0" },
      ".cm-cursor": {
        borderLeftColor: "var(--accent)",
        borderLeftWidth: "2px",
      },
      ".cm-selectionBackground, ::selection": {
        backgroundColor: "var(--selection) !important",
      },
      ".cm-gutters": {
        display: "none",
      },
      ".cm-activeLine": {
        backgroundColor: "transparent",
      },
      ".cm-focused": { outline: "none" },
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
      oscillator.frequency.value = 115 + Math.random() * 18;
      gain.gain.setValueAtTime(0.018, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        context.currentTime + 0.025,
      );
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.028);
      oscillator.addEventListener("ended", () => context.close());
    } catch {
      // Sound is deliberately optional.
    }
  }

  function scheduleCenteredScroll(current: EditorView): void {
    if (!typewriterMode || scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(() => {
      scrollScheduled = false;
      if (view !== current) return;
      current.dispatch({
        effects: EditorView.scrollIntoView(current.state.selection.main.head, {
          y: "center",
          yMargin: 0,
        }),
      });
    });
  }

  function acceptGhost(): boolean {
    if (!view || !ghostText) return false;
    const insertion = ghostText;
    const position = view.state.selection.main.head;
    view.dispatch({
      changes: { from: position, insert: insertion },
      selection: EditorSelection.cursor(position + insertion.length),
      effects: clearGhost.of(),
      userEvent: "input.complete",
    });
    ghostText = "";
    onghostaccept?.(insertion);
    return true;
  }

  function clearGhostText(): void {
    ghostText = "";
    view?.dispatch({ effects: clearGhost.of() });
  }

  function createApi(current: EditorView): EditorApi {
    return {
      focus: () => current.focus(),
      getContent: () => current.state.doc.toString(),
      getSelection: () => selectionInfo(current),
      replaceRange: (from, to, text) => {
        current.dispatch({
          changes: { from, to, insert: text },
          selection: EditorSelection.cursor(from + text.length),
          userEvent: "input.ai",
        });
        current.focus();
      },
      insertAtCursor: (text) => {
        const range = current.state.selection.main;
        current.dispatch({
          changes: { from: range.from, to: range.to, insert: text },
          selection: EditorSelection.cursor(range.from + text.length),
          userEvent: "input.insert",
        });
        current.focus();
      },
      setSelection: (from, to) => {
        const start = Math.max(0, Math.min(from, to, current.state.doc.length));
        const end = Math.max(
          0,
          Math.min(Math.max(from, to), current.state.doc.length),
        );
        current.dispatch({
          selection: EditorSelection.range(start, end),
          effects: EditorView.scrollIntoView(end, { y: "center" }),
        });
        current.focus();
      },
      scrollToOffset: (offset) => {
        const safe = Math.max(0, Math.min(offset, current.state.doc.length));
        current.dispatch({
          selection: EditorSelection.cursor(safe),
          effects: EditorView.scrollIntoView(safe, { y: "center" }),
        });
        current.focus();
      },
      scrollToLine: (line) => {
        const safe = Math.max(1, Math.min(line, current.state.doc.lines));
        const position = current.state.doc.line(safe).from;
        current.dispatch({
          selection: EditorSelection.cursor(position),
          effects: EditorView.scrollIntoView(position, { y: "center" }),
        });
        current.focus();
      },
      setGhostText: (text) => {
        ghostText = text;
        current.dispatch({
          effects: setGhost.of({
            position: current.state.selection.main.head,
            text,
          }),
        });
      },
      clearGhostText,
    };
  }

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          bracketMatching(),
          rectangularSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          markdown(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
          ghostField,
          hybridMarkdown,
          appearance.of(appearanceTheme(fontFamily, measure)),
          editability.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          focus.of(focusExtension(focusMode)),
          keymap.of([
            {
              key: "Tab",
              run: () => acceptGhost() || indentMore(view!),
              shift: () => indentLess(view!),
            },
            {
              key: "Escape",
              run: () => {
                if (!ghostText) return false;
                clearGhostText();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              ghostText = "";
              if (!updatingFromOutside) onchange?.(update.state.doc.toString());
              onactivity?.();
              playKeystroke();
            }
            if (update.selectionSet || update.docChanged) {
              onselection?.(selectionInfo(update.view));
              scheduleCenteredScroll(update.view);
            }
          }),
        ],
      }),
    });
    onready?.(createApi(view));
    onselection?.(selectionInfo(view));
  });

  $effect(() => {
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    updatingFromOutside = true;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: EditorSelection.cursor(Math.min(view.state.selection.main.head, value.length)),
    });
    updatingFromOutside = false;
  });

  $effect(() => {
    view?.dispatch({
      effects: appearance.reconfigure(appearanceTheme(fontFamily, measure)),
    });
  });

  $effect(() => {
    view?.dispatch({
      effects: editability.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  });

  $effect(() => {
    view?.dispatch({ effects: focus.reconfigure(focusExtension(focusMode)) });
  });

  onDestroy(() => {
    onready?.(null);
    view?.destroy();
    view = null;
  });
</script>

<div class="editor-host" bind:this={host} aria-label="Markdown 원고 편집기"></div>

<style>
  .editor-host {
    height: 100%;
    min-width: 0;
  }

  :global(.cm-md-heading) {
    font-family: inherit;
    letter-spacing: -0.015em;
    color: var(--ink-strong);
  }

  :global(.cm-md-h1) {
    font-size: 1.72em;
    line-height: 1.35;
    padding-top: 1.5em !important;
    padding-bottom: 0.4em !important;
  }

  :global(.cm-md-h2) {
    font-size: 1.38em;
    line-height: 1.4;
    padding-top: 1.35em !important;
    padding-bottom: 0.28em !important;
  }

  :global(.cm-md-h3) {
    font-size: 1.16em;
    line-height: 1.5;
    padding-top: 1em !important;
  }

  :global(.cm-md-h4),
  :global(.cm-md-h5),
  :global(.cm-md-h6) {
    font-weight: 650;
    padding-top: 0.7em !important;
  }

  :global(.cm-md-quote) {
    color: var(--ink-muted);
    border-left: 2px solid var(--rule);
    padding-left: 1.1em !important;
    font-style: italic;
  }

  :global(.cm-md-list) {
    padding-left: 0.25em !important;
  }

  :global(.cm-md-footnote) {
    color: var(--ink-muted);
    font-size: 0.88em;
  }

  :global(.cm-md-link) {
    color: var(--link);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--link) 35%, transparent);
    text-underline-offset: 0.18em;
  }

  :global(.cm-focus-dim) {
    opacity: 0.22;
    transition: opacity 160ms ease;
  }

  :global(.cm-ghost-text) {
    color: var(--ink-ghost);
    white-space: pre-wrap;
    pointer-events: none;
  }

  :global(.cm-tooltip) {
    font-family: var(--ui-font);
    font-size: var(--type-caption);
    line-height: 1.45;
  }
</style>
