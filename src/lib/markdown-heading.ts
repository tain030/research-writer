import { textblockTypeInputRule } from "@tiptap/core";
import Heading from "@tiptap/extension-heading";

export const MarkdownHeading = Heading.extend({
  addInputRules() {
    return [
      textblockTypeInputRule({
        find: /^(#{1,6})\s$/u,
        type: this.type,
        getAttributes: (match) => ({
          level: (match[1] ?? "#").length,
        }),
      }),
    ];
  },
  renderMarkdown(node, helpers) {
    const rawLevel = Number(node.attrs?.level ?? 1);
    const level = Number.isFinite(rawLevel)
      ? Math.max(1, Math.min(6, Math.trunc(rawLevel)))
      : 1;
    const content = node.content
      ? helpers.renderChildren(node.content)
      : "";
    return `${"#".repeat(level)} ${content}`;
  },
});
