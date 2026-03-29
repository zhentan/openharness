import { describe, expect, it, vi } from "vitest";

describe("Phase 6: harvest recurring follow-up tasks", () => {
  it("persists a recurring follow-up task when it is under quota and not a duplicate", async () => {
    const { harvestRecurringFixTasks } = await import("../../src/harvest.js");

    const createTask = vi.fn(async () => undefined);
    const existingTasks = [
      {
        id: "t_audit_root",
        title: "Recurring audit",
        status: "merged" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "audit",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        recurring: true,
      },
    ];

    const candidates = [
      {
        id: "t_audit_fix_1",
        source_task_id: "t_audit_root",
        title: "Fix flaky eval",
        status: "pending" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "Fix flaky eval",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
      },
    ];

    const created = await harvestRecurringFixTasks({
      candidates,
      existingTasks,
      maxRecurringFixTasks: 3,
      store: { createTask },
    });

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ id: "t_audit_fix_1" }));
    expect(created.map((task) => task.id)).toEqual(["t_audit_fix_1"]);
  });

  it("skips a duplicate non-terminal recurring follow-up task for the same source and normalized title", async () => {
    const { harvestRecurringFixTasks } = await import("../../src/harvest.js");

    const createTask = vi.fn(async () => undefined);
    const existingTasks = [
      {
        id: "t_audit_root",
        title: "Recurring audit",
        status: "merged" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "audit",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        recurring: true,
      },
      {
        id: "t_audit_fix_existing",
        source_task_id: "t_audit_root",
        title: "Fix flaky eval",
        status: "retry_pending" as const,
        priority: "medium" as const,
        depends_on: [],
        agent_prompt: "Fix flaky eval",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
      },
    ];

    const candidates = [
      {
        id: "t_audit_fix_new",
        source_task_id: "t_audit_root",
        title: "  fix   flaky eval  ",
        status: "pending" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "Fix flaky eval",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
      },
    ];

    const created = await harvestRecurringFixTasks({
      candidates,
      existingTasks,
      maxRecurringFixTasks: 3,
      store: { createTask },
    });

    expect(createTask).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it("enforces the per-source recurring follow-up quota across a harvest batch", async () => {
    const { harvestRecurringFixTasks } = await import("../../src/harvest.js");

    const createTask = vi.fn(async () => undefined);
    const existingTasks = [
      {
        id: "t_audit_root",
        title: "Recurring audit",
        status: "merged" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "audit",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        recurring: true,
      },
      {
        id: "t_existing_pending",
        source_task_id: "t_audit_root",
        title: "Fix parser drift",
        status: "pending" as const,
        priority: "medium" as const,
        depends_on: [],
        agent_prompt: "Fix parser drift",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
      },
    ];

    const candidates = [
      {
        id: "t_audit_fix_2",
        source_task_id: "t_audit_root",
        title: "Fix flaky eval",
        status: "pending" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "Fix flaky eval",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
      },
      {
        id: "t_audit_fix_3",
        source_task_id: "t_audit_root",
        title: "Fix timeout budget",
        status: "pending" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "Fix timeout budget",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
      },
    ];

    const created = await harvestRecurringFixTasks({
      candidates,
      existingTasks,
      maxRecurringFixTasks: 2,
      store: { createTask },
    });

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ id: "t_audit_fix_2" }));
    expect(created.map((task) => task.id)).toEqual(["t_audit_fix_2"]);
  });
});