import type {
  DiagnosticSeverity,
  WritingDiagnostic,
} from "./manuscript-document";

const BUCKET_SIZE = 512;

export interface DiagnosticIndex {
  buckets: Map<number, WritingDiagnostic[]>;
}

export function createDiagnosticIndex(
  diagnostics: WritingDiagnostic[],
): DiagnosticIndex {
  const buckets = new Map<number, WritingDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    const start = Math.max(0, diagnostic.from);
    const inclusiveEnd = Math.max(start, diagnostic.to - 1);
    const firstBucket = Math.floor(start / BUCKET_SIZE);
    const lastBucket = Math.floor(inclusiveEnd / BUCKET_SIZE);
    for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
      const entries = buckets.get(bucket);
      if (entries) entries.push(diagnostic);
      else buckets.set(bucket, [diagnostic]);
    }
  }
  return { buckets };
}

export function diagnosticSeverityForRange(
  index: DiagnosticIndex,
  from: number,
  to: number,
): DiagnosticSeverity | undefined {
  const safeFrom = Math.max(0, from);
  // Include the exclusive end bucket as point diagnostics may live exactly at
  // a cell boundary (for example, at the end of the document).
  const inclusiveEnd = Math.max(safeFrom, to);
  const firstBucket = Math.floor(safeFrom / BUCKET_SIZE);
  const lastBucket = Math.floor(inclusiveEnd / BUCKET_SIZE);
  let severity: DiagnosticSeverity | undefined;
  const seen = firstBucket === lastBucket ? null : new Set<string>();

  for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
    for (const diagnostic of index.buckets.get(bucket) ?? []) {
      if (seen?.has(diagnostic.id)) continue;
      seen?.add(diagnostic.id);
      if (!rangesIntersect(from, to, diagnostic.from, diagnostic.to)) continue;
      if (diagnostic.severity === "error") return "error";
      if (diagnostic.severity === "warning") severity = "warning";
      else if (!severity) severity = "suggestion";
    }
  }
  return severity;
}

function rangesIntersect(
  leftFrom: number,
  leftTo: number,
  rightFrom: number,
  rightTo: number,
): boolean {
  if (rightFrom === rightTo) {
    return leftFrom <= rightFrom && leftTo >= rightTo;
  }
  if (leftFrom === leftTo) {
    return rightFrom <= leftFrom && rightTo >= leftTo;
  }
  return leftFrom < rightTo && leftTo > rightFrom;
}
