import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

const protectedBlockInputPattern = /^(?:\d+\.\s|\s*[-+*]\s|\s*>\s|```(?:[a-z]+)?[\s\n]|~~~(?:[a-z]+)?[\s\n]|---|—-|___\s|\*\*\*\s|\s*\[(?: |x|X)?\]\s)$/u;
const protectedEnterPattern = /^(?:\d+\.\s|\s*[-+*]\s|\s*>\s|#{1,6}\s|```(?:[a-z]+)?[\s\n]|~~~(?:[a-z]+)?[\s\n]|---|—-|___\s|\*\*\*\s|\s*\[(?: |x|X)?\]\s)$/u;
const hangulPattern = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;
const POST_COMPOSITION_ENTER_WINDOW_MS = 500;

function headingTextBeforeCursor(
  view: EditorView,
  position: number,
): string | null {
  const resolved = view.state.doc.resolve(position);
  if (resolved.parent.type.name !== "heading") return null;
  return resolved.parent.textBetween(0, resolved.parentOffset, undefined, "\ufffc");
}

function isCompositionInputRuleTransaction(
  transaction: Transaction,
  state: EditorState,
): boolean {
  return state.plugins.some((plugin) => {
    const meta = transaction.getMeta(plugin) as
      | { transform?: unknown; text?: unknown }
      | undefined;
    return meta?.transform === transaction && meta.text === "";
  });
}

export const HeadingInputGuard = Extension.create({
  name: "headingInputGuard",
  priority: 1000,

  addProseMirrorPlugins() {
    const editor = this.editor;
    let lastHeadingCompositionEnd = -Infinity;
    return [
      new Plugin({
        filterTransaction(transaction, state) {
          if (!isCompositionInputRuleTransaction(transaction, state)) {
            return true;
          }

          const before = state.selection.$from;
          if (before.parent.type.name !== "heading") return true;

          const after = transaction.selection.$from;
          return (
            after.parent.type.name === "heading" &&
            after.depth === before.depth &&
            after.before(after.depth) === before.before(before.depth)
          );
        },
        props: {
          handleTextInput(view, from, to, text) {
            const before = headingTextBeforeCursor(view, from);
            const start = view.state.doc.resolve(from);
            const end = view.state.doc.resolve(to);
            if (before === null || !start.sameParent(end)) {
              return false;
            }

            if (!protectedBlockInputPattern.test(before + text)) return false;

            view.dispatch(view.state.tr.insertText(text, from, to));
            return true;
          },
          handleKeyDown(view, event) {
            if (event.key !== "Enter" || !view.state.selection.empty) {
              return false;
            }
            const before = headingTextBeforeCursor(
              view,
              view.state.selection.from,
            );
            if (
              before === null ||
              !protectedEnterPattern.test(`${before}\n`)
            ) {
              return false;
            }
            return editor.commands.splitBlock();
          },
          handleDOMEvents: {
            compositionend(view, event) {
              const parent = view.state.selection.$from.parent;
              const inKoreanHeading =
                parent.type.name === "heading" &&
                (hangulPattern.test(event.data) ||
                  hangulPattern.test(parent.textContent));
              lastHeadingCompositionEnd =
                inKoreanHeading ? Date.now() : -Infinity;
              return false;
            },
            keydown(view, event) {
              if (
                event.key !== "Enter" ||
                event.shiftKey ||
                event.metaKey ||
                event.ctrlKey ||
                event.altKey ||
                event.isComposing ||
                view.composing ||
                !view.state.selection.empty ||
                view.state.selection.$from.parent.type.name !== "heading" ||
                Date.now() - lastHeadingCompositionEnd >
                  POST_COMPOSITION_ENTER_WINDOW_MS
              ) {
                if (event.key.length === 1) {
                  lastHeadingCompositionEnd = -Infinity;
                }
                return false;
              }

              lastHeadingCompositionEnd = -Infinity;
              const handled = Boolean(
                view.someProp("handleKeyDown", (handler) =>
                  handler(view, event),
                ),
              ) || editor.commands.splitBlock();
              if (handled) event.preventDefault();
              return handled;
            },
          },
        },
      }),
    ];
  },
});
