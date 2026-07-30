import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";

interface HastElement {
  type: "element";
  tagName: string;
  properties: Record<string, unknown>;
  children: unknown[];
}

const transparentPixel =
  "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": [
      ...(defaultSchema.attributes?.["*"] ?? []),
      "className",
      "id",
      "ariaHidden",
    ],
    a: [
      ...(defaultSchema.attributes?.a ?? []),
      "target",
      "rel",
    ],
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      "className",
      "dataAssetPath",
    ],
  },
};

export function renderManuscriptHtml(
  markdown: string,
  assetUrls: Record<string, string> = {},
): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype)
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeKatex)
    .use(() => (tree) => {
      visit(tree, "element", (node: HastElement) => {
        if (node.tagName === "a") {
          node.properties.rel = ["noreferrer", "noopener"];
          return;
        }
        if (node.tagName !== "img") return;
        const source = String(node.properties.src ?? "");
        if (assetUrls[source]) {
          node.properties.src = assetUrls[source];
          node.properties.dataAssetPath = source;
          return;
        }
        if (/^data:image\//i.test(source)) return;
        node.properties.src = transparentPixel;
        node.properties.className = [
          ...asClassNames(node.properties.className),
          /^https?:\/\//i.test(source) ? "remote-image" : "missing-image",
        ];
        node.properties.dataAssetPath = source;
      });
    })
    .use(rehypeStringify);
  return String(processor.processSync(markdown));
}

function asClassNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value) return [value];
  return [];
}

