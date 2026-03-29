/**
 * Phase 6: kernel tick loop
 *
 * First bounded slice: serial merge and recurring requeue wiring.
 */
import { describe, expect, it, vi } from "vitest";

describe("Phase 6: kernel tick", () => {
  it("skips a tick when the previous tick is still running", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    let resolveList: (() => void) | undefined;
    const listBarrier = new Promise<void>((resolve) => {
      resolveList = resolve;
    });

    const list = vi.fn(async () => {
      await listBarrier;
      return [];
    });

    const kernel = new Kernel({
      store: {
        list,
        updateStatus: vi.fn(async () => undefined),
      },
    });

    const firstTick = kernel.tick();
    await Promise.resolve();

    await kernel.tick();

    expect(list).toHaveBeenCalledTimes(1);

    resolveList?.();
    await firstTick;
  });

  it("dispatches schedulable tasks through the supervisor up to maxConcurrency", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const spawnAgent = vi.fn(async () => undefined);
    const highPriorityTask = {
      id: "t_dispatch_high",
      title: "High priority task",
      status: "pending" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "do the important thing",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      enqueued_at: new Date(Date.now() - 60_000).toISOString(),
    };
    const lowPriorityTask = {
      id: "t_dispatch_low",
      title: "Low priority task",
      status: "pending" as const,
      priority: "low" as const,
      depends_on: [],
      agent_prompt: "do the less important thing",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      enqueued_at: new Date().toISOString(),
    };

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [lowPriorityTask, highPriorityTask]),
        updateStatus: vi.fn(async () => undefined),
      },
      config: {
        maxConcurrency: 1,
      },
      supervisor: {
        spawnAgent,
      },
    });

    await kernel.tick();

    expect(spawnAgent).toHaveBeenCalledTimes(1);
    expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ id: "t_dispatch_high" }));
  });

  it("does not dispatch new tasks when active work already fills maxConcurrency", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const spawnAgent = vi.fn(async () => undefined);
    const runningTask = {
      id: "t_already_running",
      title: "Already running",
      status: "generator_running" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "running",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    };
    const pendingTask = {
      id: "t_waiting",
      title: "Waiting for capacity",
      status: "pending" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "wait",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    };

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [runningTask, pendingTask]),
        updateStatus: vi.fn(async () => undefined),
      },
      config: {
        maxConcurrency: 1,
      },
      supervisor: {
        spawnAgent,
      },
    });

    await kernel.tick();

    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("does not count revisions_requested as running capacity when supervisor lacks getRunningCount", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const spawnAgent = vi.fn(async () => undefined);
    const revisionTask = {
      id: "t_revision_waiting",
      title: "Waiting for revision",
      status: "revisions_requested" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "revise",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    };
    const pendingTask = {
      id: "t_dispatch_after_revision",
      title: "Dispatchable task",
      status: "pending" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "run now",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    };

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [revisionTask, pendingTask]),
        updateStatus: vi.fn(async () => undefined),
      },
      config: {
        maxConcurrency: 1,
      },
      supervisor: {
        spawnAgent,
      },
    });

    await kernel.tick();

    expect(spawnAgent).toHaveBeenCalledTimes(1);
    expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ id: "t_dispatch_after_revision" }));
  });

  it("respects scheduler cooldown checks before dispatching retry_pending tasks", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const spawnAgent = vi.fn(async () => undefined);
    const coolingTask = {
      id: "t_cooling",
      title: "Cooling down",
      status: "retry_pending" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "retry later",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      cooldown_until: new Date(Date.now() + 60_000).toISOString(),
    };

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [coolingTask]),
        updateStatus: vi.fn(async () => undefined),
      },
      config: {
        maxConcurrency: 1,
      },
      supervisor: {
        spawnAgent,
      },
    });

    await kernel.tick();

    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("runs worktree GC after recurring processing and before dispatch", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const events: string[] = [];
    const updateStatus = vi.fn(async (taskId: string, status: string) => {
      if (taskId === "t_recurring_gc" && status === "pending") {
        events.push("recurring");
      }
    });
    const gcWorktrees = vi.fn(async (tasks: Array<{ id: string }>, mergeQueuedTaskIds: string[]) => {
      events.push(`gc:${mergeQueuedTaskIds.join(",")}`);
      expect(tasks.map((task) => task.id)).toContain("t_recurring_gc");
    });
    const spawnAgent = vi.fn(async () => {
      events.push("dispatch");
    });

    const recurringTask = {
      id: "t_recurring_gc",
      title: "Recurring task",
      status: "merged" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "audit",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      recurring: true,
      recurring_interval_hours: 0,
      completed_at: new Date(Date.now() - 60_000).toISOString(),
    };
    const mergeReadyTask = {
      id: "t_merge_queue",
      title: "Ready to merge",
      status: "completed" as const,
      priority: "medium" as const,
      depends_on: [],
      agent_prompt: "merge me",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    };

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [recurringTask, mergeReadyTask]),
        updateStatus,
      },
      scheduler: {
        findMergeReady: vi.fn(() => [mergeReadyTask]),
      },
      gcWorktrees,
      supervisor: {
        spawnAgent,
      },
      config: {
        maxConcurrency: 1,
      },
    });

    await kernel.tick();

    expect(gcWorktrees).toHaveBeenCalledWith(expect.any(Array), ["t_merge_queue"]);
    expect(events).toEqual(["recurring", "gc:t_merge_queue", "dispatch"]);
  });

  it("escalates pending tasks that already exceeded max_attempts before later tick phases run", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const updateStatus = vi.fn(async () => undefined);
    const mergeWorktreeToMain = vi.fn(async () => ({ nextStatus: "merged" as const }));
    const exhaustedTask = {
      id: "t_exhausted_attempts",
      title: "Attempt budget exhausted",
      status: "pending" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "test",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      current_attempt: 4,
      previous_attempts: [
        { attempt: 1, reason: "timed_out" as const, duration_ms: 5 * 60_000 },
        { attempt: 2, reason: "timed_out" as const, duration_ms: 5 * 60_000 },
        { attempt: 3, reason: "timed_out" as const, duration_ms: 5 * 60_000 },
      ],
    };

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [exhaustedTask]),
        updateStatus,
      },
      scheduler: {
        findMergeReady: vi.fn(() => [exhaustedTask]),
      },
      mergeWorktreeToMain,
    });

    await kernel.tick();

    expect(updateStatus).toHaveBeenCalledWith("t_exhausted_attempts", "escalated", {
      source: "kernel.processExhaustedTasks",
      reason: "max_attempts_exhausted",
      currentAttempt: 4,
      maxAttempts: 3,
    });
    expect(mergeWorktreeToMain).not.toHaveBeenCalled();
  });

  it("escalates retry_pending tasks that already exceeded total_timeout before later tick phases run", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const updateStatus = vi.fn(async () => undefined);
    const retryTask = {
      id: "t_exhausted_time",
      title: "Time budget exhausted",
      status: "retry_pending" as const,
      priority: "medium" as const,
      depends_on: [],
      agent_prompt: "retry",
      exploration_budget: { max_attempts: 10, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      current_attempt: 3,
      previous_attempts: [
        { attempt: 1, reason: "timed_out" as const, duration_ms: 20 * 60_000 },
        { attempt: 2, reason: "eval_timed_out" as const, duration_ms: 30 * 60_000 },
      ],
    };

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [retryTask]),
        updateStatus,
      },
      scheduler: {
        findMergeReady: vi.fn(() => []),
      },
    });

    await kernel.tick();

    expect(updateStatus).toHaveBeenCalledWith("t_exhausted_time", "escalated", {
      source: "kernel.processExhaustedTasks",
      reason: "total_timeout_exhausted",
      cumulativeDurationMs: 50 * 60_000,
      totalTimeoutMs: 45 * 60_000,
    });
  });

  it("merges at most one ready task per tick", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const mergeWorktreeToMain = vi.fn(async () => ({ nextStatus: "merged" as const }));
    const updateStatus = vi.fn(async () => undefined);
    const tasks = [
      {
        id: "t_ready_1",
        title: "Ready 1",
        status: "completed" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "test",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
      },
      {
        id: "t_ready_2",
        title: "Ready 2",
        status: "completed" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "test",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
      },
    ];

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => tasks),
        updateStatus,
      },
      scheduler: {
        findMergeReady: vi.fn(() => tasks),
      },
      mergeWorktreeToMain,
    });

    await kernel.tick();

    expect(mergeWorktreeToMain).toHaveBeenCalledTimes(1);
    expect(mergeWorktreeToMain).toHaveBeenCalledWith(expect.objectContaining({ id: "t_ready_1" }));
  });

  it("marks a merged task as merged even when the merge helper returns no explicit nextStatus", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const mergeWorktreeToMain = vi.fn(async () => undefined);
    const updateStatus = vi.fn(async () => undefined);
    const task = {
      id: "t_merge_default_status",
      title: "Merge default status",
      status: "completed" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "test",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    };

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [task]),
        updateStatus,
      },
      scheduler: {
        findMergeReady: vi.fn(() => [task]),
      },
      mergeWorktreeToMain,
    });

    await kernel.tick();

    expect(updateStatus).toHaveBeenCalledWith("t_merge_default_status", "merged", {
      source: "kernel.processMergeQueue",
    });
  });

  it("fails closed when the default kernel merge path has no real merge implementation", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const updateStatus = vi.fn(async () => undefined);
    const task = {
      id: "t_missing_merge_impl",
      title: "Missing merge implementation",
      status: "completed" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "test",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    };

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [task]),
        updateStatus,
      },
      scheduler: {
        findMergeReady: vi.fn(() => [task]),
      },
    });

    await kernel.tick();

    expect(updateStatus).toHaveBeenCalledWith("t_missing_merge_impl", "escalated", {
      source: "kernel.processMergeQueue",
      error: expect.stringMatching(/no merge implementation configured/i),
    });
  });

  it("re-queues recurring tasks that become merged earlier in the same tick", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const recurringTask = {
      id: "t_recurring_same_tick",
      title: "Recurring same tick",
      status: "completed" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "audit",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      recurring: true,
      recurring_interval_hours: 0,
      completed_at: new Date(Date.now() - 60_000).toISOString(),
    };
    const updateStatus = vi.fn(async () => undefined);

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [recurringTask]),
        updateStatus,
      },
      scheduler: {
        findMergeReady: vi.fn(() => [recurringTask]),
      },
      mergeWorktreeToMain: vi.fn(async () => ({ nextStatus: "merged" as const })),
    });

    await kernel.tick();

    expect(updateStatus).toHaveBeenNthCalledWith(1, "t_recurring_same_tick", "merged", {
      source: "kernel.processMergeQueue",
    });
    expect(updateStatus).toHaveBeenNthCalledWith(2, "t_recurring_same_tick", "pending", {
      source: "kernel.processRecurringTasks",
      recurring: true,
    });
  });

  it("transitions a merge failure to retry_pending when the merge helper signals attempts remain", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const mergeError = Object.assign(new Error("tests failed"), {
      nextStatus: "retry_pending" as const,
    });
    const mergeWorktreeToMain = vi.fn(async () => {
      throw mergeError;
    });
    const updateStatus = vi.fn(async () => undefined);
    const task = {
      id: "t_merge_retry",
      title: "Merge retry",
      status: "completed" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "test",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    };

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [task]),
        updateStatus,
      },
      scheduler: {
        findMergeReady: vi.fn(() => [task]),
      },
      mergeWorktreeToMain,
    });

    await kernel.tick();

    expect(updateStatus).toHaveBeenCalledWith("t_merge_retry", "retry_pending", {
      source: "kernel.processMergeQueue",
      error: "tests failed",
    });
  });

  it("transitions a merge failure to escalated when the merge helper signals budget exhaustion", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const mergeError = Object.assign(new Error("tests failed"), {
      nextStatus: "escalated" as const,
    });
    const mergeWorktreeToMain = vi.fn(async () => {
      throw mergeError;
    });
    const updateStatus = vi.fn(async () => undefined);
    const task = {
      id: "t_merge_escalated",
      title: "Merge escalated",
      status: "completed" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "test",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    };

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [task]),
        updateStatus,
      },
      scheduler: {
        findMergeReady: vi.fn(() => [task]),
      },
      mergeWorktreeToMain,
    });

    await kernel.tick();

    expect(updateStatus).toHaveBeenCalledWith("t_merge_escalated", "escalated", {
      source: "kernel.processMergeQueue",
      error: "tests failed",
    });
  });

  it("cascades escalations to pending tasks blocked by escalated dependencies", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const updateStatus = vi.fn(async () => undefined);
    const tasks = [
      {
        id: "t_escalated",
        title: "Escalated dep",
        status: "escalated" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "blocked",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
      },
      {
        id: "t_blocked",
        title: "Blocked task",
        status: "pending" as const,
        priority: "medium" as const,
        depends_on: ["t_escalated"],
        agent_prompt: "work",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
      },
    ];

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => tasks),
        updateStatus,
      },
    });

    await kernel.tick();

    expect(updateStatus).toHaveBeenCalledWith("t_blocked", "escalated", {
      source: "kernel.processCascadedEscalations",
      blockedBy: "t_escalated",
    });
  });

  it("keeps cascading until transitive dependency chains are escalated in the same tick", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const tasks = [
      {
        id: "t_root_escalated",
        title: "Root escalated",
        status: "escalated" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "root",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
      },
      {
        id: "t_mid",
        title: "Middle task",
        status: "pending" as const,
        priority: "medium" as const,
        depends_on: ["t_root_escalated"],
        agent_prompt: "mid",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
      },
      {
        id: "t_leaf",
        title: "Leaf task",
        status: "pending" as const,
        priority: "low" as const,
        depends_on: ["t_mid"],
        agent_prompt: "leaf",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
      },
    ];

    const updateStatus = vi.fn(async (taskId: string, status: string) => {
      const task = tasks.find((entry) => entry.id === taskId);
      if (task) {
        Object.assign(task, { status });
      }
    });

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => tasks),
        updateStatus,
      },
    });

    await kernel.tick();

    expect(updateStatus).toHaveBeenCalledWith("t_mid", "escalated", {
      source: "kernel.processCascadedEscalations",
      blockedBy: "t_root_escalated",
    });
    expect(updateStatus).toHaveBeenCalledWith("t_leaf", "escalated", {
      source: "kernel.processCascadedEscalations",
      blockedBy: "t_mid",
    });
  });

  it("fails closed when cascaded escalation does not converge within the safety bound", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const stubbornTask = {
      id: "t_stubborn",
      title: "Stubborn cascade",
      status: "pending" as const,
      priority: "medium" as const,
      depends_on: ["t_escalated"],
      agent_prompt: "stubborn",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    };
    const tasks = [
      {
        id: "t_escalated",
        title: "Escalated dep",
        status: "escalated" as const,
        priority: "high" as const,
        depends_on: [],
        agent_prompt: "root",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
      },
      stubbornTask,
    ];

    const updateStatus = vi.fn(async () => undefined);
    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => tasks),
        updateStatus,
      },
      scheduler: {
        findCascadedEscalations: vi.fn(() => [stubbornTask]),
        findMergeReady: vi.fn(() => []),
      },
    });

    await expect(kernel.tick()).rejects.toThrow(/cascade escalation did not converge/i);
  });

  it("re-queues recurring merged tasks after cooldown expires", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const updateStatus = vi.fn(async () => undefined);
    const recurringTask = {
      id: "t_recurring",
      title: "Recurring task",
      status: "merged" as const,
      priority: "medium" as const,
      depends_on: [],
      agent_prompt: "audit",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      recurring: true,
      recurring_interval_hours: 1,
      completed_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    };

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [recurringTask]),
        updateStatus,
      },
      scheduler: {
        findMergeReady: vi.fn(() => []),
      },
    });

    await kernel.tick();

    expect(updateStatus).toHaveBeenCalledWith("t_recurring", "pending", {
      source: "kernel.processRecurringTasks",
      recurring: true,
    });
  });

  it("does not re-queue recurring tasks that are completed but not yet merged", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const updateStatus = vi.fn(async () => undefined);
    const completedRecurringTask = {
      id: "t_completed_not_merged",
      title: "Completed but not merged",
      status: "completed" as const,
      priority: "medium" as const,
      depends_on: [],
      agent_prompt: "audit",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      recurring: true,
      recurring_interval_hours: 1,
      completed_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    };

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [completedRecurringTask]),
        updateStatus,
      },
      scheduler: {
        findMergeReady: vi.fn(() => []),
      },
    });

    await kernel.tick();

    expect(updateStatus).not.toHaveBeenCalledWith("t_completed_not_merged", "pending", expect.anything());
  });

  it("re-queues the recurring source task even when follow-up creation support exists on the store", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const updateStatus = vi.fn(async () => undefined);
    const createTask = vi.fn(async () => undefined);
    const recurringTask = {
      id: "t_recurring_root",
      title: "Recurring audit",
      status: "merged" as const,
      priority: "medium" as const,
      depends_on: [],
      agent_prompt: "audit",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      recurring: true,
      recurring_interval_hours: 1,
      completed_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    };

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [recurringTask]),
        updateStatus,
        createTask,
      },
      scheduler: {
        findMergeReady: vi.fn(() => []),
      },
      config: {
        maxRecurringFixTasks: 3,
      },
    });

    await kernel.tick();

    expect(updateStatus).toHaveBeenCalledWith("t_recurring_root", "pending", {
      source: "kernel.processRecurringTasks",
      recurring: true,
    });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("re-queues the recurring source task even when related follow-up tasks already exist", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const updateStatus = vi.fn(async () => undefined);
    const createTask = vi.fn(async () => undefined);
    const recurringTask = {
      id: "t_recurring_root",
      title: "Recurring audit",
      status: "merged" as const,
      priority: "medium" as const,
      depends_on: [],
      agent_prompt: "audit",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      recurring: true,
      recurring_interval_hours: 1,
      completed_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    };
    const existingFollowUp = {
      id: "t_recurring_fix_1",
      source_task_id: "t_recurring_root",
      title: "Recurring audit",
      status: "retry_pending" as const,
      priority: "medium" as const,
      depends_on: [],
      agent_prompt: "fix",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    };

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [recurringTask, existingFollowUp]),
        updateStatus,
        createTask,
      },
      scheduler: {
        findMergeReady: vi.fn(() => []),
      },
      config: {
        maxRecurringFixTasks: 3,
      },
    });

    await kernel.tick();

    expect(updateStatus).toHaveBeenCalledWith("t_recurring_root", "pending", {
      source: "kernel.processRecurringTasks",
      recurring: true,
    });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("harvests recurring follow-up candidates after recurring re-queue when createTask support is available", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const updateStatus = vi.fn(async () => undefined);
    const createTask = vi.fn(async () => undefined);
    const recurringTask = {
      id: "t_recurring_root",
      title: "Recurring audit",
      status: "merged" as const,
      priority: "medium" as const,
      depends_on: [],
      agent_prompt: "audit",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      recurring: true,
      recurring_interval_hours: 1,
      completed_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    };
    const harvestedCandidate = {
      id: "t_recurring_fix_1",
      source_task_id: "t_recurring_root",
      title: "Fix flaky eval",
      status: "pending" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "Fix flaky eval",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    };

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [recurringTask]),
        updateStatus,
        createTask,
      },
      scheduler: {
        findMergeReady: vi.fn(() => []),
      },
      config: {
        maxRecurringFixTasks: 3,
      },
      harvestCandidates: vi.fn(async () => [harvestedCandidate]),
    });

    await kernel.tick();

    expect(updateStatus).toHaveBeenCalledWith("t_recurring_root", "pending", {
      source: "kernel.processRecurringTasks",
      recurring: true,
    });
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      id: "t_recurring_fix_1",
      source_task_id: "t_recurring_root",
    }));
  });

  it("skips harvested recurring follow-up candidates that are duplicates of existing open tasks", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const updateStatus = vi.fn(async () => undefined);
    const createTask = vi.fn(async () => undefined);
    const recurringTask = {
      id: "t_recurring_root",
      title: "Recurring audit",
      status: "merged" as const,
      priority: "medium" as const,
      depends_on: [],
      agent_prompt: "audit",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      recurring: true,
      recurring_interval_hours: 1,
      completed_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    };
    const existingFollowUp = {
      id: "t_recurring_fix_existing",
      source_task_id: "t_recurring_root",
      title: "Fix flaky eval",
      status: "retry_pending" as const,
      priority: "medium" as const,
      depends_on: [],
      agent_prompt: "Fix flaky eval",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    };
    const duplicateCandidate = {
      id: "t_recurring_fix_new",
      source_task_id: "t_recurring_root",
      title: "  fix   flaky eval  ",
      status: "pending" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "Fix flaky eval",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    };

    const kernel = new Kernel({
      store: {
        list: vi.fn(async () => [recurringTask, existingFollowUp]),
        updateStatus,
        createTask,
      },
      scheduler: {
        findMergeReady: vi.fn(() => []),
      },
      config: {
        maxRecurringFixTasks: 3,
      },
      harvestCandidates: vi.fn(async () => [duplicateCandidate]),
    });

    await kernel.tick();

    expect(createTask).not.toHaveBeenCalled();
  });
});
