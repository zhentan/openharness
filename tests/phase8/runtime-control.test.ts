import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { TaskStore } from "../../src/store/task-store.js";
import type { Task } from "../../src/types.js";

describe("Phase 8: runtime control", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "oh-runtime-control-"));
    await mkdir(join(repoDir, ".openharness"), { recursive: true });
    await mkdir(join(repoDir, "tasks"), { recursive: true });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("publishes runtime control info, serves live status, and handles pause/resume/shutdown", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { readRuntimeControlInfo, sendRuntimeCommand, waitForRuntimeStop } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({
      id: "task_1",
      title: "First task",
      status: "pending",
    }));

    const store = new TaskStore({
      tasksDir: join(repoDir, "tasks"),
      dbPath: join(repoDir, ".openharness", "kernel.db"),
    });
    // Override get to return paused status for resume validation
    vi.spyOn(store, "get").mockResolvedValue(createTask({ id: "task_1", title: "First task", status: "paused" }));
    const requestPause = vi.fn(async () => undefined);
    const resumeTask = vi.fn(async () => undefined);

    const runtime = await startKernelRuntime(
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
          lock: { lockPath: join(repoDir, ".openharness", "kernel.pid"), pid: process.pid },
        }),
        createStore: () => store,
        createSupervisor: () => ({
          spawnAgent: async () => undefined,
          getRunningCount: () => 0,
          hasRunningProcess: () => true,
          requestPause,
          resumeTask,
        }),
        createKernel: () => ({
          reconcileStartupState: async () => undefined,
          tick: async () => undefined,
          handleCrash: async () => undefined,
        }),
        createTickLoop: () => ({ start: () => undefined, stop: () => undefined }),
      },
    );

    const control = await readRuntimeControlInfo(repoDir);
    expect(control.pid).toBe(process.pid);
    expect(control.url).toContain("ws://127.0.0.1:");
    expect(control.token.length).toBeGreaterThan(0);

    const status = await sendRuntimeCommand(repoDir, { type: "get-status" });
    expect(status).toEqual({
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
          title: "First task",
          status: "pending",
          updatedAt: expect.any(String),
        },
      ],
    });

    expect(await sendRuntimeCommand(repoDir, { type: "pause", taskId: "task_1" })).toEqual({
      type: "ack",
      command: "pause",
      taskId: "task_1",
    });
    expect(requestPause).toHaveBeenCalledWith("task_1");

    expect(await sendRuntimeCommand(repoDir, { type: "resume", taskId: "task_1" })).toEqual({
      type: "ack",
      command: "resume",
      taskId: "task_1",
    });
    expect(resumeTask).toHaveBeenCalledWith("task_1");

    expect(await sendRuntimeCommand(repoDir, { type: "shutdown" })).toEqual({
      type: "ack",
      command: "shutdown",
    });

    await waitForRuntimeStop(repoDir, { timeoutMs: 2_000 });
    await expect(readRuntimeControlInfo(repoDir)).rejects.toThrow("Kernel is not running");

    await runtime.stop();
    store.close();
  });

  it("removes stale runtime control files before reporting the kernel unavailable", async () => {
    const { getRuntimeControlPath, readRuntimeControlInfo } = await import("../../src/runtime-control.js");

    await writeFile(
      getRuntimeControlPath(repoDir),
      JSON.stringify({
        pid: 999_999,
        url: "ws://127.0.0.1:65535",
        token: "stale-token",
      }),
      "utf8",
    );

    await expect(readRuntimeControlInfo(repoDir)).rejects.toThrow("Kernel is not running");
    await expect(readRuntimeControlInfo(repoDir)).rejects.toThrow("Kernel is not running");
  });

  it("keeps runtime control info present until shutdown fully releases runtime ownership", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { getRuntimeControlPath, sendRuntimeCommand } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "task_1", title: "First task", status: "pending" }));

    let releaseLock: (() => void) | undefined;
    const releaseBarrier = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const runtime = await startKernelRuntime(
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
          lock: { lockPath: join(repoDir, ".openharness", "kernel.pid"), pid: process.pid },
        }),
        createTickLoop: () => ({ start: () => undefined, stop: () => undefined }),
        releaseKernelLock: async () => {
          await releaseBarrier;
        },
      },
    );

    await expect(sendRuntimeCommand(repoDir, { type: "shutdown" })).resolves.toEqual({
      type: "ack",
      command: "shutdown",
    });
    await expect(access(getRuntimeControlPath(repoDir))).resolves.toBeUndefined();

    releaseLock?.();
    await runtime.stop();
  });

  it("serves persisted agent logs for a task over runtime control", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { sendRuntimeCommand } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "task_1", title: "First task", status: "generator_running" }));
    await mkdir(join(repoDir, "runs", "task_1"), { recursive: true });
    await writeFile(join(repoDir, "runs", "task_1", "2026-03-28T20:00:00.000Z.log"), "first line\nsecond line\n", "utf8");
    await writeFile(join(repoDir, "runs", "task_1", "2026-03-28T21:00:00.000Z.log"), "latest line\n", "utf8");

    const runtime = await startKernelRuntime(
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
          lock: { lockPath: join(repoDir, ".openharness", "kernel.pid"), pid: process.pid },
        }),
        createTickLoop: () => ({ start: () => undefined, stop: () => undefined }),
      },
    );

    try {
      await expect(sendRuntimeCommand(repoDir, { type: "get-logs", taskId: "task_1" })).resolves.toEqual({
        type: "logs",
        taskId: "task_1",
        logs: {
          runLogs: [
            {
              runId: "2026-03-28T20:00:00.000Z",
              path: join(repoDir, "runs", "task_1", "2026-03-28T20:00:00.000Z.log"),
            },
            {
              runId: "2026-03-28T21:00:00.000Z",
              path: join(repoDir, "runs", "task_1", "2026-03-28T21:00:00.000Z.log"),
            },
          ],
          output: "latest line\n",
        },
      });
    } finally {
      await runtime.stop();
    }
  });

  it("returns empty logs when a task has no persisted run output", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { sendRuntimeCommand } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "task_2", title: "Second task", status: "pending" }));

    const runtime = await startKernelRuntime(
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
          lock: { lockPath: join(repoDir, ".openharness", "kernel.pid"), pid: process.pid },
        }),
        createTickLoop: () => ({ start: () => undefined, stop: () => undefined }),
      },
    );

    try {
      await expect(sendRuntimeCommand(repoDir, { type: "get-logs", taskId: "task_2" })).resolves.toEqual({
        type: "logs",
        taskId: "task_2",
        logs: {
          runLogs: [],
          output: "",
        },
      });
    } finally {
      await runtime.stop();
    }
  });

  it("allows an idle watch stream to close promptly when the consumer returns", async () => {
    const { getRuntimeControlPath, watchTaskStream } = await import("../../src/runtime-control.js");

    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected websocket server to listen on a TCP port");
      }

      await writeFile(
        getRuntimeControlPath(repoDir),
        JSON.stringify({
          pid: process.pid,
          url: `ws://127.0.0.1:${address.port}`,
          token: "watch-token",
        }),
        "utf8",
      );

      server.on("connection", (socket) => {
        socket.on("message", (data) => {
          const message = JSON.parse(data.toString()) as { type?: string };
          if (message.type === "subscribe") {
            socket.send(JSON.stringify({
              type: "snapshot",
              sequence: 0,
              counts: {
                pending: 0,
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
              tasks: [],
            }));
          }
        });
      });

      const stream = watchTaskStream(repoDir);
      await expect(stream.next()).resolves.toEqual({
        done: false,
        value: {
          type: "snapshot",
          sequence: 0,
          counts: {
            pending: 0,
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
          tasks: [],
        },
      });

      void stream.next();

      await expect(
        Promise.race([
          stream.return(undefined),
          new Promise((_, reject) => {
            setTimeout(() => {
              reject(new Error("Timed out waiting for watch stream return()"));
            }, 250);
          }),
        ]),
      ).resolves.toEqual({ done: true, value: undefined });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("streams live task output over the runtime websocket when subscribed to output", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "task_3", title: "Third task", status: "pending" }));

    let emitOutput: ((chunk: string) => void) | undefined;
    const runtime = await startKernelRuntime(
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
          lock: { lockPath: join(repoDir, ".openharness", "kernel.pid"), pid: process.pid },
        }),
        createTickLoop: () => ({ start: () => undefined, stop: () => undefined }),
        createSupervisor: () => ({
          spawnAgent: async () => undefined,
          getRunningCount: () => 0,
          subscribeTaskOutput: (_taskId: string, listener: (chunk: string) => void) => {
            emitOutput = listener;
            return () => {
              emitOutput = undefined;
            };
          },
        }),
        createKernel: () => ({
          reconcileStartupState: async () => undefined,
          tick: async () => undefined,
          handleCrash: async () => undefined,
        }),
      },
    );

    try {
      const control = await readRuntimeControlInfo(repoDir);
      const client = new WebSocket(control.url);
      await waitForSocketOpen(client);

      client.send(JSON.stringify({ type: "subscribe", channel: "output", taskId: "task_3" }));
      await expect(waitForSocketMessage(client)).resolves.toEqual({
        type: "ack",
        command: "subscribe",
        taskId: "task_3",
      });

      emitOutput?.("live line\n");
      await expect(waitForSocketMessage(client)).resolves.toEqual({
        type: "output",
        taskId: "task_3",
        text: "live line\n",
      });

      client.close();
    } finally {
      await runtime.stop();
    }
  });
});

function createTask(overrides: Partial<Task> & Pick<Task, "id" | "title" | "status">): Task {
  return {
    id: overrides.id,
    title: overrides.title,
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

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off("open", onOpen);
      socket.off("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.on("open", onOpen);
    socket.on("error", onError);
  });
}

async function waitForSocketMessage(socket: WebSocket): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onMessage = (data: WebSocket.RawData) => {
      cleanup();
      resolve(JSON.parse(data.toString()));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Socket closed before message"));
    };

    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}
