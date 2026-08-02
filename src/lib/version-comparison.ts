import { diffLines, diffWords } from "diff";

export interface VersionDiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export interface VersionComparison {
  parts: VersionDiffPart[];
  granularity: "word" | "line" | "coarse";
  changed: boolean;
}

export interface VersionComparisonOptions {
  wordThreshold?: number;
  timeoutMs?: number;
}

const DEFAULT_WORD_THRESHOLD = 50_000;
const DEFAULT_TIMEOUT_MS = 75;

export function compareVersionContent(
  current: string,
  restored: string,
  options: VersionComparisonOptions = {},
): VersionComparison {
  const wordThreshold = options.wordThreshold ?? DEFAULT_WORD_THRESHOLD;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const useWords = current.length + restored.length <= wordThreshold;
  const compared = useWords
    ? diffWords(current, restored, { timeout })
    : diffLines(current, restored, { timeout });

  if (compared) {
    const parts = compared.map(({ value, added, removed }) => ({
      value,
      added,
      removed,
    }));
    return {
      parts,
      granularity: useWords ? "word" : "line",
      changed: parts.some((part) => part.added || part.removed),
    };
  }

  const parts: VersionDiffPart[] = [];
  if (current) parts.push({ value: current, removed: true });
  if (restored) parts.push({ value: restored, added: true });
  if (!parts.length) parts.push({ value: "" });
  return {
    parts,
    granularity: "coarse",
    changed: current !== restored,
  };
}
