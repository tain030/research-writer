import { describe, expect, it } from "vitest";
import { compareVersionContent } from "./version-comparison";

describe("version comparison", () => {
  it("shows short Korean edits at word granularity", () => {
    const result = compareVersionContent("기존 문장입니다.", "새 문장입니다.");

    expect(result.granularity).toBe("word");
    expect(result.changed).toBe(true);
    expect(result.parts.some((part) => part.removed && part.value.includes("기존"))).toBe(
      true,
    );
    expect(result.parts.some((part) => part.added && part.value.includes("새"))).toBe(true);
  });

  it("uses a bounded line comparison for long manuscripts", () => {
    const result = compareVersionContent("첫 줄\n둘째 줄\n", "첫 줄\n새 둘째 줄\n", {
      wordThreshold: 0,
    });

    expect(result.granularity).toBe("line");
    expect(result.parts.some((part) => part.added)).toBe(true);
    expect(result.parts.some((part) => part.removed)).toBe(true);
  });

  it("falls back to a coarse comparison when the time budget expires", () => {
    const result = compareVersionContent("현재", "복원", { timeoutMs: -1 });

    expect(result.granularity).toBe("coarse");
    expect(result.parts).toEqual([
      { value: "현재", removed: true },
      { value: "복원", added: true },
    ]);
  });

  it("marks identical versions as unchanged", () => {
    const result = compareVersionContent("같은 원고", "같은 원고");

    expect(result.changed).toBe(false);
  });
});
