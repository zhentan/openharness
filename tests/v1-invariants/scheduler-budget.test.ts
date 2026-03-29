/**
 * P4: max_attempts checked in task selection
 *
 * v1 proof: src/scheduler/scheduler.ts:25 — attempt > max_attempts
 * v1 bug: #5 — scheduler didn't check budget, tasks retried infinitely
 * Phase gate: 2
 *
 * The scheduler must reject tasks that have exhausted their attempt budget.
 * This must be checked in BOTH task selection (scheduler) and attempt
 * recording (store), so neither path allows infinite retries.
 */
import { describe, it, expect } from "vitest";

describe("P4: max_attempts enforcement in scheduler", () => {
  it("excludes tasks that exceeded max_attempts from selection", async () => {
    const { selectTasks } = await import("../../src/scheduler/scheduler.js");

    const tasks = [
      {
        id: "t_exhausted",
        title: "Exhausted task",
        status: "pending" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "do something",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 4, // exceeded budget (1-indexed: attempts 1,2,3 done, 4 > max_attempts)
      },
      {
        id: "t_fresh",
        title: "Fresh task",
        status: "pending" as const,
        priority: "medium" as const,
        depends_on: [],
        agent_prompt: "do something else",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 1, // within budget
      },
    ];

    const selected = selectTasks(tasks, { maxConcurrency: 4, runningCount: 0 });

    expect(selected.map((t) => t.id)).toContain("t_fresh");
    expect(selected.map((t) => t.id)).not.toContain("t_exhausted");
  });

  it("selects tasks at exactly max_attempts (last chance)", async () => {
    const { selectTasks } = await import("../../src/scheduler/scheduler.js");

    const tasks = [
      {
        id: "t_lastchance",
        title: "Last attempt",
        status: "pending" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "final try",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        // current_attempt is 1-indexed: this is the 3rd attempt, still within max_attempts=3
        current_attempt: 3,
      },
    ];

    const selected = selectTasks(tasks, { maxConcurrency: 4, runningCount: 0 });
    expect(selected.map((t) => t.id)).toContain("t_lastchance");
  });
});
