import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const sentenceFocusKey = new PluginKey<DecorationSet>(
  "research-writer-sentence-focus",
);

function sentenceDecorations(state: EditorState): DecorationSet {
  const selection = state.selection;
  const parent = selection.$from.parent;
  if (!parent.isTextblock || parent.content.size === 0) return DecorationSet.empty;
  const text = parent.textContent;
  const cursor = Math.max(0, Math.min(selection.$from.parentOffset, text.length));
  const boundaries = /[.!?。！？]\s*/gu;
  let from = 0;
  let to = text.length;
  for (const match of text.matchAll(boundaries)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end <= cursor) from = end;
    else {
      to = end;
      break;
    }
  }
  while (from < to && /\s/u.test(text[from] ?? "")) from += 1;
  while (to > from && /\s/u.test(text[to - 1] ?? "")) to -= 1;
  if (from === to) return DecorationSet.empty;
  const parentStart = selection.$from.start();
  return DecorationSet.create(state.doc, [
    Decoration.inline(parentStart + from, parentStart + to, {
      class: "is-active-writing-sentence",
    }),
  ]);
}

export const FocusSentence = Extension.create({
  name: "focusSentence",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: sentenceFocusKey,
        state: {
          init: (_, state) => sentenceDecorations(state),
          apply: (transaction, current, _oldState, newState) =>
            transaction.docChanged || transaction.selectionSet
              ? sentenceDecorations(newState)
              : current,
        },
        props: {
          decorations: (state) =>
            sentenceFocusKey.getState(state) ?? DecorationSet.empty,
        },
      }),
    ];
  },
});
