import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Task } from "../../src/types.js";
import type { LogsResponse, RunLogSummary, TaskResponse } from "../../src/server/ipc-types.js";

/**
 * Phase 9: Runtime task-detail and historical-log contract tests.
 *
 * These tests implement the reviewer-mandated test intent from
 * docs/phase9/reviews/runtime-task-logs-detail.md (T6–T11).
 *
 * Tests are written BEFORE implementation per adversarial TDD rules.
 */
describe("Phase 9: task detail and log contract", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "oh-task-logs-detail-"));
    await mkdir(join(repoDir, ".openharness"), { recursive: true });
    await mkdir(join(repoDir, "tasks"), { recursive: true });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  // ─── T6: get-task returns full runtime state fields ───

  it("T6: get-task returns runtime-managed fields when set on the task", async () => {
    const { WsServer } = await import("../../src/server/ws-server.js");

    const tasks: Task[] = [
      createTask({
        id: "task_rt",
        status: "generator_running",
        current_attempt: 2,
        assigned_at: "2026-03-29T01:00:00.000Z",
        completed_at: "2026-03-29T02:00:00.000Z",
        crash_count: 1,
        cooldown_until: "2026-03-29T01:30:00.000Z",
        previous_attempts: [
          {
            attempt: 1,
            reason: "timed_out",
            duration_ms: 5000,
          },
        ],
      }),
    ];

    const server = new WsServer({ port: 0, listTasks: async () => tasks });
    try {
      await server.ready;
      const client = new WebSocket(server.url);
      await waitForOpen(client);

      client.send(JSON.stringify({ type: "get-task", taskId: "task_rt" }));
      const response = (await waitForMessage(client)) as TaskResponse;

      expect(response.type).toBe("task");
      expect(response.taskId).toBe("task_rt");
      expect(response.task).not.toBeNull();

      const task = response.task!;
      expect(task.current_attempt).toBe(2);
      expect(task.assigned_at).toBe("2026-03-29T01:00:00.000Z");
      expect(task.completed_at).toBe("2026-03-29T02:00:00.000Z");
      expect(task.crash_count).toBe(1);
      expect(task.cooldown_until).toBe("2026-03-29T01:30:00.000Z");
      expect(task.previous_attempts).toEqual([
        { attempt: 1, reason: "timed_out", duration_ms: 5000 },
      ]);

      client.close();
    } finally {
      await server.close();
    }
  });

  // ─── T7: get-logs returns all run entries in chronological order ───

  it("T7: get-logs returns all run entries sorted chronologically (earliest first)", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { sendRuntimeCommand } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "task_multi", status: "completed" }));

    // Create three runs with distinct timestamps — write out of order to test sort
    const runsDir = join(repoDir, "runs", "task_multi");
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, "2026-03-29T03:00:00.000Z.log"), "third run\n", "utf8");
    await writeFile(join(runsDir, "2026-03-29T01:00:00.000Z.log"), "first run\n", "utf8");
    await writeFile(join(runsDir, "2026-03-29T02:00:00.000Z.log"), "second run\n", "utf8");

    const runtime = await startRuntime(repoDir);
    try {
      const response = (await sendRuntimeCommand(repoDir, {
        type: "get-logs",
        taskId: "task_multi",
      })) as LogsResponse;

      expect(response.type).toBe("logs");
      expect(response.taskId).toBe("task_multi");

      // All three runs must be present
      expect(response.logs.runLogs).toHaveLength(3);

      // Sorted chronologically: earliest first
      const runIds = response.logs.runLogs.map((r: RunLogSummary) => r.runId);
      expect(runIds).toEqual([
        "2026-03-29T01:00:00.000Z",
        "2026-03-29T02:00:00.000Z",
        "2026-03-29T03:00:00.000Z",
      ]);
    } finally {
      await runtime.stop();
    }
  });

  // ─── T8: get-logs output matches latest run content ───

  it("T8: get-logs output content is from the latest run, not an earlier one", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { sendRuntimeCommand } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "task_latest", status: "completed" }));

    const runsDir = join(repoDir, "runs", "task_latest");
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, "2026-03-29T01:00:00.000Z.log"), "OLD CONTENT - SHOULD NOT APPEAR\n", "utf8");
    await writeFile(join(runsDir, "2026-03-29T02:00:00.000Z.log"), "LATEST CONTENT\n", "utf8");

    const runtime = await startRuntime(repoDir);
    try {
      const response = (await sendRuntimeCommand(repoDir, {
        type: "get-logs",
        taskId: "task_latest",
      })) as LogsResponse;

      expect(response.logs.output).toBe("LATEST CONTENT\n");
      // Must NOT contain old content
      expect(response.logs.output).not.toContain("OLD CONTENT");
    } finally {
      await runtime.stop();
    }
  });

  // ─── T9: get-task reflects updated state after status transition ───

  it("T9: get-task returns updated state after a task status change", async () => {
    const { WsServer } = await import("../../src/server/ws-server.js");

    // Start with a mutable task list to simulate status transitions
    const task = createTask({ id: "task_trans", status: "pending" });
    const tasks = [task];

    const server = new WsServer({ port: 0, listTasks: async () => tasks });
    try {
      await server.ready;
      const client = new WebSocket(server.url);
      await waitForOpen(client);

      // Initial fetch: pending
      client.send(JSON.stringify({ type: "get-task", taskId: "task_trans" }));
      const initial = (await waitForMessage(client)) as TaskResponse;
      expect(initial.task!.status).toBe("pending");

      // Simulate a status transition
      task.status = "generator_running";
      task.assigned_at = "2026-03-29T05:00:00.000Z";
      task.current_attempt = 1;

      // Subsequent fetch: must reflect the new state
      client.send(JSON.stringify({ type: "get-task", taskId: "task_trans" }));
      const updated = (await waitForMessage(client)) as TaskResponse;
      expect(updated.task!.status).toBe("generator_running");
      expect(updated.task!.assigned_at).toBe("2026-03-29T05:00:00.000Z");
      expect(updated.task!.current_attempt).toBe(1);

      client.close();
    } finally {
      await server.close();
    }
  });

  // ─── T10: get-logs during active run produces coherent snapshot ───

  it("T10: get-logs during active output produces a coherent snapshot (not mixed runs)", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { sendRuntimeCommand } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "task_active", status: "generator_running" }));

    // Create a "previous" run and a "current" run
    const runsDir = join(repoDir, "runs", "task_active");
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, "2026-03-29T01:00:00.000Z.log"), "previous run content\n", "utf8");
    await writeFile(join(runsDir, "2026-03-29T02:00:00.000Z.log"), "current run partial\n", "utf8");

    const runtime = await startRuntime(repoDir);
    try {
      const response = (await sendRuntimeCommand(repoDir, {
        type: "get-logs",
        taskId: "task_active",
      })) as LogsResponse;

      // Output should be from the latest run only (current partial)
      expect(response.logs.output).toBe("current run partial\n");
      // Run list should include both
      expect(response.logs.runLogs).toHaveLength(2);
      // Output must not mix content from different runs
      expect(response.logs.output).not.toContain("previous run content");
    } finally {
      await runtime.stop();
    }
  });

  // ─── T11: LogsResponse type is tightened (compile-time check) ───

  it("T11: LogsResponse.logs.runLogs is typed as RunLogSummary[] (compile-time check)", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { sendRuntimeCommand } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "task_typed", status: "completed" }));
    const runsDir = join(repoDir, "runs", "task_typed");
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, "2026-03-29T01:00:00.000Z.log"), "typed output\n", "utf8");

    const runtime = await startRuntime(repoDir);
    try {
      const response = (await sendRuntimeCommand(repoDir, {
        type: "get-logs",
        taskId: "task_typed",
      })) as LogsResponse;

      // The type assertion below would fail at compile time if runLogs were still unknown[].
      // At runtime, verify the shape matches RunLogSummary.
      const entries: RunLogSummary[] = response.logs.runLogs;
      expect(entries).toHaveLength(1);
      expect(entries[0]!.runId).toBe("2026-03-29T01:00:00.000Z");
      expect(typeof entries[0]!.path).toBe("string");
      expect(entries[0]!.path).toContain("task_typed");
    } finally {
      await runtime.stop();
    }
  });

  // ─── Invariant tests from reviewer contract ───

  it("Invariant 2: get-logs returns empty (never errors) for unknown task", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { sendRuntimeCommand } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "task_exists", status: "pending" }));

    const runtime = await startRuntime(repoDir);
    try {
      const response = (await sendRuntimeCommand(repoDir, {
        type: "get-logs",
        taskId: "nonexistent_task",
      })) as LogsResponse;

      expect(response.type).toBe("logs");
      expect(response.taskId).toBe("nonexistent_task");
      expect(response.logs.runLogs).toEqual([]);
      expect(response.logs.output).toBe("");
    } finally {
      await runtime.stop();
    }
  });

  it("Invariant 8: taskId echo field matches the requested task ID", async () => {
    const { WsServer } = await import("../../src/server/ws-server.js");

    const server = new WsServer({
      port: 0,
      listTasks: async () => [],
    });
    try {
      await server.ready;
      const client = new WebSocket(server.url);
      await waitForOpen(client);

      // get-task echo
      client.send(JSON.stringify({ type: "get-task", taskId: "echo_test_id" }));
      const taskResp = (await waitForMessage(client)) as TaskResponse;
      expect(taskResp.taskId).toBe("echo_test_id");
      expect(taskResp.task).toBeNull();

      client.close();
    } finally {
      await server.close();
    }
  });

  it("Edge case 3: null task vs empty logs are distinguishable", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { sendRuntimeCommand, readRuntimeControlInfo } = await import("../../src/runtime-control.js");

    // A task that exists but has no runs
    await writeTaskFile(repoDir, createTask({ id: "task_no_runs", status: "pending" }));

    const runtime = await startRuntime(repoDir);
    try {
      const controlInfo = await readRuntimeControlInfo(repoDir);
      const client = new WebSocket(controlInfo.url);
      await waitForOpen(client);

      // Task exists → get-task returns non-null
      client.send(JSON.stringify({ type: "get-task", taskId: "task_no_runs" }));
      const taskResp = (await waitForMessage(client)) as TaskResponse;
      expect(taskResp.task).not.toBeNull();
      expect(taskResp.task!.id).toBe("task_no_runs");

      // Task exists but no runs → get-logs returns empty
      const logsResp = (await sendRuntimeCommand(repoDir, {
        type: "get-logs",
        taskId: "task_no_runs",
      })) as LogsResponse;
      expect(logsResp.logs.runLogs).toEqual([]);
      expect(logsResp.logs.output).toBe("");

      // Unknown task → get-task returns null
      client.send(JSON.stringify({ type: "get-task", taskId: "totally_unknown" }));
      const unknownResp = (await waitForMessage(client)) as TaskResponse;
      expect(unknownResp.task).toBeNull();

      // Unknown task → get-logs also returns empty (but task is null above)
      const unknownLogs = (await sendRuntimeCommand(repoDir, {
        type: "get-logs",
        taskId: "totally_unknown",
      })) as LogsResponse;
      expect(unknownLogs.logs.runLogs).toEqual([]);

      client.close();
    } finally {
      await runtime.stop();
    }
  });
});

// ─── Helpers ───

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

async function writeTaskFile(repoDir: string, task: Task): Promise<void> {
  await writeFile(
    join(repoDir, "tasks", `${task.id}.yaml`),
    [
      `id: ${task.id}`,
      `title: ${task.title}`,
      `priority: ${task.priority}`,
      "depends_on: []",
      `agent_prompt: ${JSON.stringify(task.agent_prompt)}`,
      "exploration_budget:",
      `  max_attempts: ${task.exploration_budget.max_attempts}`,
      `  timeout_per_attempt: ${task.exploration_budget.timeout_per_attempt}`,
      `  total_timeout: ${task.exploration_budget.total_timeout}`,
      "escalation_rules: []",
    ].join("\n"),
    "utf8",
  );
}

async function startRuntime(repoDir: string) {
  const { startKernelRuntime } = await import("../../src/runtime.js");
  return startKernelRuntime(
    {
      repoDir,
      tasksDir: join(repoDir, "tasks"),
      dbPath: join(repoDir, ".openharness", "kernel.db"),
    },
    {
      runPreflight: async () => ({
        config: {
          tickIntervalMs: 25,
          maxConcurrency: 2,
          maxRecurringFixTasks: 3,
          poisonPillThreshold: 2,
          worktreesDir: ".worktrees",
          defaultAdapter: "copilot",
          evaluatorAdapter: "copilot",
          adapters: { copilot: "built-in" },
          tasksDir: "tasks",
          runsDir: "runs",
          port: 0,
          backoffBaseDelayMs: 1000,
          backoffMaxDelayMs: 10_000,
        },
        tasks: [],
        lock: {
          lockPath: join(repoDir, ".openharness", "kernel.pid"),
          pid: process.pid,
        },
      }),
      createTickLoop: () => ({ start: () => undefined, stop: () => undefined }),
    },
  );
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off("open", onOpen);
      socket.off("error", onError);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    socket.on("open", onOpen);
    socket.on("error", onError);
  });
}

async function waitForMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onMessage = (data: WebSocket.RawData) => { cleanup(); resolve(JSON.parse(data.toString())); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("Socket closed before message")); };
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}
