import rehypeKatex from "rehype-katex";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

const aiMarkdown = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype)
  // Raw HTML is not passed through by remark-rehype. Sanitize the remaining
  // Markdown-generated tree before KaTeX adds its trusted presentation markup.
  .use(rehypeSanitize)
  .use(rehypeKatex, { strict: "ignore" })
  .use(rehypeStringify);

export function renderAiMarkdown(markdown: string): string {
  return String(aiMarkdown.processSync(markdown));
}
