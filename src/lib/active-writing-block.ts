import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const ActiveWritingBlock = Extension.create({
  name: "activeWritingBlock",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const resolved = state.selection.$from;
            for (let depth = resolved.depth; depth > 0; depth -= 1) {
              const node = resolved.node(depth);
              if (!node.isTextblock) continue;
              const from = resolved.before(depth);
              const to = resolved.after(depth);
              return DecorationSet.create(state.doc, [
                Decoration.node(from, to, {
                  class: "is-active-writing-block",
                }),
              ]);
            }
            return DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
