import { unified } from "unified";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { parseDocument as parseYamlDocument } from "yaml";

export type ManuscriptTextStyle =
  | "normal"
  | "title"
  | "subtitle"
  | "metadata"
  | "heading"
  | "strong"
  | "emphasis"
  | "link"
  | "code"
  | "quote"
  | "footnote";

export type ManuscriptBlockKind =
  | "paragraph"
  | "heading"
  | "quote"
  | "list-item"
  | "figure"
  | "table"
  | "math"
  | "code"
  | "footnote"
  | "divider"
  | "unsupported";

export type DiagnosticSeverity = "error" | "warning" | "suggestion";
export type DiagnosticCategory =
  | "manuscript"
  | "punctuation"
  | "spacing"
  | "structure"
  | "metadata"
  | "markdown"
  | "grammar";

export interface ManuscriptMetadata {
  title: string;
  subtitle: string;
  author: string;
  affiliation: string;
  genre: string;
  schema: number;
  layout: "traditional-ko";
}

export interface SourceRange {
  from: number;
  to: number;
}

export interface QuickFix extends SourceRange {
  label: string;
  replacement: string;
  expected: string;
  safe: boolean;
}

export interface WritingDiagnostic extends SourceRange {
  id: string;
  ruleId: string;
  severity: DiagnosticSeverity;
  category: DiagnosticCategory;
  title: string;
  message: string;
  example?: string;
  source: "국립국어원 규범" | "일반 원고지 관행" | "편집기 안내" | "AI";
  fix?: QuickFix;
}

export interface ManuscriptInline extends SourceRange {
  text: string;
  style: ManuscriptTextStyle;
  atomic?: boolean;
}

export interface ManuscriptBlock extends SourceRange {
  id: string;
  kind: ManuscriptBlockKind;
  label: string;
  detail: string;
  inlines: ManuscriptInline[];
  indent: number;
  continuationIndent: number;
  marker?: string;
}

export interface MetadataSource {
  kind: "frontmatter" | "heading" | "filename";
  range: SourceRange;
}

export interface ParsedManuscript {
  metadata: ManuscriptMetadata;
  metadataSource: MetadataSource;
  frontmatterRange: SourceRange | null;
  titleHeadingRange: SourceRange | null;
  titleTextRange: SourceRange | null;
  bodyStart: number;
  blocks: ManuscriptBlock[];
  diagnostics: WritingDiagnostic[];
  imagePaths: string[];
  previewMarkdown: string;
}

interface Point {
  offset?: number;
}

interface Position {
  start: Point;
  end: Point;
}

interface MdNode {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  identifier?: string;
  label?: string;
  url?: string;
  alt?: string;
  title?: string | null;
  checked?: boolean | null;
  position?: Position;
  children?: MdNode[];
}

const parser = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkGfm)
  .use(remarkMath);

const defaultMetadata: ManuscriptMetadata = {
  title: "",
  subtitle: "",
  author: "",
  affiliation: "",
  genre: "",
  schema: 1,
  layout: "traditional-ko",
};

const blockKinds = new Set<ManuscriptBlockKind>([
  "figure",
  "table",
  "math",
  "code",
  "footnote",
  "divider",
  "unsupported",
]);

export function parseManuscript(
  content: string,
  fallbackTitle = "제목 없는 원고",
): ParsedManuscript {
  const tree = parser.parse(content) as MdNode;
  const rootChildren = tree.children ?? [];
  const yamlNode = rootChildren.find((node) => node.type === "yaml");
  const diagnostics: WritingDiagnostic[] = [];
  const frontmatterRange = yamlNode ? nodeRange(yamlNode) : null;
  const frontmatter = readFrontmatter(yamlNode, diagnostics);
  const firstContentNode = rootChildren.find((node) => node.type !== "yaml");
  const firstHeading =
    firstContentNode?.type === "heading" && firstContentNode.depth === 1
      ? firstContentNode
      : undefined;
  const headingTitle = firstHeading ? nodePlainText(firstHeading).trim() : "";
  const explicitTitle = scalar(frontmatter.title);
  const title = explicitTitle || headingTitle || fallbackTitle;
  const titleHeadingIsDocumentTitle =
    Boolean(firstHeading) &&
    (!explicitTitle || normalizeTitle(headingTitle) === normalizeTitle(explicitTitle));
  const titleHeadingRange =
    firstHeading && titleHeadingIsDocumentTitle ? nodeRange(firstHeading) : null;
  const titleTextNode =
    firstHeading && titleHeadingIsDocumentTitle
      ? firstTextDescendant(firstHeading)
      : null;
  const titleTextRange = titleTextNode ? nodeRange(titleTextNode) : null;
  const metadataSource: MetadataSource = explicitTitle
    ? {
        kind: "frontmatter",
        range: frontmatterRange ?? { from: 0, to: 0 },
      }
    : titleHeadingRange
      ? { kind: "heading", range: titleHeadingRange }
      : {
          kind: "filename",
          range: {
            from:
              frontmatterRange?.to ??
              firstContentOffset(rootChildren, content.length),
            to:
              frontmatterRange?.to ??
              firstContentOffset(rootChildren, content.length),
          },
        };

  const metadata: ManuscriptMetadata = {
    title,
    subtitle: scalar(frontmatter.subtitle),
    author: scalar(frontmatter.author),
    affiliation: scalar(frontmatter.affiliation),
    genre: scalar(frontmatter.genre),
    schema: numeric(frontmatter.research_writer?.schema, 1),
    layout: "traditional-ko",
  };

  const blocks: ManuscriptBlock[] = [];
  const imagePaths: string[] = [];
  for (const node of rootChildren) {
    if (node === yamlNode || (node === firstHeading && titleHeadingIsDocumentTitle)) {
      continue;
    }
    appendBlockNode(node, content, blocks, imagePaths, {
      quoteDepth: 0,
      listDepth: 0,
    });
  }

  collectEmbeddedResources(tree, imagePaths, diagnostics);
  analyzeBlocks(content, blocks, diagnostics);
  analyzeMetadata(metadata, metadataSource, diagnostics);
  const firstBlock = blocks[0];
  const bodyStart =
    firstBlock?.from ??
    titleHeadingRange?.to ??
    frontmatterRange?.to ??
    content.length;
  const hiddenRanges = [frontmatterRange, titleHeadingRange].filter(
    (range): range is SourceRange => range !== null,
  );

  return {
    metadata,
    metadataSource,
    frontmatterRange,
    titleHeadingRange,
    titleTextRange,
    bodyStart,
    blocks,
    diagnostics: deduplicateDiagnostics(diagnostics),
    imagePaths: Array.from(new Set(imagePaths)),
    previewMarkdown: removeRanges(content, hiddenRanges),
  };
}

export function updateManuscriptMetadata(
  content: string,
  metadata: ManuscriptMetadata,
  fallbackTitle = "제목 없는 원고",
): string {
  const parsed = parseManuscript(content, fallbackTitle);
  let nextContent = content;

  if (
    parsed.metadataSource.kind === "heading" &&
    parsed.titleTextRange &&
    metadata.title.trim()
  ) {
    const { from, to } = parsed.titleTextRange;
    nextContent =
      nextContent.slice(0, from) + metadata.title.trim() + nextContent.slice(to);
  }

  const reparsed = parseManuscript(nextContent, fallbackTitle);
  const existingRange = reparsed.frontmatterRange;
  const existingBody = existingRange
    ? nextContent.slice(existingRange.from + 4, Math.max(existingRange.from + 4, existingRange.to - 4))
    : "";
  const yaml = parseYamlDocument(existingBody);
  yaml.set("title", metadata.title.trim());
  yaml.set("subtitle", metadata.subtitle.trim());
  yaml.set("author", metadata.author.trim());
  yaml.set("affiliation", metadata.affiliation.trim());
  yaml.set("genre", metadata.genre.trim());
  yaml.setIn(["research_writer", "schema"], 1);
  yaml.setIn(["research_writer", "layout"], "traditional-ko");
  const rendered = yaml.toString({ lineWidth: 0 }).trimEnd();
  const frontmatter = `---\n${rendered}\n---`;

  if (existingRange) {
    return (
      nextContent.slice(0, existingRange.from) +
      frontmatter +
      nextContent.slice(existingRange.to)
    );
  }

  const separator = nextContent.length > 0 ? "\n\n" : "\n";
  return `${frontmatter}${separator}${nextContent}`;
}

export function applyQuickFixes(
  content: string,
  diagnostics: WritingDiagnostic[],
  safeOnly = true,
): string {
  const fixes = diagnostics
    .flatMap((diagnostic) => (diagnostic.fix ? [diagnostic.fix] : []))
    .filter((fix) => !safeOnly || fix.safe)
    .sort((left, right) => right.from - left.from || right.to - left.to);
  let next = content;
  let lastFrom = Number.POSITIVE_INFINITY;
  for (const fix of fixes) {
    if (fix.to > lastFrom) continue;
    if (next.slice(fix.from, fix.to) !== fix.expected) continue;
    next = next.slice(0, fix.from) + fix.replacement + next.slice(fix.to);
    lastFrom = fix.from;
  }
  return next;
}

export function blockAtOffset(
  blocks: ManuscriptBlock[],
  offset: number,
): ManuscriptBlock | null {
  return (
    blocks.find(
      (block) =>
        blockKinds.has(block.kind) && offset >= block.from && offset <= block.to,
    ) ?? null
  );
}

function readFrontmatter(
  node: MdNode | undefined,
  diagnostics: WritingDiagnostic[],
): Record<string, any> {
  if (!node?.value) return {};
  try {
    const parsed = parseYamlDocument(node.value);
    if (parsed.errors.length) {
      const range = nodeRange(node);
      diagnostics.push(
        diagnostic(
          "metadata-yaml",
          range.from,
          range.to,
          "warning",
          "metadata",
          "원고 정보 형식을 확인해주세요",
          parsed.errors[0]?.message ?? "YAML을 읽을 수 없습니다.",
          "편집기 안내",
        ),
      );
    }
    const value = parsed.toJS();
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    const range = nodeRange(node);
    diagnostics.push(
      diagnostic(
        "metadata-yaml",
        range.from,
        range.to,
        "warning",
        "metadata",
        "원고 정보 형식을 확인해주세요",
        error instanceof Error ? error.message : "YAML을 읽을 수 없습니다.",
        "편집기 안내",
      ),
    );
    return {};
  }
}

function appendBlockNode(
  node: MdNode,
  source: string,
  blocks: ManuscriptBlock[],
  imagePaths: string[],
  context: { quoteDepth: number; listDepth: number },
): void {
  const range = nodeRange(node);
  switch (node.type) {
    case "paragraph": {
      const onlyImage =
        node.children?.length === 1 && node.children[0]?.type === "image";
      if (onlyImage) {
        const image = node.children?.[0];
        const path = image?.url ?? "";
        if (path && !isRemotePath(path)) imagePaths.push(path);
        blocks.push({
          id: blockId("figure", range),
          kind: "figure",
          label: image?.alt?.trim() || "그림",
          detail: path || "그림 경로 없음",
          from: range.from,
          to: range.to,
          inlines: [],
          indent: 0,
          continuationIndent: 0,
        });
        return;
      }
      const inlines = inlineContent(node, source, context.quoteDepth > 0 ? "quote" : "normal");
      if (!inlines.length && range.from === range.to) return;
      blocks.push({
        id: blockId(context.quoteDepth ? "quote" : "paragraph", range),
        kind: context.quoteDepth ? "quote" : "paragraph",
        label: context.quoteDepth ? "인용문" : "문단",
        detail: "",
        from: range.from,
        to: range.to,
        inlines,
        indent: context.quoteDepth > 0 ? 3 : 1,
        continuationIndent: context.quoteDepth > 0 ? 2 : 0,
      });
      return;
    }
    case "heading": {
      blocks.push({
        id: blockId("heading", range),
        kind: "heading",
        label: `${node.depth ?? 2}단계 제목`,
        detail: nodePlainText(node),
        from: range.from,
        to: range.to,
        inlines: inlineContent(node, source, "heading"),
        indent: 1,
        continuationIndent: 0,
      });
      return;
    }
    case "blockquote":
      for (const child of node.children ?? []) {
        appendBlockNode(child, source, blocks, imagePaths, {
          ...context,
          quoteDepth: context.quoteDepth + 1,
        });
      }
      return;
    case "list": {
      let number = node.start ?? 1;
      for (const item of node.children ?? []) {
        appendListItem(
          item,
          source,
          blocks,
          imagePaths,
          context,
          node.ordered ? `${number}.` : "•",
        );
        number += 1;
      }
      return;
    }
    case "table": {
      const rowCount = node.children?.length ?? 0;
      const columnCount = node.children?.[0]?.children?.length ?? 0;
      blocks.push(cardBlock("table", range, "표", `${rowCount}행 × ${columnCount}열`));
      return;
    }
    case "math":
      blocks.push(cardBlock("math", range, "블록 수식", node.value?.trim() ?? ""));
      return;
    case "code":
      blocks.push(
        cardBlock(
          "code",
          range,
          "코드",
          node.value?.split("\n")[0]?.slice(0, 80) || "코드 블록",
        ),
      );
      return;
    case "footnoteDefinition":
      blocks.push(
        cardBlock(
          "footnote",
          range,
          `각주 ${node.label ?? node.identifier ?? ""}`.trim(),
          nodePlainText(node).slice(0, 100),
        ),
      );
      return;
    case "thematicBreak":
      blocks.push(cardBlock("divider", range, "구분선", "장면 또는 절 구분"));
      return;
    case "html":
      blocks.push(cardBlock("unsupported", range, "HTML", "완성본에서 표시하지 않음"));
      return;
    default:
      for (const child of node.children ?? []) {
        appendBlockNode(child, source, blocks, imagePaths, context);
      }
  }
}

function appendListItem(
  item: MdNode,
  source: string,
  blocks: ManuscriptBlock[],
  imagePaths: string[],
  context: { quoteDepth: number; listDepth: number },
  marker: string,
): void {
  const children = item.children ?? [];
  const firstParagraph = children.find((child) => child.type === "paragraph");
  const range = nodeRange(item);
  if (firstParagraph) {
    blocks.push({
      id: blockId("list-item", range),
      kind: "list-item",
      label: "목록",
      detail: "",
      from: range.from,
      to: range.to,
      inlines: inlineContent(firstParagraph, source, "normal"),
      indent: Math.min(4, context.listDepth + 1),
      continuationIndent: Math.min(6, context.listDepth + 3),
      marker:
        item.checked === true ? "☑" : item.checked === false ? "☐" : marker,
    });
  }
  for (const child of children) {
    if (child === firstParagraph) continue;
    appendBlockNode(child, source, blocks, imagePaths, {
      ...context,
      listDepth: context.listDepth + 1,
    });
  }
}

function inlineContent(
  node: MdNode,
  source: string,
  inheritedStyle: ManuscriptTextStyle,
): ManuscriptInline[] {
  const result: ManuscriptInline[] = [];
  for (const child of node.children ?? []) {
    appendInline(child, source, result, inheritedStyle);
  }
  return result;
}

function appendInline(
  node: MdNode,
  source: string,
  result: ManuscriptInline[],
  inheritedStyle: ManuscriptTextStyle,
): void {
  const range = nodeRange(node);
  switch (node.type) {
    case "text":
      appendMappedText(result, node.value ?? "", source, range, inheritedStyle);
      return;
    case "strong":
      for (const child of node.children ?? []) appendInline(child, source, result, "strong");
      return;
    case "emphasis":
    case "delete":
      for (const child of node.children ?? []) appendInline(child, source, result, "emphasis");
      return;
    case "link":
      for (const child of node.children ?? []) appendInline(child, source, result, "link");
      return;
    case "inlineCode":
      appendMappedText(result, node.value ?? "", source, range, "code");
      return;
    case "inlineMath":
      result.push({
        text: "∑",
        from: range.from,
        to: range.to,
        style: "code",
        atomic: true,
      });
      return;
    case "footnoteReference":
      result.push({
        text: `주${node.label ?? node.identifier ?? ""}`,
        from: range.from,
        to: range.to,
        style: "footnote",
        atomic: true,
      });
      return;
    case "image":
      result.push({
        text: "그림",
        from: range.from,
        to: range.to,
        style: "link",
        atomic: true,
      });
      return;
    case "break":
      result.push({
        text: "\n",
        from: range.from,
        to: range.to,
        style: inheritedStyle,
        atomic: true,
      });
      return;
    case "html":
      result.push({
        text: "HTML",
        from: range.from,
        to: range.to,
        style: "code",
        atomic: true,
      });
      return;
    default:
      for (const child of node.children ?? []) {
        appendInline(child, source, result, inheritedStyle);
      }
  }
}

function appendMappedText(
  result: ManuscriptInline[],
  value: string,
  source: string,
  range: SourceRange,
  style: ManuscriptTextStyle,
): void {
  if (!value) return;
  const sourceSlice = source.slice(range.from, range.to);
  if (sourceSlice === value) {
    result.push({
      text: value,
      from: range.from,
      to: range.to,
      style,
    });
    return;
  }

  let cursor = range.from;
  for (const segment of graphemes(value)) {
    let located = source.indexOf(segment, cursor);
    if (located < 0 || located >= range.to) {
      located = cursor;
    }
    if (source[located] === "\\" && source.slice(located + 1).startsWith(segment)) {
      located += 1;
    }
    result.push({
      text: segment,
      from: located,
      to: Math.min(range.to, located + segment.length),
      style,
    });
    cursor = Math.max(cursor, located + segment.length);
  }
}

function analyzeBlocks(
  content: string,
  blocks: ManuscriptBlock[],
  diagnostics: WritingDiagnostic[],
): void {
  for (const block of blocks) {
    if (block.kind === "unsupported") {
      diagnostics.push(
        diagnostic(
          "raw-html",
          block.from,
          block.to,
          "warning",
          "markdown",
          "HTML은 완성본에서 제외됩니다",
          "안전을 위해 원시 HTML을 실행하거나 렌더링하지 않습니다.",
          "편집기 안내",
        ),
      );
      continue;
    }
    if (block.kind === "figure" && isRemotePath(block.detail)) {
      diagnostics.push(
        diagnostic(
          "remote-image",
          block.from,
          block.to,
          "warning",
          "markdown",
          "원격 그림은 자동으로 불러오지 않습니다",
          "그림 삽입 도구로 로컬 사본을 저장하면 오프라인에서도 안전하게 표시됩니다.",
          "편집기 안내",
        ),
      );
    }
    for (const inline of block.inlines) {
      if (inline.atomic || inline.text === "\n") continue;
      analyzeInlineText(content, inline, diagnostics);
    }
    const source = content.slice(block.from, block.to);
    if (/^[ \u3000]+/.test(source) && ["paragraph", "heading"].includes(block.kind)) {
      const match = source.match(/^[ \u3000]+/)?.[0] ?? "";
      diagnostics.push(
        withFix(
          diagnostic(
            "manual-indent",
            block.from,
            block.from + match.length,
            "suggestion",
            "manuscript",
            "첫 칸은 편집기가 자동으로 비웁니다",
            "문단 앞에 직접 넣은 공백은 Markdown 결과에 남으므로 제거하는 편이 좋습니다.",
            "일반 원고지 관행",
          ),
          content,
          block.from,
          block.from + match.length,
          "",
          "직접 넣은 공백 제거",
          true,
        ),
      );
    }
  }
}

function collectEmbeddedResources(
  node: MdNode,
  imagePaths: string[],
  diagnostics: WritingDiagnostic[],
): void {
  if (node.type === "image") {
    const range = nodeRange(node);
    const path = node.url?.trim() ?? "";
    if (path && isRemotePath(path)) {
      diagnostics.push(
        diagnostic(
          "remote-image",
          range.from,
          range.to,
          "warning",
          "markdown",
          "원격 그림은 자동으로 불러오지 않습니다",
          "그림 삽입 도구로 로컬 사본을 저장하면 오프라인에서도 안전하게 표시됩니다.",
          "편집기 안내",
        ),
      );
    } else if (path) {
      imagePaths.push(path);
    }
  }
  if (node.type === "html") {
    const range = nodeRange(node);
    diagnostics.push(
      diagnostic(
        "raw-html",
        range.from,
        range.to,
        "warning",
        "markdown",
        "HTML은 완성본에서 제외됩니다",
        "안전을 위해 원시 HTML을 실행하거나 렌더링하지 않습니다.",
        "편집기 안내",
      ),
    );
  }
  for (const child of node.children ?? []) {
    collectEmbeddedResources(child, imagePaths, diagnostics);
  }
}

function analyzeInlineText(
  content: string,
  inline: ManuscriptInline,
  diagnostics: WritingDiagnostic[],
): void {
  const value = content.slice(inline.from, inline.to);
  for (const match of value.matchAll(/\.{3,}|(?<!…)…(?!…)/g)) {
    const from = inline.from + (match.index ?? 0);
    const to = from + match[0].length;
    diagnostics.push(
      withFix(
        diagnostic(
          "ellipsis",
          from,
          to,
          "warning",
          "punctuation",
          "말줄임표는 두 칸에 씁니다",
          "점 세 개나 한 글자짜리 줄임표 대신 ‘……’를 사용합니다.",
          "일반 원고지 관행",
          "예: 아직은…… 잘 모르겠다.",
        ),
        content,
        from,
        to,
        "……",
        "말줄임표로 고치기",
        true,
      ),
    );
  }
  for (const match of value.matchAll(/ {2,}/g)) {
    const from = inline.from + (match.index ?? 0);
    const to = from + match[0].length;
    diagnostics.push(
      withFix(
        diagnostic(
          "repeated-space",
          from,
          to,
          "suggestion",
          "spacing",
          "공백이 연달아 있습니다",
          "의도한 정렬이 아니라면 공백 하나만 남깁니다.",
          "편집기 안내",
        ),
        content,
        from,
        to,
        " ",
        "공백 하나로 줄이기",
        true,
      ),
    );
  }
  for (const match of value.matchAll(/[ \u3000]+(?=[,.!?])/g)) {
    const from = inline.from + (match.index ?? 0);
    const to = from + match[0].length;
    diagnostics.push(
      withFix(
        diagnostic(
          "space-before-punctuation",
          from,
          to,
          "warning",
          "punctuation",
          "문장 부호 앞은 띄우지 않습니다",
          "마침표, 쉼표, 물음표, 느낌표는 앞말에 붙여 씁니다.",
          "국립국어원 규범",
        ),
        content,
        from,
        to,
        "",
        "앞 공백 제거",
        true,
      ),
    );
  }
  for (const match of value.matchAll(/[!?](?=[가-힣A-Za-z0-9])/g)) {
    const at = inline.from + (match.index ?? 0) + 1;
    diagnostics.push(
      withFix(
        diagnostic(
          "space-after-question",
          at,
          at,
          "suggestion",
          "punctuation",
          "다음 문장과 한 칸 띄워주세요",
          "물음표나 느낌표 뒤에 문장이 이어지면 한 칸 띄어 구분합니다.",
          "일반 원고지 관행",
        ),
        content,
        at,
        at,
        " ",
        "한 칸 띄우기",
        true,
      ),
    );
  }
  for (const match of value.matchAll(/\t/g)) {
    const from = inline.from + (match.index ?? 0);
    diagnostics.push(
      withFix(
        diagnostic(
          "tab",
          from,
          from + 1,
          "warning",
          "manuscript",
          "탭 대신 원고지 들여쓰기를 사용합니다",
          "문단과 인용문의 들여쓰기는 화면에서 자동 배치됩니다.",
          "일반 원고지 관행",
        ),
        content,
        from,
        from + 1,
        "",
        "탭 제거",
        true,
      ),
    );
  }
  for (const match of value.matchAll(/\n/g)) {
    const from = inline.from + (match.index ?? 0);
    diagnostics.push(
      withFix(
        diagnostic(
          "soft-line-break",
          from,
          from + 1,
          "suggestion",
          "structure",
          "새 문단이라면 Enter로 구분해주세요",
          "한 번만 줄을 바꾸면 Markdown에서는 같은 문단으로 취급됩니다.",
          "편집기 안내",
        ),
        content,
        from,
        from + 1,
        "\n\n",
        "새 문단으로 바꾸기",
        false,
      ),
    );
  }
}

function analyzeMetadata(
  metadata: ManuscriptMetadata,
  source: MetadataSource,
  diagnostics: WritingDiagnostic[],
): void {
  if (!metadata.author.trim()) {
    diagnostics.push(
      diagnostic(
        "missing-author",
        source.range.from,
        source.range.to,
        "suggestion",
        "metadata",
        "작성자 정보가 비어 있습니다",
        "원고 정보에서 이름을 입력하면 첫 장 오른쪽에 배치됩니다.",
        "일반 원고지 관행",
      ),
    );
  }
  if (/[.!?…]$/.test(metadata.title.trim())) {
    diagnostics.push(
      diagnostic(
        "title-punctuation",
        source.range.from,
        source.range.to,
        "suggestion",
        "metadata",
        "제목 끝의 문장 부호를 확인해주세요",
        "일반적인 원고지 제목에는 마침표를 쓰지 않고 물음표·느낌표도 가급적 피합니다.",
        "일반 원고지 관행",
      ),
    );
  }
}

function diagnostic(
  ruleId: string,
  from: number,
  to: number,
  severity: DiagnosticSeverity,
  category: DiagnosticCategory,
  title: string,
  message: string,
  source: WritingDiagnostic["source"],
  example?: string,
): WritingDiagnostic {
  return {
    id: `${ruleId}:${from}:${to}`,
    ruleId,
    from,
    to,
    severity,
    category,
    title,
    message,
    source,
    example,
  };
}

function withFix(
  item: WritingDiagnostic,
  content: string,
  from: number,
  to: number,
  replacement: string,
  label: string,
  safe: boolean,
): WritingDiagnostic {
  item.fix = {
    from,
    to,
    replacement,
    expected: content.slice(from, to),
    label,
    safe,
  };
  return item;
}

function cardBlock(
  kind: Extract<
    ManuscriptBlockKind,
    "table" | "math" | "code" | "footnote" | "divider" | "unsupported"
  >,
  range: SourceRange,
  label: string,
  detail: string,
): ManuscriptBlock {
  return {
    id: blockId(kind, range),
    kind,
    label,
    detail,
    from: range.from,
    to: range.to,
    inlines: [],
    indent: 0,
    continuationIndent: 0,
  };
}

function blockId(kind: ManuscriptBlockKind, range: SourceRange): string {
  return `${kind}:${range.from}:${range.to}`;
}

function nodeRange(node: MdNode): SourceRange {
  const from = node.position?.start.offset ?? 0;
  const to = node.position?.end.offset ?? from;
  return { from, to };
}

function firstTextDescendant(node: MdNode): MdNode | null {
  if (node.type === "text") return node;
  for (const child of node.children ?? []) {
    const found = firstTextDescendant(child);
    if (found) return found;
  }
  return null;
}

function nodePlainText(node: MdNode): string {
  if (typeof node.value === "string") return node.value;
  if (node.type === "image") return node.alt ?? "";
  return (node.children ?? []).map(nodePlainText).join("");
}

function firstContentOffset(children: MdNode[], fallback: number): number {
  return (
    children.find((node) => node.type !== "yaml")?.position?.start.offset ?? fallback
  );
}

function scalar(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : "";
}

function numeric(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isRemotePath(value: string): boolean {
  return /^(?:https?:)?\/\//i.test(value) || /^data:/i.test(value);
}

function removeRanges(content: string, ranges: SourceRange[]): string {
  const ordered = [...ranges].sort((left, right) => right.from - left.from);
  let result = content;
  for (const range of ordered) {
    result = result.slice(0, range.from) + result.slice(range.to);
  }
  return result.replace(/^\s+/, "");
}

function deduplicateDiagnostics(
  diagnostics: WritingDiagnostic[],
): WritingDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort(
      (left, right) =>
        left.from - right.from ||
        severityRank(left.severity) - severityRank(right.severity),
    );
}

function severityRank(value: DiagnosticSeverity): number {
  return value === "error" ? 0 : value === "warning" ? 1 : 2;
}

function graphemes(value: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return Array.from(
      new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(value),
      (entry) => entry.segment,
    );
  }
  return Array.from(value);
}
