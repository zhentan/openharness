import { describe, expect, it, vi } from "vitest";

describe("Phase 6: kernel crash handling and restart recovery", () => {
  it("writes diagnosable crash state with active task ids", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const writeCrashState = vi.fn(async () => undefined);
    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => []),
        updateStatus: vi.fn(async () => undefined),
      },
      writeCrashState,
    });

    const activeTasks = [
      { id: "t_running_1" },
      { id: "t_running_2" },
    ];

    await kernel.handleCrash(new Error("kernel exploded"), activeTasks);

    expect(writeCrashState).toHaveBeenCalledWith(
      expect.objectContaining({
        timestamp: expect.any(String),
        activeTaskIds: ["t_running_1", "t_running_2"],
        error: expect.objectContaining({
          message: "kernel exploded",
        }),
      }),
    );
  });

  it("requeues orphaned running tasks on startup and reaps live processes", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const runningTask = {
      id: "t_orphaned",
      title: "Orphaned task",
      status: "generator_running" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "test",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      crash_count: 0,
    };

    const updateStatus = vi.fn(async () => undefined);
    const terminateOrphanProcess = vi.fn(async () => undefined);
    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [runningTask]),
        updateStatus,
      },
      terminateOrphanProcess,
      isTaskProcessAlive: vi.fn(() => true),
      config: {
        maxConcurrency: 1,
        maxRecurringFixTasks: 3,
        poisonPillThreshold: 2,
      },
    });

    await kernel.reconcileStartupState();

    expect(terminateOrphanProcess).toHaveBeenCalledWith(expect.objectContaining({ id: "t_orphaned" }));
    expect(updateStatus).toHaveBeenCalledWith("t_orphaned", "retry_pending", {
      source: "kernel.reconcileStartupState",
      reason: "orphan_reaped",
      crashCount: 1,
    });
  });

  it("marks running tasks completed when startup finds a scoped completion signal", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const runningTask = {
      id: "t_completed",
      title: "Completed while kernel was down",
      status: "generator_running" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "test",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      crash_count: 0,
    };

    const updateStatus = vi.fn(async () => undefined);
    const terminateOrphanProcess = vi.fn(async () => undefined);
    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [runningTask]),
        updateStatus,
      },
      inspectStartupSignal: vi.fn(async () => ({
        status: "completed",
        metadata: { summary: "done" },
      } as const)),
      terminateOrphanProcess,
      isTaskProcessAlive: vi.fn(() => true),
    });

    await kernel.reconcileStartupState();

    expect(updateStatus).toHaveBeenCalledWith("t_completed", "completed", {
      source: "kernel.reconcileStartupState",
      summary: "done",
    });
    expect(terminateOrphanProcess).not.toHaveBeenCalled();
  });

  it("escalates immediately when startup finds conflicting scoped signals", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const runningTask = {
      id: "t_conflict",
      title: "Conflicting signals",
      status: "evaluator_running" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "test",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      crash_count: 0,
    };

    const updateStatus = vi.fn(async () => undefined);
    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [runningTask]),
        updateStatus,
      },
      inspectStartupSignal: vi.fn(async () => ({
        status: "escalated",
        reason: "conflicting_signals",
      } as const)),
      isTaskProcessAlive: vi.fn(() => true),
    });

    await kernel.reconcileStartupState();

    expect(updateStatus).toHaveBeenCalledWith("t_conflict", "escalated", {
      source: "kernel.reconcileStartupState",
      reason: "conflicting_signals",
    });
  });

  it("escalates running tasks as poison pills when crash_count exceeds threshold", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const runningTask = {
      id: "t_poison",
      title: "Poison pill",
      status: "evaluator_running" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "test",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      crash_count: 2,
    };

    const updateStatus = vi.fn(async () => undefined);
    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [runningTask]),
        updateStatus,
      },
      isTaskProcessAlive: vi.fn(() => false),
      config: {
        maxConcurrency: 1,
        maxRecurringFixTasks: 3,
        poisonPillThreshold: 2,
      },
    });

    await kernel.reconcileStartupState();

    expect(updateStatus).toHaveBeenCalledWith("t_poison", "escalated", {
      source: "kernel.reconcileStartupState",
      reason: "poison_pill",
      crashCount: 3,
      threshold: 2,
    });
  });
});