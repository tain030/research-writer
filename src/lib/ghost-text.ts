import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

interface GhostTextState {
  text: string;
  pos: number | null;
  decorations: DecorationSet;
}

const ghostTextMeta = "research-writer:ghost-text";

export const ghostTextKey = new PluginKey<GhostTextState>(
  "research-writer-ghost-text",
);

function emptyGhostText(): GhostTextState {
  return { text: "", pos: null, decorations: DecorationSet.empty };
}

function createGhostText(
  viewDocument: ProseMirrorNode,
  text: string,
  pos: number,
): GhostTextState {
  if (!text) return emptyGhostText();
  const safePosition = Math.max(0, Math.min(pos, viewDocument.content.size));
  const decoration = Decoration.widget(
    safePosition,
    () => {
      const ghost = document.createElement("span");
      const hint = document.createElement("kbd");
      ghost.className = "editor-ghost-text";
      ghost.contentEditable = "false";
      ghost.setAttribute("aria-hidden", "true");
      ghost.append(text);
      hint.textContent = "Tab";
      ghost.append(hint);
      return ghost;
    },
    { side: 100, key: `ghost:${safePosition}:${text}`, ignoreSelection: true },
  );
  return {
    text,
    pos: safePosition,
    decorations: DecorationSet.create(viewDocument, [decoration]),
  };
}

export const GhostText = Extension.create({
  name: "ghostText",

  addProseMirrorPlugins() {
    return [
      new Plugin<GhostTextState>({
        key: ghostTextKey,
        state: {
          init: emptyGhostText,
          apply: (transaction, current) => {
            const next = transaction.getMeta(ghostTextMeta) as
              | { text: string; pos: number }
              | null
              | undefined;
            if (next === null) return emptyGhostText();
            if (next) {
              return createGhostText(transaction.doc, next.text, next.pos);
            }
            if (transaction.docChanged || transaction.selectionSet) {
              return emptyGhostText();
            }
            return current;
          },
        },
        props: {
          decorations: (state) =>
            ghostTextKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
      }),
    ];
  },
});

export function setEditorGhostText(view: EditorView, text: string): void {
  const selection = view.state.selection;
  if (!selection.empty || !text) {
    clearEditorGhostText(view);
    return;
  }
  view.dispatch(
    view.state.tr
      .setMeta(ghostTextMeta, { text, pos: selection.head })
      .setMeta("addToHistory", false),
  );
}

export function clearEditorGhostText(view: EditorView): void {
  if (!ghostTextKey.getState(view.state)?.text) return;
  view.dispatch(
    view.state.tr
      .setMeta(ghostTextMeta, null)
      .setMeta("addToHistory", false),
  );
}

export function editorGhostText(
  view: EditorView,
): { text: string; pos: number } | null {
  const current = ghostTextKey.getState(view.state);
  return current?.text && current.pos !== null
    ? { text: current.text, pos: current.pos }
    : null;
}
