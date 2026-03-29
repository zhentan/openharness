import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../src/types.js";

describe("Phase 7: runtime state hub", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-28T01:00:30.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a snapshot from lean task summaries", async () => {
    const { createRuntimeStateHub } = await import("../../src/server/runtime-state-hub.js");

    const hub = createRuntimeStateHub();
    const snapshot = hub.createSnapshot([
      createTask({
        id: "task_1",
        status: "generator_running",
        previous_attempts: [{ attempt: 1, reason: "timed_out" }],
        assigned_at: "2026-03-28T01:00:00.000Z",
      }),
    ]);

    expect(snapshot.type).toBe("snapshot");
    expect(snapshot.sequence).toBe(0);
    expect(snapshot.counts.generator_running).toBe(1);
    expect(snapshot.tasks).toEqual([
      {
        taskId: "task_1",
        title: "Task task_1",
        status: "generator_running",
        updatedAt: "2026-03-28T01:00:00.000Z",
        runHealth: "active",
        transitionReason: "timed_out",
      },
    ]);
  });

  it("batches repeated updates for the same task into the latest summary", async () => {
    const { createRuntimeStateHub } = await import("../../src/server/runtime-state-hub.js");

    const hub = createRuntimeStateHub({ batchMs: 50 });
    const messages: unknown[] = [];
    hub.subscribe((message) => {
      messages.push(message);
    });

    // E8: subscribe always sends an empty snapshot first
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({ type: "snapshot", tasks: [] }));

    hub.queueTaskUpdate(createTask({ id: "task_1", status: "pending" }), {
      updatedAt: "2026-03-28T01:00:00.000Z",
    });
    hub.queueTaskUpdate(createTask({ id: "task_1", status: "reserved" }), {
      updatedAt: "2026-03-28T01:00:01.000Z",
    });
    hub.queueTaskUpdate(createTask({ id: "task_1", status: "generator_running" }), {
      updatedAt: "2026-03-28T01:00:02.000Z",
    });

    expect(messages).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(50);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({
      type: "task-summaries-updated",
      sequence: 1,
      summaries: [
        {
          taskId: "task_1",
          title: "Task task_1",
          status: "generator_running",
          updatedAt: "2026-03-28T01:00:02.000Z",
          runHealth: "active",
          transitionReason: undefined,
        },
      ],
    });
  });

  it("records recent task output in summaries", async () => {
    const { createRuntimeStateHub } = await import("../../src/server/runtime-state-hub.js");

    const hub = createRuntimeStateHub({ batchMs: 50 });
    const messages: unknown[] = [];
    hub.subscribe((message) => {
      messages.push(message);
    });

    // E8: empty snapshot sent immediately
    expect(messages).toHaveLength(1);

    hub.queueTaskUpdate(createTask({ id: "task_1", status: "generator_running" }), {
      updatedAt: "2026-03-28T01:00:00.000Z",
    });
    hub.noteTaskOutput("task_1", { outputAt: "2026-03-28T01:00:20.000Z" });

    await vi.advanceTimersByTimeAsync(50);

    expect(messages[1]).toEqual({
      type: "task-summaries-updated",
      sequence: 1,
      summaries: [
        {
          taskId: "task_1",
          title: "Task task_1",
          status: "generator_running",
          updatedAt: "2026-03-28T01:00:00.000Z",
          lastOutputAt: "2026-03-28T01:00:20.000Z",
          runHealth: "active",
          transitionReason: undefined,
        },
      ],
    });
  });

  it("marks long-silent running tasks as quiet after the threshold", async () => {
    const { createRuntimeStateHub } = await import("../../src/server/runtime-state-hub.js");

    const hub = createRuntimeStateHub({ batchMs: 50, quietAfterMs: 120_000 });
    const messages: unknown[] = [];
    hub.subscribe((message) => {
      messages.push(message);
    });

    // E8: empty snapshot first
    expect(messages).toHaveLength(1);

    hub.queueTaskUpdate(createTask({ id: "task_1", status: "generator_running" }), {
      updatedAt: "2026-03-28T01:00:00.000Z",
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(messages[1]).toEqual({
      type: "task-summaries-updated",
      sequence: 1,
      summaries: [
        {
          taskId: "task_1",
          title: "Task task_1",
          status: "generator_running",
          updatedAt: "2026-03-28T01:00:00.000Z",
          runHealth: "active",
          transitionReason: undefined,
        },
      ],
    });

    await vi.advanceTimersByTimeAsync(89_000);
    expect(messages).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(messages[2]).toEqual({
      type: "task-summaries-updated",
      sequence: 2,
      summaries: [
        {
          taskId: "task_1",
          title: "Task task_1",
          status: "generator_running",
          updatedAt: "2026-03-28T01:00:00.000Z",
          runHealth: "quiet",
          transitionReason: undefined,
        },
      ],
    });
  });

  it("flushes terminal task states immediately", async () => {
    const { createRuntimeStateHub } = await import("../../src/server/runtime-state-hub.js");

    const hub = createRuntimeStateHub({ batchMs: 50 });
    const messages: unknown[] = [];
    hub.subscribe((message) => {
      messages.push(message);
    });

    // E8: empty snapshot first
    expect(messages).toHaveLength(1);

    hub.queueTaskUpdate(
      createTask({
        id: "task_1",
        status: "escalated",
        previous_attempts: [{ attempt: 1, reason: "fatal_unknown" }],
      }),
      { updatedAt: "2026-03-28T01:00:03.000Z" },
    );

    expect(messages[1]).toEqual({
      type: "task-summaries-updated",
      sequence: 1,
      summaries: [
        {
          taskId: "task_1",
          title: "Task task_1",
          status: "escalated",
          updatedAt: "2026-03-28T01:00:03.000Z",
          transitionReason: "fatal_unknown",
        },
      ],
    });
  });

  it("sends a snapshot before later deltas to new subscribers and supports unsubscribe", async () => {
    const { createRuntimeStateHub } = await import("../../src/server/runtime-state-hub.js");

    const hub = createRuntimeStateHub({ batchMs: 50 });
    const messages: unknown[] = [];
    const unsubscribe = hub.subscribe(
      (message) => {
        messages.push(message);
      },
      [createTask({ id: "task_1", status: "pending", enqueued_at: "2026-03-28T01:00:00.000Z" })],
    );

    hub.queueTaskUpdate(createTask({ id: "task_1", status: "reserved" }), {
      updatedAt: "2026-03-28T01:00:01.000Z",
    });
    await vi.advanceTimersByTimeAsync(50);

    unsubscribe();
    unsubscribe();

    hub.queueTaskUpdate(createTask({ id: "task_1", status: "generator_running" }), {
      updatedAt: "2026-03-28T01:00:02.000Z",
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(messages).toEqual([
      {
        type: "snapshot",
        sequence: 0,
        counts: {
          pending: 1,
          reserved: 0,
          pre_eval: 0,
          generator_running: 0,
          evaluator_running: 0,
          revisions_requested: 0,
          completed: 0,
          merge_pending: 0,
          merged: 0,
          paused: 0,
          retry_pending: 0,
          escalated: 0,
        },
        tasks: [
          {
            taskId: "task_1",
            title: "Task task_1",
            status: "pending",
            updatedAt: "2026-03-28T01:00:00.000Z",
            transitionReason: undefined,
          },
        ],
      },
      {
        type: "task-summaries-updated",
        sequence: 1,
        summaries: [
          {
            taskId: "task_1",
            title: "Task task_1",
            status: "reserved",
            updatedAt: "2026-03-28T01:00:01.000Z",
            transitionReason: undefined,
          },
        ],
      },
    ]);
  });
});

function createTask(overrides: Partial<Task> & Pick<Task, "id" | "status">): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? `Task ${overrides.id}`,
    status: overrides.status,
    priority: overrides.priority ?? "medium",
    depends_on: overrides.depends_on ?? [],
    agent_prompt: overrides.agent_prompt ?? "Do the thing",
    exploration_budget: overrides.exploration_budget ?? {
      max_attempts: 3,
      timeout_per_attempt: 15,
      total_timeout: 60,
    },
    escalation_rules: overrides.escalation_rules ?? [],
    previous_attempts: overrides.previous_attempts,
    enqueued_at: overrides.enqueued_at,
    assigned_at: overrides.assigned_at,
    completed_at: overrides.completed_at,
    cooldown_until: overrides.cooldown_until,
    current_attempt: overrides.current_attempt,
    crash_count: overrides.crash_count,
  };
}
