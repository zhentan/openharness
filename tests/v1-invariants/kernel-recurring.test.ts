/**
 * P15: Recurring task re-queue with cooldown
 *
 * v1 proof: src/kernel.ts:220-238 — processRecurringTasks
 * Phase gate: 6
 *
 * Tasks marked recurring=true are re-queued after completion/merge,
 * but only after the cooldown period has elapsed.
 */
import { describe, it, expect } from "vitest";

describe("P15: Recurring task re-queue", () => {
  it("re-queues a completed recurring task after cooldown", async () => {
    const { shouldRequeueRecurring } = await import("../../src/scheduler/scheduler.js");

    const task = {
      id: "t_recurring",
      status: "merged" as const,
      recurring: true,
      recurring_interval_hours: 1,
      completed_at: new Date(Date.now() - 2 * 3600_000).toISOString(), // 2 hours ago
    };

    expect(shouldRequeueRecurring(task)).toBe(true);
  });

  it("does not re-queue before cooldown expires", async () => {
    const { shouldRequeueRecurring } = await import("../../src/scheduler/scheduler.js");

    const task = {
      id: "t_recurring",
      status: "merged" as const,
      recurring: true,
      recurring_interval_hours: 24,
      completed_at: new Date(Date.now() - 1 * 3600_000).toISOString(), // 1 hour ago, cooldown is 24h
    };

    expect(shouldRequeueRecurring(task)).toBe(false);
  });

  it("does not re-queue non-recurring tasks", async () => {
    const { shouldRequeueRecurring } = await import("../../src/scheduler/scheduler.js");

    const task = {
      id: "t_oneshot",
      status: "merged" as const,
      recurring: false,
      completed_at: new Date(Date.now() - 48 * 3600_000).toISOString(),
    };

    expect(shouldRequeueRecurring(task)).toBe(false);
  });
});
