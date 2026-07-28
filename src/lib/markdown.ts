import type { OutlineItem } from "./types";

export function extractOutline(content: string): OutlineItem[] {
  const result: OutlineItem[] = [];
  const lines = content.split("\n");
  let offset = 0;
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === marker) fence = null;
      else if (!fence) fence = marker;
      offset += line.length + 1;
      continue;
    }
    if (!fence) {
      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        result.push({
          level: heading[1].length,
          title: heading[2].trim(),
          line: index + 1,
          offset,
        });
      }
    }
    offset += line.length + 1;
  }
  return result;
}

export function countWords(content: string): number {
  return content.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
}

export function readingMinutes(content: string): number {
  return Math.max(1, Math.ceil(countWords(content) / 350));
}

export function sentenceRange(
  content: string,
  from: number,
  to: number = from,
): { from: number; to: number } {
  if (!content.length) return { from: 0, to: 0 };

  const safeFrom = Math.max(0, Math.min(from, content.length));
  const safeTo = Math.max(safeFrom, Math.min(to, content.length));
  let startProbe = safeFrom;
  let endProbe = safeTo > safeFrom ? safeTo - 1 : safeFrom;

  if (safeFrom === safeTo) {
    if (safeFrom === content.length) {
      startProbe = content.length - 1;
    } else if (/\s/u.test(content[safeFrom]) && safeFrom > 0) {
      startProbe = safeFrom - 1;
    }
    endProbe = startProbe;
  }

  const isBoundary = (value: string) => /[.!?。！？\n]/u.test(value);
  let sentenceFrom = startProbe;
  while (sentenceFrom > 0 && !isBoundary(content[sentenceFrom - 1])) {
    sentenceFrom -= 1;
  }
  while (
    sentenceFrom < startProbe &&
    content[sentenceFrom] !== "\n" &&
    /\s/u.test(content[sentenceFrom])
  ) {
    sentenceFrom += 1;
  }

  let sentenceTo = endProbe;
  while (sentenceTo < content.length && !isBoundary(content[sentenceTo])) {
    sentenceTo += 1;
  }
  if (
    sentenceTo < content.length &&
    content[sentenceTo] !== "\n"
  ) {
    sentenceTo += 1;
    while (
      sentenceTo < content.length &&
      /[”’"'」』)\]]/u.test(content[sentenceTo])
    ) {
      sentenceTo += 1;
    }
    const footnote = content.slice(sentenceTo).match(/^\[\^[^\]]+\]/u);
    if (footnote) sentenceTo += footnote[0].length;
  }

  return { from: sentenceFrom, to: sentenceTo };
}

export function currentSection(content: string, cursor: number): string {
  const before = content.slice(0, cursor);
  const headings = extractOutline(before);
  const latestH2 = [...headings].reverse().find((item) => item.level <= 2);
  const start = latestH2?.offset ?? 0;
  const after = content.slice(cursor);
  const nextHeading = after.search(/^#{1,2}\s+/m);
  const end = nextHeading >= 0 ? cursor + nextHeading : content.length;
  return content.slice(start, end).trim();
}

export function nextFootnoteId(content: string): string {
  const used = new Set(
    [...content.matchAll(/^\[\^([^\]]+)\]:/gm)].map((match) => match[1]),
  );
  let index = 1;
  while (used.has(String(index))) index += 1;
  return String(index);
}

export function findFootnoteByIdentity(
  content: string,
  identities: string[],
): string | null {
  const normalized = identities
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!normalized.length) return null;
  for (const match of content.matchAll(/^\[\^([^\]]+)\]:\s*(.+)$/gm)) {
    const definition = match[2].toLowerCase();
    if (normalized.some((identity) => definition.includes(identity))) {
      return match[1];
    }
  }
  return null;
}

export function appendFootnoteDefinition(
  content: string,
  id: string,
  citation: string,
): string {
  const trimmed = content.replace(/\s+$/, "");
  return `${trimmed}\n\n[^${id}]: ${citation.trim()}\n`;
}

export function stripMarkdownForCompletion(content: string): string {
  return content
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`>#-]/g, "")
    .trim();
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.at(-1) || "제목 없는 원고";
}

export function displayDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
