import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

const inkFeedbackKey = new PluginKey<DecorationSet>("research-writer-ink-feedback");
const timers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>();

function cancelInkTimer(view: EditorView): void {
  const timer = timers.get(view);
  if (!timer) return;
  clearTimeout(timer);
  timers.delete(view);
}

type InkFeedbackMeta =
  | {
      type: "show";
      from: number;
      to: number;
      feedback: "literary" | "typewriter";
    }
  | { type: "clear" };

export const InkFeedback = Extension.create({
  name: "inkFeedback",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: inkFeedbackKey,
        state: {
          init: () => DecorationSet.empty,
          apply(transaction, decorations) {
            const mapped = decorations.map(transaction.mapping, transaction.doc);
            const meta = transaction.getMeta(inkFeedbackKey) as
              | InkFeedbackMeta
              | undefined;
            if (!meta) return mapped;
            if (meta.type === "clear") return DecorationSet.empty;
            const from = Math.max(0, Math.min(meta.from, transaction.doc.content.size));
            const to = Math.max(from, Math.min(meta.to, transaction.doc.content.size));
            if (to <= from) return DecorationSet.empty;
            return DecorationSet.create(transaction.doc, [
              Decoration.inline(from, to, {
                class:
                  meta.feedback === "typewriter"
                    ? "is-typewriter-imprint"
                    : "is-settling-ink",
              }),
            ]);
          },
        },
        props: {
          decorations: (state) => inkFeedbackKey.getState(state),
          handleDOMEvents: {
            beforeinput(view) {
              clearEditorInk(view);
              return false;
            },
            compositionstart(view) {
              clearEditorInk(view);
              return false;
            },
            keydown(view) {
              clearEditorInk(view);
              return false;
            },
            mousedown(view) {
              clearEditorInk(view);
              return false;
            },
            pointerdown(view) {
              clearEditorInk(view);
              return false;
            },
          },
        },
        view: (view) => ({
          destroy: () => cancelInkTimer(view),
        }),
      }),
    ];
  },
});

/**
 * Remove transient inline markup before the browser measures the next input or
 * pointer position. Leaving the imprint span in the DOM can make native input
 * resolve against a stale child offset even though the ProseMirror selection is
 * already after the decorated character.
 */
export function clearEditorInk(view: EditorView): void {
  cancelInkTimer(view);
  if (view.isDestroyed || !inkFeedbackKey.getState(view.state)?.find().length) {
    return;
  }
  view.dispatch(
    view.state.tr
      .setMeta(inkFeedbackKey, { type: "clear" })
      .setMeta("addToHistory", false),
  );
}

export function flashEditorInk(
  view: EditorView,
  from: number,
  to: number,
  feedback: "literary" | "typewriter" = "literary",
): void {
  cancelInkTimer(view);
  view.dispatch(
    view.state.tr
      .setMeta(inkFeedbackKey, {
        type: "show",
        from,
        to,
        feedback,
      })
      .setMeta("addToHistory", false),
  );
  const timer = setTimeout(() => {
    clearEditorInk(view);
  }, feedback === "typewriter" ? 140 : 240);
  timers.set(view, timer);
}

export function flashInsertedEditorInk(
  view: EditorView,
  insertedText: string,
  feedback: "literary" | "typewriter" = "literary",
): boolean {
  if (
    !insertedText ||
    /[\r\n]/u.test(insertedText) ||
    !view.state.selection.empty
  ) {
    return false;
  }

  const insertionEnd = view.state.selection.head;
  const insertionStart = insertionEnd - insertedText.length;
  if (
    insertionStart < 0 ||
    view.state.doc.textBetween(
      insertionStart,
      insertionEnd,
      undefined,
      "\ufffc",
    ) !== insertedText
  ) {
    return false;
  }

  const leadingWhitespace = insertedText.match(/^\s*/u)?.[0].length ?? 0;
  const trailingWhitespace = insertedText.match(/\s*$/u)?.[0].length ?? 0;
  const from = insertionStart + leadingWhitespace;
  const to = insertionEnd - trailingWhitespace;
  if (to <= from) return false;

  flashEditorInk(view, from, to, feedback);
  return true;
}
