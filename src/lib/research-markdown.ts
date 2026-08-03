import { mergeAttributes, Node, type MarkdownToken } from "@tiptap/core";
import katex from "katex";

type TokenWith<T extends Record<string, unknown>> = MarkdownToken & T;

function renderMath(dom: HTMLElement, value: string, displayMode: boolean): void {
  dom.dataset.math = value;
  dom.setAttribute("aria-label", `수식: ${value}`);
  try {
    katex.render(value, dom, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      output: "htmlAndMathml",
    });
  } catch {
    dom.textContent = value;
  }
}

export const FootnoteReference = Node.create({
  name: "footnoteReference",
  priority: 80,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { id: { default: "note" } };
  },
  parseHTML() {
    return [
      {
        tag: "sup[data-footnote-reference]",
        getAttrs: (element) => ({
          id: (element as HTMLElement).dataset.footnoteReference ?? "note",
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const id = String(node.attrs.id);
    return [
      "sup",
      mergeAttributes(HTMLAttributes, {
        "data-footnote-reference": id,
        title: `각주 ${id}`,
      }),
      id,
    ];
  },
  parseMarkdown(token, helpers) {
    const footnote = token as TokenWith<{ id?: string }>;
    return helpers.createNode("footnoteReference", { id: footnote.id ?? "note" });
  },
  renderMarkdown(node) {
    return `[^${String(node.attrs?.id ?? "note")}]`;
  },
  markdownTokenizer: {
    name: "footnoteReference",
    level: "inline" as const,
    start: (source: string) => source.search(/\[\^[^\]\n]+\]/),
    tokenize(source: string) {
      const match = /^\[\^([^\]\n]+)\]/.exec(source);
      if (!match) return undefined;
      return { type: "footnoteReference", raw: match[0], id: match[1] };
    },
  },
});

export const FootnoteDefinition = Node.create({
  name: "footnoteDefinition",
  priority: 80,
  group: "block",
  content: "inline*",
  defining: true,

  addAttributes() {
    return { id: { default: "note" } };
  },
  parseHTML() {
    return [
      {
        tag: "aside[data-footnote-definition]",
        getAttrs: (element) => ({
          id: (element as HTMLElement).dataset.footnoteDefinition ?? "note",
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const id = String(node.attrs.id);
    return [
      "aside",
      mergeAttributes(HTMLAttributes, { "data-footnote-definition": id }),
      ["sup", {}, id],
      ["span", {}, 0],
    ];
  },
  parseMarkdown(token, helpers) {
    const footnote = token as TokenWith<{
      id?: string;
      tokens?: MarkdownToken[];
    }>;
    return helpers.createNode(
      "footnoteDefinition",
      { id: footnote.id ?? "note" },
      helpers.parseInline(footnote.tokens ?? []),
    );
  },
  renderMarkdown(node, helpers) {
    const id = String(node.attrs?.id ?? "note");
    const content = (node.content ?? [])
      .map((child, index) => helpers.renderChild?.(child, index) ?? "")
      .join("");
    return `[^${id}]: ${content}`;
  },
  markdownTokenizer: {
    name: "footnoteDefinition",
    level: "block" as const,
    start: (source: string) => source.search(/^\[\^[^\]\n]+\]:/m),
    tokenize(source: string, _tokens: MarkdownToken[], lexer) {
      const match = /^\[\^([^\]\n]+)\]:[ \t]*([^\n]*)(?:\n|$)/.exec(source);
      if (!match) return undefined;
      return {
        type: "footnoteDefinition",
        raw: match[0],
        id: match[1],
        text: match[2],
        tokens: lexer.inlineTokens(match[2]),
      };
    },
  },
});

export const InlineMath = Node.create({
  name: "inlineMath",
  priority: 80,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { value: { default: "" } };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-inline-math]",
        getAttrs: (element) => ({
          value: (element as HTMLElement).dataset.inlineMath ?? "",
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-inline-math": String(node.attrs.value),
      }),
      String(node.attrs.value),
    ];
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "inline-math";
      renderMath(dom, String(node.attrs.value), false);
      return { dom };
    };
  },
  parseMarkdown(token, helpers) {
    const math = token as TokenWith<{ value?: string }>;
    return helpers.createNode("inlineMath", { value: math.value ?? "" });
  },
  renderMarkdown(node) {
    return `$${String(node.attrs?.value ?? "")}$`;
  },
  markdownTokenizer: {
    name: "inlineMath",
    level: "inline" as const,
    start: (source: string) => source.search(/\$(?!\$)/),
    tokenize(source: string) {
      const match = /^\$(?!\$)((?:\\.|[^$\n])+?)\$/.exec(source);
      if (!match) return undefined;
      return { type: "inlineMath", raw: match[0], value: match[1] };
    },
  },
});

export const DisplayMath = Node.create({
  name: "displayMath",
  priority: 80,
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return { value: { default: "" } };
  },
  parseHTML() {
    return [
      {
        tag: "div[data-display-math]",
        getAttrs: (element) => ({
          value: (element as HTMLElement).dataset.displayMath ?? "",
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-display-math": String(node.attrs.value),
      }),
      String(node.attrs.value),
    ];
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "display-math";
      renderMath(dom, String(node.attrs.value), true);
      return { dom };
    };
  },
  parseMarkdown(token, helpers) {
    const math = token as TokenWith<{ value?: string }>;
    return helpers.createNode("displayMath", { value: math.value ?? "" });
  },
  renderMarkdown(node) {
    return `$$\n${String(node.attrs?.value ?? "")}\n$$`;
  },
  markdownTokenizer: {
    name: "displayMath",
    level: "block" as const,
    start: (source: string) => source.indexOf("$$"),
    tokenize(source: string) {
      const match = /^\$\$[ \t]*\n?([\s\S]*?)\n?\$\$(?:\n|$)/.exec(source);
      if (!match) return undefined;
      return {
        type: "displayMath",
        raw: match[0],
        value: match[1].trim(),
      };
    },
  },
});

export const ResearchMarkdownExtensions = [
  FootnoteReference,
  FootnoteDefinition,
  InlineMath,
  DisplayMath,
];
