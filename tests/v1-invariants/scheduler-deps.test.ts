/**
 * P13: Dependency resolution in scheduling
 * P14: Cascaded escalation detection
 *
 * v1 proof: src/scheduler/scheduler.ts:26-29 (deps), :62-71 (cascade)
 * Phase gate: 2
 *
 * Tasks only become eligible when all depends_on are completed or merged.
 * If a dependency is escalated, the dependent task must also escalate
 * (cascaded escalation) — it can never be satisfied.
 */
import { describe, it, expect } from "vitest";

describe("P13: Dependency resolution", () => {
  it("blocks tasks whose dependencies are not completed/merged", async () => {
    const { selectTasks } = await import("../../src/scheduler/scheduler.js");

    const tasks = [
      {
        id: "t_dep",
        title: "Dependency",
        status: "generator_running" as const, // not completed yet
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "build foundation",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 1,
      },
      {
        id: "t_blocked",
        title: "Blocked by dependency",
        status: "pending" as const,
        priority: "high" as const,
        depends_on: ["t_dep"],
        agent_prompt: "build on foundation",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 1,
      },
    ];

    const selected = selectTasks(tasks, { maxConcurrency: 4, runningCount: 0 });
    expect(selected.map((t) => t.id)).not.toContain("t_blocked");
  });

  it("unblocks tasks when dependencies are completed", async () => {
    const { selectTasks } = await import("../../src/scheduler/scheduler.js");

    const tasks = [
      {
        id: "t_dep",
        title: "Dependency",
        status: "completed" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "build foundation",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 1,
      },
      {
        id: "t_ready",
        title: "Ready to run",
        status: "pending" as const,
        priority: "high" as const,
        depends_on: ["t_dep"],
        agent_prompt: "build on foundation",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 1,
      },
    ];

    const selected = selectTasks(tasks, { maxConcurrency: 4, runningCount: 0 });
    expect(selected.map((t) => t.id)).toContain("t_ready");
  });

  it("unblocks tasks when dependencies are merged", async () => {
    const { selectTasks } = await import("../../src/scheduler/scheduler.js");

    const tasks = [
      {
        id: "t_dep",
        title: "Dependency",
        status: "merged" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "build foundation",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 1,
      },
      {
        id: "t_ready",
        title: "Ready to run",
        status: "pending" as const,
        priority: "high" as const,
        depends_on: ["t_dep"],
        agent_prompt: "build on foundation",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 1,
      },
    ];

    const selected = selectTasks(tasks, { maxConcurrency: 4, runningCount: 0 });
    expect(selected.map((t) => t.id)).toContain("t_ready");
  });
});

describe("P14: Cascaded escalation", () => {
  it("detects pending tasks blocked by escalated dependencies", async () => {
    const { findCascadedEscalations } = await import("../../src/scheduler/scheduler.js");

    const tasks = [
      {
        id: "t_escalated",
        title: "Escalated dep",
        status: "escalated" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "impossible task",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 4,
      },
      {
        id: "t_cascade",
        title: "Should cascade",
        status: "pending" as const,
        priority: "high" as const,
        depends_on: ["t_escalated"],
        agent_prompt: "depends on escalated",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 1,
      },
      {
        id: "t_independent",
        title: "Not affected",
        status: "pending" as const,
        priority: "medium" as const,
        depends_on: [],
        agent_prompt: "independent work",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 1,
      },
    ];

    const cascaded = findCascadedEscalations(tasks);
    expect(cascaded.map((t) => t.id)).toContain("t_cascade");
    expect(cascaded.map((t) => t.id)).not.toContain("t_independent");
  });

  it("detects retry_pending tasks blocked by escalated dependencies", async () => {
    const { findCascadedEscalations } = await import("../../src/scheduler/scheduler.js");

    const tasks = [
      {
        id: "t_escalated",
        title: "Escalated dep",
        status: "escalated" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "impossible task",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 4,
      },
      {
        id: "t_retry",
        title: "Retrying task blocked by escalated dependency",
        status: "retry_pending" as const,
        priority: "medium" as const,
        depends_on: ["t_escalated"],
        agent_prompt: "retry after failure",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        current_attempt: 2,
      },
    ];

    const cascaded = findCascadedEscalations(tasks);
    expect(cascaded.map((t) => t.id)).toContain("t_retry");
  });
});
