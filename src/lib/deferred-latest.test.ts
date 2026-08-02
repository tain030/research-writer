import { afterEach, describe, expect, it, vi } from "vitest";
import { DeferredLatest } from "./deferred-latest";

afterEach(() => vi.useRealTimers());

describe("DeferredLatest", () => {
  it("runs only the latest scheduled analysis", () => {
    vi.useFakeTimers();
    const deferred = new DeferredLatest();
    const applied: string[] = [];

    deferred.schedule(250, () => "old", (value) => applied.push(value));
    vi.advanceTimersByTime(100);
    deferred.schedule(250, () => "latest", (value) => applied.push(value));
    vi.advanceTimersByTime(249);
    expect(applied).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(applied).toEqual(["latest"]);
  });

  it("cancels pending work when a document changes", () => {
    vi.useFakeTimers();
    const deferred = new DeferredLatest();
    const apply = vi.fn();

    deferred.schedule(250, () => "stale", apply);
    deferred.cancel();
    vi.runAllTimers();

    expect(apply).not.toHaveBeenCalled();
  });
});
