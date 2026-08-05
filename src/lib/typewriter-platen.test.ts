import { describe, expect, it } from "vitest";
import {
  resolvePlatenScrollFrame,
  TYPEWRITER_BODY_LINE_HEIGHT,
  typewriterPlatenLinePitch,
} from "./typewriter-platen";

describe("typewriter platen motion", () => {
  it("derives rotation from absolute paper travel without cumulative drift", () => {
    const circumference = Math.PI * 20;
    const quarterTurn = resolvePlatenScrollFrame({
      previousTop: 0,
      nextTop: circumference / 4,
      linePitch: 24,
      platenDiameter: 20,
    });
    const fullTurn = resolvePlatenScrollFrame({
      previousTop: circumference / 4,
      nextTop: circumference,
      linePitch: 24,
      platenDiameter: 20,
    });

    expect(quarterTurn.angleDeg).toBeCloseTo(90);
    expect(quarterTurn.surfaceOffsetPx).toBeCloseTo(circumference / 4);
    expect(fullTurn.angleDeg).toBeCloseTo(0);
    expect(fullTurn.surfaceOffsetPx).toBeCloseTo(0);
  });

  it("reports direction, velocity intensity, and every crossed detent", () => {
    const forward = resolvePlatenScrollFrame({
      previousTop: 20,
      nextTop: 74,
      linePitch: 24,
      platenDiameter: 20,
      elapsedMs: 16,
    });
    const reverse = resolvePlatenScrollFrame({
      previousTop: 74,
      nextTop: 20,
      linePitch: 24,
      platenDiameter: 20,
      elapsedMs: 160,
    });

    expect(forward.direction).toBe(1);
    expect(forward.detentIndex).toBe(3);
    expect(forward.detentCrossings).toBe(3);
    expect(forward.intensity).toBe(1);
    expect(reverse.direction).toBe(-1);
    expect(reverse.detentIndex).toBe(0);
    expect(reverse.detentCrossings).toBe(3);
    expect(reverse.intensity).toBeGreaterThanOrEqual(0.12);
    expect(reverse.intensity).toBeLessThan(forward.intensity);
  });

  it("uses a stable body-line pitch instead of the active block height", () => {
    expect(typewriterPlatenLinePitch(1)).toBeCloseTo(
      TYPEWRITER_BODY_LINE_HEIGHT,
    );
    expect(typewriterPlatenLinePitch(0.5)).toBeCloseTo(
      TYPEWRITER_BODY_LINE_HEIGHT * 0.5,
    );
    expect(typewriterPlatenLinePitch(4)).toBe(48);
    expect(typewriterPlatenLinePitch(Number.NaN)).toBeCloseTo(
      TYPEWRITER_BODY_LINE_HEIGHT,
    );
  });

  it("stays inert for invalid or unchanged scroll positions", () => {
    const frame = resolvePlatenScrollFrame({
      previousTop: 42,
      nextTop: Number.NaN,
      linePitch: Number.NaN,
      platenDiameter: Number.NaN,
      elapsedMs: Number.NaN,
    });

    expect(frame.direction).toBe(0);
    expect(frame.detentCrossings).toBe(0);
    expect(frame.intensity).toBe(0);
    expect(frame.angleDeg).toBeGreaterThanOrEqual(0);
    expect(frame.angleDeg).toBeLessThan(360);
  });
});
