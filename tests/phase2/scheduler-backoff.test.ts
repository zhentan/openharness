/**
 * H24: Transient retries use exponential backoff with cooldown_until
 *
 * Phase gate: 2
 *
 * Tasks in retry_pending with a cooldown_until timestamp in the future
 * must be skipped by the scheduler. This prevents immediate re-dispatch
 * of rate-limited or timed-out tasks.
 */
import { describe, it, expect } from "vitest";

describe("H24: Scheduler respects cooldown_until", () => {
  it("skips retry_pending tasks whose cooldown has not expired", async () => {
    const { selectTasks } = await import("../../src/scheduler/scheduler.js");

    const futureTime = new Date(Date.now() + 60_000).toISOString();

    const tasks = [
      {
        id: "t_cooling",
        title: "Cooling down",
        status: "retry_pending" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "retry me",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 2,
        cooldown_until: futureTime,
      },
    ];

    const selected = selectTasks(tasks, { maxConcurrency: 4, runningCount: 0 });
    expect(selected).toHaveLength(0);
  });

  it("selects retry_pending tasks whose cooldown has expired", async () => {
    const { selectTasks } = await import("../../src/scheduler/scheduler.js");

    const pastTime = new Date(Date.now() - 1000).toISOString();

    const tasks = [
      {
        id: "t_ready",
        title: "Cooldown expired",
        status: "retry_pending" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "retry me",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 2,
        cooldown_until: pastTime,
      },
    ];

    const selected = selectTasks(tasks, { maxConcurrency: 4, runningCount: 0 });
    expect(selected.map((t) => t.id)).toContain("t_ready");
  });

  it("selects retry_pending tasks with no cooldown_until set", async () => {
    const { selectTasks } = await import("../../src/scheduler/scheduler.js");

    const tasks = [
      {
        id: "t_no_cooldown",
        title: "No cooldown",
        status: "retry_pending" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "retry me",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 2,
      },
    ];

    const selected = selectTasks(tasks, { maxConcurrency: 4, runningCount: 0 });
    expect(selected.map((t) => t.id)).toContain("t_no_cooldown");
  });
});
