import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

interface AiSelectionState {
  from: number | null;
  to: number | null;
  decorations: DecorationSet;
}

const aiSelectionMeta = "research-writer:ai-selection";

export const aiSelectionKey = new PluginKey<AiSelectionState>(
  "research-writer-ai-selection",
);

function emptyAiSelection(): AiSelectionState {
  return { from: null, to: null, decorations: DecorationSet.empty };
}

function createAiSelection(
  viewDocument: ProseMirrorNode,
  from: number,
  to: number,
): AiSelectionState {
  const safeFrom = Math.max(0, Math.min(from, viewDocument.content.size));
  const safeTo = Math.max(safeFrom, Math.min(to, viewDocument.content.size));
  if (safeFrom === safeTo) return emptyAiSelection();
  return {
    from: safeFrom,
    to: safeTo,
    decorations: DecorationSet.create(viewDocument, [
      Decoration.inline(safeFrom, safeTo, {
        class: "is-ai-context-selection",
        "data-ai-context": "selection",
      }),
    ]),
  };
}

export const AiSelection = Extension.create({
  name: "aiSelection",

  addProseMirrorPlugins() {
    return [
      new Plugin<AiSelectionState>({
        key: aiSelectionKey,
        state: {
          init: emptyAiSelection,
          apply: (transaction, current) => {
            const next = transaction.getMeta(aiSelectionMeta) as
              | { from: number; to: number }
              | null
              | undefined;
            if (next === null) return emptyAiSelection();
            if (next) {
              return createAiSelection(transaction.doc, next.from, next.to);
            }
            if (
              transaction.docChanged &&
              current.from !== null &&
              current.to !== null
            ) {
              return createAiSelection(
                transaction.doc,
                transaction.mapping.map(current.from, -1),
                transaction.mapping.map(current.to, 1),
              );
            }
            return current;
          },
        },
        props: {
          decorations: (state) =>
            aiSelectionKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
      }),
    ];
  },
});

export function setEditorAiSelection(
  view: EditorView,
  from: number,
  to: number,
): void {
  view.dispatch(
    view.state.tr
      .setMeta(aiSelectionMeta, { from, to })
      .setMeta("addToHistory", false),
  );
}

export function clearEditorAiSelection(view: EditorView): void {
  const current = aiSelectionKey.getState(view.state);
  if (current?.from === null) return;
  view.dispatch(
    view.state.tr
      .setMeta(aiSelectionMeta, null)
      .setMeta("addToHistory", false),
  );
}
