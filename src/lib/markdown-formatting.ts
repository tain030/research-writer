export type MarkdownBlockStyle =
  | "body"
  | "heading1"
  | "heading2"
  | "heading3"
  | "quote"
  | "bullet";
export type MarkdownInlineStyle = "strong" | "emphasis";

export interface MarkdownSelection {
  from: number;
  to: number;
}

export interface MarkdownEdit extends MarkdownSelection {
  replaceFrom: number;
  replaceTo: number;
  replacement: string;
}

const blockPrefix = /^(?:#{1,3}\s+|>\s+|[-*+]\s+)/u;

export function currentBlockStyle(
  content: string,
  offset: number,
): MarkdownBlockStyle {
  const start = content.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const line = content.slice(start, content.indexOf("\n", offset) < 0 ? content.length : content.indexOf("\n", offset));
  if (/^#\s/u.test(line)) return "heading1";
  if (/^###\s/u.test(line)) return "heading3";
  if (/^##\s/u.test(line)) return "heading2";
  if (/^>\s/u.test(line)) return "quote";
  if (/^[-*+]\s/u.test(line)) return "bullet";
  return "body";
}

export function applyBlockStyle(
  content: string,
  selection: MarkdownSelection,
  style: MarkdownBlockStyle,
): MarkdownEdit {
  const safeFrom = clamp(selection.from, 0, content.length);
  const safeTo = clamp(selection.to, safeFrom, content.length);
  const replaceFrom = content.lastIndexOf("\n", Math.max(0, safeFrom - 1)) + 1;
  const nextBreak = content.indexOf("\n", safeTo);
  const replaceTo = nextBreak < 0 ? content.length : nextBreak;
  const source = content.slice(replaceFrom, replaceTo);
  const prefix = prefixForStyle(style);
  const lines = source.split("\n");
  const transformed = lines.map((line) => `${prefix}${line.replace(blockPrefix, "")}`);
  const replacement = transformed.join("\n");

  const mapOffset = (offset: number): number => {
    const relative = clamp(offset - replaceFrom, 0, source.length);
    let oldStart = 0;
    let newStart = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const oldEnd = oldStart + line.length;
      const removed = line.match(blockPrefix)?.[0].length ?? 0;
      if (relative <= oldEnd || index === lines.length - 1) {
        const within = relative - oldStart;
        return (
          replaceFrom +
          newStart +
          (within <= removed ? prefix.length : prefix.length + within - removed)
        );
      }
      oldStart = oldEnd + 1;
      newStart += transformed[index].length + 1;
    }
    return replaceFrom + replacement.length;
  };

  return {
    replaceFrom,
    replaceTo,
    replacement,
    from: mapOffset(safeFrom),
    to: mapOffset(safeTo),
  };
}

export function toggleInlineStyle(
  content: string,
  selection: MarkdownSelection,
  style: MarkdownInlineStyle,
): MarkdownEdit {
  const marker = style === "strong" ? "**" : "_";
  const from = clamp(selection.from, 0, content.length);
  const to = clamp(selection.to, from, content.length);
  const selected = content.slice(from, to);
  if (
    from >= marker.length &&
    content.slice(from - marker.length, from) === marker &&
    content.slice(to, to + marker.length) === marker
  ) {
    return {
      replaceFrom: from - marker.length,
      replaceTo: to + marker.length,
      replacement: selected,
      from: from - marker.length,
      to: to - marker.length,
    };
  }
  if (!selected) {
    return {
      replaceFrom: from,
      replaceTo: to,
      replacement: `${marker}${marker}`,
      from: from + marker.length,
      to: from + marker.length,
    };
  }
  return {
    replaceFrom: from,
    replaceTo: to,
    replacement: `${marker}${selected}${marker}`,
    from: from + marker.length,
    to: to + marker.length,
  };
}

export function insertMarkdownLink(
  content: string,
  selection: MarkdownSelection,
  url: string,
): MarkdownEdit {
  const from = clamp(selection.from, 0, content.length);
  const to = clamp(selection.to, from, content.length);
  const selected = content.slice(from, to);
  const label = selected || "링크 텍스트";
  const destination = url.trim() || "https://";
  const replacement = `[${label}](${destination})`;
  return {
    replaceFrom: from,
    replaceTo: to,
    replacement,
    from: selected ? from : from + 1,
    to: selected ? from + replacement.length : from + 1 + label.length,
  };
}

function prefixForStyle(style: MarkdownBlockStyle): string {
  if (style === "heading1") return "# ";
  if (style === "heading2") return "## ";
  if (style === "heading3") return "### ";
  if (style === "quote") return "> ";
  if (style === "bullet") return "- ";
  return "";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}
