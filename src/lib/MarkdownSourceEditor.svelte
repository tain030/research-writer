<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { EditorApi } from "./Editor.svelte";
  import type { EditorChangeContext, EditorSelection } from "./types";

  interface Props {
    value: string;
    readOnly?: boolean;
    fontFamily?: string;
    onready?: (api: EditorApi | null) => void;
    onchange?: (value: string, context: EditorChangeContext) => void;
    onselection?: (selection: EditorSelection) => void;
    onactivity?: () => void;
  }

  let {
    value,
    readOnly = false,
    fontFamily = "NanumGothicCoding",
    onready,
    onchange,
    onselection,
    onactivity,
  }: Props = $props();

  let input: HTMLTextAreaElement;
  let internalValue = $state("");
  let mounted = false;
  let composing = false;
  let contentRevision = 0;
  let lastSelectionSignature = "";
  let lineStarts = $derived(lineStartOffsets(internalValue));

  function selectionInfo(): EditorSelection {
    const from = input?.selectionStart ?? 0;
    const to = input?.selectionEnd ?? from;
    return {
      from: Math.min(from, to),
      to: Math.max(from, to),
      text: internalValue.slice(Math.min(from, to), Math.max(from, to)),
      line: lineNumberAtOffset(lineStarts, to),
    };
  }

  function notifySelection(): void {
    const signature = `${input?.selectionStart ?? 0}:${input?.selectionEnd ?? 0}:${contentRevision}`;
    if (signature === lastSelectionSignature) return;
    lastSelectionSignature = signature;
    onselection?.(selectionInfo());
  }

  function replaceRange(from: number, to: number, text: string): void {
    if (!input || readOnly) return;
    input.setRangeText(text, from, to, "end");
    internalValue = input.value;
    contentRevision += 1;
    onchange?.(internalValue, { composing: false });
    notifySelection();
    onactivity?.();
    input.focus();
  }

  function setSelection(from: number, to: number): void {
    if (!input) return;
    const safeFrom = Math.max(0, Math.min(from, internalValue.length));
    const safeTo = Math.max(safeFrom, Math.min(to, internalValue.length));
    input.setSelectionRange(safeFrom, safeTo);
    input.focus();
    notifySelection();
  }

  function api(): EditorApi {
    return {
      focus: () => input?.focus(),
      getContent: () => internalValue,
      getSelection: selectionInfo,
      replaceRange,
      insertAtCursor: (text) =>
        replaceRange(input.selectionStart, input.selectionEnd, text),
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
      setGhostText: () => undefined,
      clearGhostText: () => undefined,
    };
  }

  function handleInput(event: Event): void {
    const changed = input.value !== internalValue;
    if (changed) {
      internalValue = input.value;
      contentRevision += 1;
    }
    const isComposing = (event as InputEvent).isComposing || composing;
    if (changed) onchange?.(internalValue, { composing: isComposing });
    notifySelection();
    if (changed && !isComposing) onactivity?.();
  }

  function handleCompositionStart(): void {
    composing = true;
  }

  function handleCompositionEnd(): void {
    composing = false;
    internalValue = input.value;
    onchange?.(internalValue, { composing: false });
    notifySelection();
    onactivity?.();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key !== "Tab" || readOnly) return;
    event.preventDefault();
    if (event.shiftKey) {
      const before = internalValue.slice(
        Math.max(0, input.selectionStart - 2),
        input.selectionStart,
      );
      const spaces = before.match(/ {1,2}$/)?.[0].length ?? 0;
      if (spaces) {
        replaceRange(input.selectionStart - spaces, input.selectionEnd, "");
      }
      return;
    }
    replaceRange(input.selectionStart, input.selectionEnd, "  ");
  }

  onMount(() => {
    mounted = true;
    internalValue = value;
    contentRevision += 1;
    input.value = value;
    onready?.(api());
    notifySelection();
  });

  $effect(() => {
    if (!mounted || value === internalValue) return;
    const offset = Math.min(input.selectionEnd, value.length);
    internalValue = value;
    contentRevision += 1;
    composing = false;
    input.value = value;
    input.setSelectionRange(offset, offset);
    notifySelection();
  });

  onDestroy(() => {
    mounted = false;
    onready?.(null);
  });

  function lineStartOffsets(content: string): number[] {
    const result = [0];
    for (let index = 0; index < content.length; index += 1) {
      if (content[index] === "\n") result.push(index + 1);
    }
    return result;
  }

  function lineNumberAtOffset(starts: number[], offset: number): number {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (starts[middle] <= offset) low = middle + 1;
      else high = middle;
    }
    return Math.max(1, low);
  }
</script>

<div class="source-shell">
  <div class="source-paper">
    <header>
      <span>MARKDOWN SOURCE</span>
      <small>고급 편집 · 원고 파일에 그대로 저장됩니다</small>
    </header>
    <textarea
      bind:this={input}
      readonly={readOnly}
      spellcheck="false"
      aria-label="Markdown 원문 편집기"
      style={`--source-font: "${fontFamily.replaceAll('"', '\\"')}", NanumGothicCoding, monospace`}
      oninput={handleInput}
      oncompositionstart={handleCompositionStart}
      oncompositionend={handleCompositionEnd}
      onselect={notifySelection}
      onkeyup={notifySelection}
      onkeydown={handleKeydown}
    ></textarea>
  </div>
</div>

<style>
  .source-shell {
    height: 100%;
    overflow: auto;
    background: color-mix(in srgb, var(--paper-deep) 88%, #746b61);
    padding: 64px 40px 110px;
  }

  .source-paper {
    width: min(940px, calc(100vw - 96px));
    min-height: calc(100vh - 150px);
    margin: 0 auto;
    border: 1px solid var(--rule);
    border-radius: 3px;
    background: #fffdf7;
    box-shadow: var(--shadow);
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    border-bottom: 1px solid rgba(174, 79, 69, 0.25);
    padding: 16px 22px;
    color: #9a5148;
    font-family: var(--ui-font);
  }

  header span {
    font-size: var(--type-caption);
    font-weight: 760;
    letter-spacing: 0.12em;
  }

  header small {
    color: #8b776c;
    font-size: var(--type-micro);
  }

  textarea {
    display: block;
    width: 100%;
    min-height: calc(100vh - 220px);
    border: 0;
    border-radius: 0;
    background: transparent;
    padding: 28px 34px 80px;
    color: #342d29;
    font-family: var(--source-font);
    font-size: 16px;
    line-height: 1.8;
    resize: none;
    tab-size: 2;
  }

  textarea:focus {
    border: 0;
    box-shadow: none;
    outline: 0;
  }

  @media (max-width: 720px) {
    .source-shell {
      padding-right: 16px;
      padding-left: 16px;
    }

    .source-paper {
      width: 100%;
    }

    header small {
      display: none;
    }

    textarea {
      padding-right: 20px;
      padding-left: 20px;
    }
  }
</style>
