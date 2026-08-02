import { describe, expect, it } from "vitest";
import {
  createDiagnosticIndex,
  diagnosticSeverityForRange,
} from "./diagnostic-index";
import type { WritingDiagnostic } from "./manuscript-document";

function issue(
  id: string,
  from: number,
  to: number,
  severity: WritingDiagnostic["severity"],
): WritingDiagnostic {
  return {
    id,
    ruleId: id,
    from,
    to,
    severity,
    category: "spacing",
    title: id,
    message: id,
    source: "편집기 안내",
  };
}

describe("diagnostic range index", () => {
  it("finds ranges and point diagnostics with severity precedence", () => {
    const index = createDiagnosticIndex([
      issue("suggestion", 10, 12, "suggestion"),
      issue("warning", 11, 14, "warning"),
      issue("point", 20, 20, "error"),
    ]);

    expect(diagnosticSeverityForRange(index, 10, 11)).toBe("suggestion");
    expect(diagnosticSeverityForRange(index, 11, 12)).toBe("warning");
    expect(diagnosticSeverityForRange(index, 20, 20)).toBe("error");
    expect(diagnosticSeverityForRange(index, 30, 31)).toBeUndefined();
  });

  it("finds a long diagnostic across bucket boundaries", () => {
    const index = createDiagnosticIndex([
      issue("long", 400, 1_200, "warning"),
    ]);

    expect(diagnosticSeverityForRange(index, 900, 901)).toBe("warning");
  });

  it("finds a point diagnostic on the exclusive end bucket boundary", () => {
    const index = createDiagnosticIndex([
      issue("boundary", 512, 512, "suggestion"),
    ]);

    expect(diagnosticSeverityForRange(index, 511, 512)).toBe("suggestion");
  });
});
