// The page-wide inference queue: runs never overlap, and one failure does not jam the rest.

import { describe, expect, it } from "vitest";
import { exclusive } from "../src/ort-queue";

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

describe("exclusive()", () => {
  it("never lets two runs overlap, and keeps their order", async () => {
    let inFlight = 0, maxInFlight = 0;
    const order: number[] = [];
    const job = (k: number) => exclusive(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      order.push(k);
      inFlight -= 1;
      return k;
    });
    const results = await Promise.all([job(0), job(1), job(2), job(3)]);
    expect(results).toEqual([0, 1, 2, 3]);
    expect(order).toEqual([0, 1, 2, 3]);
    expect(maxInFlight).toBe(1);
  });

  it("passes a failure to its caller and keeps serving later runs", async () => {
    const bad = exclusive(async () => {
      throw new Error("boom");
    });
    const good = exclusive(async () => 42);
    await expect(bad).rejects.toThrow("boom");
    await expect(good).resolves.toBe(42);
  });
});
