import { describe, expect, it, vi } from "vitest";
import { SingleFlight } from "./single-flight";

describe("SingleFlight", () => {
  it("shares one in-flight task with concurrent callers", async () => {
    let resolveTask: ((value: boolean) => void) | undefined;
    const task = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveTask = resolve;
        }),
    );
    const flight = new SingleFlight<boolean>();

    const first = flight.run(task);
    const second = flight.run(task);

    expect(first).toBe(second);
    expect(task).toHaveBeenCalledTimes(1);
    expect(flight.active).toBe(true);

    resolveTask?.(true);
    await expect(first).resolves.toBe(true);
    expect(flight.active).toBe(false);
  });

  it("accepts a fresh task after success or failure", async () => {
    const flight = new SingleFlight<number>();

    await expect(flight.run(async () => 1)).resolves.toBe(1);
    await expect(
      flight.run(async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(flight.run(async () => 2)).resolves.toBe(2);
  });
});
