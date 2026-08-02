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
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

interface HastParent {
  children: unknown[];
}

export interface RenderManuscriptOptions {
  hiddenRanges?: Array<{ from: number; to: number }>;
}

const transparentPixel =
  "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

const sanitizeSchema = {
  ...defaultSchema,
  clobberPrefix: "",
  attributes: {
    ...defaultSchema.attributes,
    "*": [
      ...(defaultSchema.attributes?.["*"] ?? []),
      "className",
      "id",
      "ariaHidden",
      "dataSourceFrom",
      "dataSourceTo",
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
  options: RenderManuscriptOptions = {},
): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkGfm)
    .use(remarkMath)
    .use(() => (tree) => {
      const root = tree as unknown as {
        children?: Array<{ position?: HastElement["position"] }>;
      };
      if (!options.hiddenRanges?.length || !root.children) return;
      root.children = root.children.filter((node) => {
        const from = node.position?.start?.offset;
        const to = node.position?.end?.offset;
        return !options.hiddenRanges?.some(
          (range) => from === range.from && to === range.to,
        );
      });
    })
    .use(remarkRehype, { footnoteLabel: "각주" })
    .use(() => (tree) => {
      visit(tree, "element", (node: HastElement) => {
        const from = node.position?.start?.offset;
        const to = node.position?.end?.offset;
        if (typeof from === "number") node.properties.dataSourceFrom = from;
        if (typeof to === "number") node.properties.dataSourceTo = to;
      });
    })
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeKatex)
    .use(() => (tree) => {
      visit(
        tree,
        "element",
        (node: HastElement, index: number | undefined, parent: HastParent | undefined) => {
        if (node.tagName === "a") {
          node.properties.rel = ["noreferrer", "noopener"];
          return;
        }
        if (
          node.tagName === "p" &&
          node.children.length === 1 &&
          isHastElement(node.children[0]) &&
          node.children[0].tagName === "img" &&
          parent &&
          typeof index === "number"
        ) {
          const image = node.children[0];
          const caption = String(image.properties.title ?? image.properties.alt ?? "").trim();
          parent.children[index] = {
            ...node,
            tagName: "figure",
            properties: {
              ...node.properties,
              className: ["manuscript-figure"],
            },
            children: [
              image,
              ...(caption
                ? [
                    {
                      type: "element",
                      tagName: "figcaption",
                      properties: {},
                      children: [{ type: "text", value: caption }],
                    },
                  ]
                : []),
            ],
          };
          secureImage(image, assetUrls);
          return;
        }
        if (node.tagName !== "img") return;
        secureImage(node, assetUrls);
      },
      );
    })
    .use(rehypeStringify);
  return String(processor.processSync(markdown));
}

function isHastElement(value: unknown): value is HastElement {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { type?: unknown }).type === "element",
  );
}

function secureImage(
  node: HastElement,
  assetUrls: Record<string, string>,
): void {
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
}

function asClassNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value) return [value];
  return [];
}
