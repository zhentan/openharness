/**
 * Age-based starvation prevention.
 *
 * Phase gate: 2
 *
 * A low-priority task that has been pending long enough must eventually
 * outrank a newer high-priority task. Scoring uses enqueued_at (when the
 * task was first seen by the store), not assigned_at (which is only set
 * on dispatch).
 */
import { describe, it, expect } from "vitest";

describe("Scheduler starvation prevention", () => {
  it("an old low-priority task eventually outranks a new high-priority task", async () => {
    const { selectTasks } = await import("../../src/scheduler/scheduler.js");

    const tasks = [
      {
        id: "t_old_low",
        title: "Old low priority",
        status: "pending" as const,
        priority: "low" as const,
        depends_on: [],
        agent_prompt: "old work",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 1,
        // Enqueued 48 hours ago — should accumulate significant age bonus
        enqueued_at: new Date(Date.now() - 48 * 3_600_000).toISOString(),
      },
      {
        id: "t_new_high",
        title: "New high priority",
        status: "pending" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "new work",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 1,
        // Enqueued just now — no age bonus
        enqueued_at: new Date().toISOString(),
      },
    ];

    // With only 1 slot, the old low-priority task should win due to age
    const selected = selectTasks(tasks, { maxConcurrency: 1, runningCount: 0 });
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe("t_old_low");
  });

  it("a recently enqueued low-priority task does NOT outrank high-priority", async () => {
    const { selectTasks } = await import("../../src/scheduler/scheduler.js");

    const tasks = [
      {
        id: "t_recent_low",
        title: "Recent low priority",
        status: "pending" as const,
        priority: "low" as const,
        depends_on: [],
        agent_prompt: "new low work",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 1,
        enqueued_at: new Date().toISOString(),
      },
      {
        id: "t_recent_high",
        title: "Recent high priority",
        status: "pending" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "new high work",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 1,
        enqueued_at: new Date().toISOString(),
      },
    ];

    const selected = selectTasks(tasks, { maxConcurrency: 1, runningCount: 0 });
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe("t_recent_high");
  });
});
