/**
 * H18: One agent per task (tick reentrancy guard)
 *
 * Phase gate: 2
 *
 * The tick loop must have a reentrancy guard — if a previous tick is
 * still running, the next tick skips. Without this, overlapping
 * setInterval ticks can double-dispatch the same task.
 */
import { describe, it, expect, vi } from "vitest";

describe("H18: Tick reentrancy guard", () => {
  it("skips tick if previous tick is still running", async () => {
    const { createTickLoop } = await import("../../src/tick.js");

    let concurrentTicks = 0;
    let maxConcurrentTicks = 0;

    const slowTick = vi.fn(async () => {
      concurrentTicks++;
      maxConcurrentTicks = Math.max(maxConcurrentTicks, concurrentTicks);
      // Simulate a slow tick
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentTicks--;
    });

    const loop = createTickLoop(slowTick, { intervalMs: 10 });
    loop.start();

    // Let several tick intervals pass while the first tick is still running
    await new Promise((resolve) => setTimeout(resolve, 250));
    loop.stop();

    // The reentrancy guard should prevent concurrent ticks
    expect(maxConcurrentTicks).toBe(1);
  });

  it("resumes ticking after a slow tick completes", async () => {
    const { createTickLoop } = await import("../../src/tick.js");

    let tickCount = 0;

    const tick = vi.fn(async () => {
      tickCount++;
      if (tickCount === 1) {
        // First tick is slow
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });

    const loop = createTickLoop(tick, { intervalMs: 10 });
    loop.start();

    await new Promise((resolve) => setTimeout(resolve, 200));
    loop.stop();

    // Should have ticked more than once (recovered after slow first tick)
    expect(tickCount).toBeGreaterThan(1);
  });

  it("routes async tick failures to onError instead of leaking a rejection", async () => {
    const { createTickLoop } = await import("../../src/tick.js");

    const onError = vi.fn();
    const expected = new Error("tick failed");
    const tick = vi.fn(async () => {
      throw expected;
    });

    const loop = createTickLoop(tick, { intervalMs: 50, onError });
    loop.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    loop.stop();

    expect(onError).toHaveBeenCalledWith(expected);
  });
});
