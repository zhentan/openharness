import { describe, expect, it } from "vitest";

describe("Phase 6: recurring dedupe and quota (H12)", () => {
  it("uses the root task id as the recurring source when no explicit source is set", async () => {
    const { getRecurringSourceTaskId } = (await import("../../src/scheduler/scheduler.js")) as {
      getRecurringSourceTaskId?: (task: { id: string; source_task_id?: string }) => string;
    };

    const recurringRoot = {
      id: "t_audit_root",
      title: "Recurring audit",
      recurring: true,
    };

    expect(getRecurringSourceTaskId?.(recurringRoot)).toBe("t_audit_root");
  });

  it("inherits source_task_id for recurring follow-up tasks", async () => {
    const { getRecurringSourceTaskId } = (await import("../../src/scheduler/scheduler.js")) as {
      getRecurringSourceTaskId?: (task: { id: string; source_task_id?: string }) => string;
    };

    const followUpTask = {
      id: "t_audit_fix_2",
      title: "Fix flaky eval",
      source_task_id: "t_audit_root",
    };

    expect(getRecurringSourceTaskId?.(followUpTask)).toBe("t_audit_root");
  });

  it("blocks a duplicate non-terminal recurring fix task for the same source and normalized title", async () => {
    const { canSpawnRecurringFixTask } = (await import("../../src/scheduler/scheduler.js")) as {
      canSpawnRecurringFixTask?: (
        candidate: { id: string; title: string; source_task_id?: string },
        tasks: Array<{ id: string; title: string; status: string; source_task_id?: string }>,
        maxRecurringFixTasks: number,
      ) => boolean;
    };

    const tasks = [
      {
        id: "t_audit_root",
        title: "Recurring audit",
        status: "merged",
      },
      {
        id: "t_fix_1",
        title: "Fix flaky eval",
        status: "pending",
        source_task_id: "t_audit_root",
      },
    ];

    const candidate = {
      id: "t_fix_2",
      title: "  fix   flaky eval  ",
      source_task_id: "t_audit_root",
    };

    expect(canSpawnRecurringFixTask?.(candidate, tasks, 3)).toBe(false);
  });

  it("counts only non-terminal follow-up tasks against the per-source recurring quota", async () => {
    const { canSpawnRecurringFixTask } = (await import("../../src/scheduler/scheduler.js")) as {
      canSpawnRecurringFixTask?: (
        candidate: { id: string; title: string; source_task_id?: string },
        tasks: Array<{ id: string; title: string; status: string; source_task_id?: string }>,
        maxRecurringFixTasks: number,
      ) => boolean;
    };

    const tasks = [
      {
        id: "t_audit_root",
        title: "Recurring audit",
        status: "merged",
      },
      {
        id: "t_fix_pending",
        title: "Fix parser drift",
        status: "pending",
        source_task_id: "t_audit_root",
      },
      {
        id: "t_fix_retry",
        title: "Fix evaluator timeout",
        status: "retry_pending",
        source_task_id: "t_audit_root",
      },
      {
        id: "t_fix_completed",
        title: "Fix lint regression",
        status: "completed",
        source_task_id: "t_audit_root",
      },
      {
        id: "t_fix_merged",
        title: "Fix stale prompt",
        status: "merged",
        source_task_id: "t_audit_root",
      },
      {
        id: "t_fix_escalated",
        title: "Fix broken repo state",
        status: "escalated",
        source_task_id: "t_audit_root",
      },
    ];

    const candidate = {
      id: "t_fix_new",
      title: "Fix test order",
      source_task_id: "t_audit_root",
    };

    expect(canSpawnRecurringFixTask?.(candidate, tasks, 3)).toBe(false);
    expect(canSpawnRecurringFixTask?.(candidate, tasks, 4)).toBe(true);
  });
});