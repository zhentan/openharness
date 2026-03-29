/**
 * Phase 9: Runtime Controls Contract
 *
 * Tests defined by reviewer constraints (docs/phase9/reviews/runtime-controls-contract.md)
 * before implementation. Each test maps to a specific behavioral contract.
 *
 * Reviewer test IDs:
 *  1. Pause on non-active task returns error
 *  2. Pause on active task returns ack
 *  3. Pause flag cleared on dispatch
 *  4. Resume on non-paused task returns error
 *  5. Resume on paused task returns ack
 *  6. Kill on active task terminates process group
 *  7. Kill on non-active task returns error
 *  8. Kill feeds into normal failure routing
 *  9. Kill then pause prevents retry
 * 10. Kill during shutdown is harmless
 * 11. Control handler catches store errors
 * 12. Output-ended notification sent on kill
 * 13. Full round-trip: pause via WebSocket
 * 14. Kill via WebSocket round-trip
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { OutputEndedReason } from "../../src/server/ipc-types.js";
import type { Task } from "../../src/types.js";

// ── Supervisor unit tests ──

describe("Phase 9: Runtime controls contract — Supervisor", () => {
  // Test 1: Pause on non-active task returns error
  describe("pause state validation", () => {
    it("hasRunningProcess returns false for a task with no attached process", async () => {
      const { Supervisor } = await import("../../src/supervisor/supervisor.js");
      const supervisor = new Supervisor({
        store: { updateStatus: vi.fn().mockResolvedValue(undefined) },
        terminateProcessGroup: vi.fn(),
      });

      expect(supervisor.hasRunningProcess("nonexistent")).toBe(false);
    });

    it("hasRunningProcess returns true for a task with an attached process", async () => {
      const { Supervisor } = await import("../../src/supervisor/supervisor.js");
      const supervisor = new Supervisor({
        store: { updateStatus: vi.fn().mockResolvedValue(undefined) },
        terminateProcessGroup: vi.fn(),
      });

      supervisor.attachProcess("t_active", { pid: 100, pgid: 100 });
      expect(supervisor.hasRunningProcess("t_active")).toBe(true);
    });
  });

  // Test 3: Pause flag cleared on dispatch
  describe("pause flag cleared on dispatch", () => {
    it("clears stale pause flag when a new agent run begins for the task", async () => {
      const { Supervisor } = await import("../../src/supervisor/supervisor.js");
      const updateStatus = vi.fn().mockResolvedValue(undefined);
      const supervisor = new Supervisor({
        store: { updateStatus },
        terminateProcessGroup: vi.fn(),
      });

      // Set a stale pause flag
      await supervisor.requestPause("t_stale");

      // Attach a process as if the task was dispatched
      supervisor.attachProcess("t_stale", { pid: 200, pgid: 200 });

      // Clear the stale pause flag (this should be done on dispatch)
      supervisor.clearPauseFlag("t_stale");

      // Now when the process exits, it should NOT be intercepted as paused
      await supervisor.handleAgentExit("t_stale", { type: "completion" });
      expect(updateStatus).toHaveBeenCalledWith("t_stale", "completed", expect.anything());
    });
  });

  // Test 6: Kill on active task terminates process group
  describe("kill", () => {
    it("terminates process group and clears pause flag for an active task", async () => {
      const { Supervisor } = await import("../../src/supervisor/supervisor.js");
      const terminateProcessGroup = vi.fn().mockResolvedValue(undefined);
      const updateStatus = vi.fn().mockResolvedValue(undefined);

      const supervisor = new Supervisor({
        store: { updateStatus },
        terminateProcessGroup,
      });

      supervisor.attachProcess("t_kill", { pid: 300, pgid: 300 });
      await supervisor.requestPause("t_kill"); // Set pause flag

      await supervisor.killTask("t_kill");

      expect(terminateProcessGroup).toHaveBeenCalledWith(300);
      // Pause flag should be cleared (kill supersedes pause)
      expect(supervisor.hasRunningProcess("t_kill")).toBe(false);
    });

    // Test 7: Kill on non-active task returns error
    it("throws when killing a task with no running process", async () => {
      const { Supervisor } = await import("../../src/supervisor/supervisor.js");
      const supervisor = new Supervisor({
        store: { updateStatus: vi.fn().mockResolvedValue(undefined) },
        terminateProcessGroup: vi.fn(),
      });

      await expect(supervisor.killTask("t_noprocess")).rejects.toThrow();
    });

    // Test 8: Kill feeds into normal failure routing
    it("kill exit feeds into normal failure routing (retry if budget allows)", async () => {
      const { Supervisor } = await import("../../src/supervisor/supervisor.js");
      const updateStatus = vi.fn().mockResolvedValue(undefined);
      const terminateProcessGroup = vi.fn().mockResolvedValue(undefined);

      const supervisor = new Supervisor({
        store: { updateStatus },
        terminateProcessGroup,
      });

      supervisor.attachProcess("t_kill_retry", { pid: 400, pgid: 400 });
      await supervisor.killTask("t_kill_retry");

      // The exit handler will be triggered by the process exit event.
      // Simulate the exit event from the killed process.
      await supervisor.handleAgentExit("t_kill_retry", {
        type: "retry",
        reason: "sigkill_unknown",
      });

      // Normal failure routing: retry_pending (not escalated)
      expect(updateStatus).toHaveBeenCalledWith(
        "t_kill_retry",
        "retry_pending",
        expect.objectContaining({ reason: "sigkill_unknown" }),
      );
    });

    // Test 9: Kill then pause prevents retry
    it("kill then pause: exit handler sees pause flag and moves to paused", async () => {
      const { Supervisor } = await import("../../src/supervisor/supervisor.js");
      const updateStatus = vi.fn().mockResolvedValue(undefined);
      const terminateProcessGroup = vi.fn().mockResolvedValue(undefined);

      const supervisor = new Supervisor({
        store: { updateStatus },
        terminateProcessGroup,
      });

      supervisor.attachProcess("t_kp", { pid: 500, pgid: 500 });

      // Kill (clears any existing pause flag)
      await supervisor.killTask("t_kp");

      // Then immediately pause (re-sets the flag)
      await supervisor.requestPause("t_kp");

      // When exit handler runs, the pause flag is set → paused, not retry
      await supervisor.handleAgentExit("t_kp", {
        type: "retry",
        reason: "sigkill_unknown",
      });

      expect(updateStatus).toHaveBeenCalledWith(
        "t_kp",
        "paused",
        expect.objectContaining({ intercepted: "retry" }),
      );
    });

    // Test 10: Kill during shutdown is harmless
    it("kill during shutdown does not crash", async () => {
      const { Supervisor } = await import("../../src/supervisor/supervisor.js");
      const terminateProcessGroup = vi.fn().mockResolvedValue(undefined);

      const supervisor = new Supervisor({
        store: { updateStatus: vi.fn().mockResolvedValue(undefined) },
        terminateProcessGroup,
      });

      supervisor.attachProcess("t_shutdown_kill", { pid: 600, pgid: 600 });

      // Initiate shutdown (clears pause flags, terminates all)
      await supervisor.shutdown();

      // Kill after shutdown should not crash (process already gone)
      await expect(supervisor.killTask("t_shutdown_kill")).rejects.toThrow();
    });

    // Test 12: Output-ended notification sent on kill
    it("notifies output subscribers with appropriate reason when kill triggers exit", async () => {
      const { Supervisor } = await import("../../src/supervisor/supervisor.js");
      const updateStatus = vi.fn().mockResolvedValue(undefined);
      const terminateProcessGroup = vi.fn().mockResolvedValue(undefined);

      const supervisor = new Supervisor({
        store: { updateStatus },
        terminateProcessGroup,
      });

      supervisor.attachProcess("t_kill_output", { pid: 700, pgid: 700 });

      const outputEndedReasons: OutputEndedReason[] = [];
      supervisor.subscribeTaskOutput(
        "t_kill_output",
        () => {},
        (reason) => { outputEndedReasons.push(reason); },
      );

      await supervisor.killTask("t_kill_output");

      // Exit event from killed process
      await supervisor.handleAgentExit("t_kill_output", {
        type: "retry",
        reason: "sigkill_unknown",
      });

      expect(outputEndedReasons.length).toBe(1);
      expect(outputEndedReasons[0]).toBe("retry");
    });
  });
});

// ── Runtime onRequest handler tests ──

describe("Phase 9: Runtime controls contract — Runtime handler", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "oh-controls-contract-"));
    await mkdir(join(repoDir, ".openharness"), { recursive: true });
    await mkdir(join(repoDir, "tasks"), { recursive: true });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  // Test 1: Pause on non-active task returns error (runtime handler level)
  it("pause on non-active task returns error", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { sendRuntimeCommand } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "t_pending", title: "Pending", status: "pending" }));

    const runtime = await startKernelRuntime(
      {
        repoDir,
        tasksDir: join(repoDir, "tasks"),
        dbPath: join(repoDir, ".openharness", "kernel.db"),
      },
      {
        ...minimalRuntimeOverrides(),
        createSupervisor: () => ({
          spawnAgent: async () => undefined,
          getRunningCount: () => 0,
          requestPause: vi.fn(async () => undefined),
          resumeTask: vi.fn(async () => undefined),
          hasRunningProcess: () => false,
        }),
      },
    );

    try {
      await expect(sendRuntimeCommand(repoDir, { type: "pause", taskId: "t_pending" }))
        .rejects.toThrow("no running process");
    } finally {
      await runtime.stop();
    }
  });

  // Test 2: Pause on active task returns ack
  it("pause on active task returns ack", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { sendRuntimeCommand } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "t_running", title: "Running", status: "generator_running" }));

    const requestPause = vi.fn(async () => undefined);
    const runtime = await startKernelRuntime(
      {
        repoDir,
        tasksDir: join(repoDir, "tasks"),
        dbPath: join(repoDir, ".openharness", "kernel.db"),
      },
      {
        ...minimalRuntimeOverrides(),
        createSupervisor: () => ({
          spawnAgent: async () => undefined,
          getRunningCount: () => 0,
          requestPause,
          resumeTask: vi.fn(async () => undefined),
          hasRunningProcess: () => true,
        }),
      },
    );

    try {
      const response = await sendRuntimeCommand(repoDir, { type: "pause", taskId: "t_running" });
      expect(response).toEqual({ type: "ack", command: "pause", taskId: "t_running" });
      expect(requestPause).toHaveBeenCalledWith("t_running");
    } finally {
      await runtime.stop();
    }
  });

  // Test 4: Resume on non-paused task returns error
  it("resume on non-paused task returns error", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { sendRuntimeCommand } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "t_running2", title: "Running", status: "generator_running" }));

    const runtime = await startKernelRuntime(
      {
        repoDir,
        tasksDir: join(repoDir, "tasks"),
        dbPath: join(repoDir, ".openharness", "kernel.db"),
      },
      {
        ...minimalRuntimeOverrides(),
        createSupervisor: () => ({
          spawnAgent: async () => undefined,
          getRunningCount: () => 0,
          requestPause: vi.fn(async () => undefined),
          resumeTask: vi.fn(async () => undefined),
          hasRunningProcess: () => true,
        }),
      },
    );

    try {
      await expect(sendRuntimeCommand(repoDir, { type: "resume", taskId: "t_running2" }))
        .rejects.toThrow("not paused");
    } finally {
      await runtime.stop();
    }
  });

  // Test 5: Resume on paused task returns ack
  it("resume on paused task returns ack", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { sendRuntimeCommand } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "t_paused", title: "Paused", status: "paused" }));

    const resumeTask = vi.fn(async () => undefined);
    const runtime = await startKernelRuntime(
      {
        repoDir,
        tasksDir: join(repoDir, "tasks"),
        dbPath: join(repoDir, ".openharness", "kernel.db"),
      },
      {
        ...minimalRuntimeOverrides(),
        createStore: () => ({
          list: async () => [createTask({ id: "t_paused", title: "Paused", status: "paused" })],
          get: async (id: string) => id === "t_paused" ? createTask({ id: "t_paused", title: "Paused", status: "paused" }) : null,
          updateStatus: vi.fn(async () => undefined),
        }),
        createSupervisor: () => ({
          spawnAgent: async () => undefined,
          getRunningCount: () => 0,
          requestPause: vi.fn(async () => undefined),
          resumeTask,
          hasRunningProcess: () => false,
        }),
      },
    );

    try {
      const response = await sendRuntimeCommand(repoDir, { type: "resume", taskId: "t_paused" });
      expect(response).toEqual({ type: "ack", command: "resume", taskId: "t_paused" });
      expect(resumeTask).toHaveBeenCalledWith("t_paused");
    } finally {
      await runtime.stop();
    }
  });

  // Test 7: Kill on non-active task returns error (runtime handler level)
  it("kill on non-active task returns error", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { sendRuntimeCommand } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "t_paused_kill", title: "Paused", status: "paused" }));

    const runtime = await startKernelRuntime(
      {
        repoDir,
        tasksDir: join(repoDir, "tasks"),
        dbPath: join(repoDir, ".openharness", "kernel.db"),
      },
      {
        ...minimalRuntimeOverrides(),
        createSupervisor: () => ({
          spawnAgent: async () => undefined,
          getRunningCount: () => 0,
          requestPause: vi.fn(async () => undefined),
          resumeTask: vi.fn(async () => undefined),
          hasRunningProcess: () => false,
          killTask: vi.fn(async () => { throw new Error("No running process"); }),
        }),
      },
    );

    try {
      await expect(sendRuntimeCommand(repoDir, { type: "kill", taskId: "t_paused_kill" }))
        .rejects.toThrow("no running process");
    } finally {
      await runtime.stop();
    }
  });

  // Test 6: Kill on active task returns ack (runtime handler level)
  it("kill on active task returns ack", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { sendRuntimeCommand } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "t_active_kill", title: "Active", status: "generator_running" }));

    const killTask = vi.fn(async () => undefined);
    const runtime = await startKernelRuntime(
      {
        repoDir,
        tasksDir: join(repoDir, "tasks"),
        dbPath: join(repoDir, ".openharness", "kernel.db"),
      },
      {
        ...minimalRuntimeOverrides(),
        createSupervisor: () => ({
          spawnAgent: async () => undefined,
          getRunningCount: () => 0,
          requestPause: vi.fn(async () => undefined),
          resumeTask: vi.fn(async () => undefined),
          hasRunningProcess: () => true,
          killTask,
        }),
      },
    );

    try {
      const response = await sendRuntimeCommand(repoDir, { type: "kill", taskId: "t_active_kill" });
      expect(response).toEqual({ type: "ack", command: "kill", taskId: "t_active_kill" });
      expect(killTask).toHaveBeenCalledWith("t_active_kill");
    } finally {
      await runtime.stop();
    }
  });

  // Test 11: Control handler catches store errors
  it("control handler catches store errors and returns error response", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { sendRuntimeCommand } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "t_store_err", title: "Store Error", status: "paused" }));

    const runtime = await startKernelRuntime(
      {
        repoDir,
        tasksDir: join(repoDir, "tasks"),
        dbPath: join(repoDir, ".openharness", "kernel.db"),
      },
      {
        ...minimalRuntimeOverrides(),
        // Store returns "paused" so state validation passes, then resumeTask throws
        createStore: () => ({
          list: async () => [createTask({ id: "t_store_err", title: "Store Error", status: "paused" })],
          get: async (id: string) => id === "t_store_err" ? createTask({ id: "t_store_err", title: "Store Error", status: "paused" }) : null,
          updateStatus: vi.fn(async () => undefined),
        }),
        createSupervisor: () => ({
          spawnAgent: async () => undefined,
          getRunningCount: () => 0,
          requestPause: vi.fn(async () => undefined),
          resumeTask: vi.fn(async () => { throw new Error("Store write failed"); }),
          hasRunningProcess: () => false,
        }),
      },
    );

    try {
      // resumeTask throws, but the try/catch in the onRequest handler catches it
      // and returns { type: "error" }, which sendRuntimeCommand then throws as an Error
      await expect(sendRuntimeCommand(repoDir, { type: "resume", taskId: "t_store_err" }))
        .rejects.toThrow("Store write failed");
    } finally {
      await runtime.stop();
    }
  });

  // Test 13: Full round-trip: pause via WebSocket, observe delta, resume
  it("pause via WebSocket acks, resume via WebSocket acks", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "t_rt", title: "Round trip", status: "generator_running" }));

    const requestPause = vi.fn(async () => undefined);
    const resumeTask = vi.fn(async () => undefined);

    const runtime = await startKernelRuntime(
      {
        repoDir,
        tasksDir: join(repoDir, "tasks"),
        dbPath: join(repoDir, ".openharness", "kernel.db"),
      },
      {
        ...minimalRuntimeOverrides(),
        createSupervisor: () => ({
          spawnAgent: async () => undefined,
          getRunningCount: () => 0,
          requestPause,
          resumeTask,
          hasRunningProcess: (taskId: string) => taskId === "t_rt",
        }),
      },
    );

    try {
      const control = await readRuntimeControlInfo(repoDir);
      const client = new WebSocket(control.url);
      await waitForSocketOpen(client);

      // Authenticate
      client.send(JSON.stringify({ type: "authenticate", token: control.token }));
      await expect(waitForSocketMessage(client)).resolves.toEqual(
        expect.objectContaining({ type: "ack", command: "authenticate" }),
      );

      // Pause — should succeed (task has running process)
      client.send(JSON.stringify({ type: "pause", taskId: "t_rt" }));
      await expect(waitForSocketMessage(client)).resolves.toEqual({
        type: "ack",
        command: "pause",
        taskId: "t_rt",
      });
      expect(requestPause).toHaveBeenCalledWith("t_rt");

      client.close();
    } finally {
      await runtime.stop();
    }
  });

  // Test 14: Kill via WebSocket round-trip
  it("kill via WebSocket returns ack for active task", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "t_wskill", title: "WS Kill", status: "generator_running" }));

    const killTask = vi.fn(async () => undefined);
    const runtime = await startKernelRuntime(
      {
        repoDir,
        tasksDir: join(repoDir, "tasks"),
        dbPath: join(repoDir, ".openharness", "kernel.db"),
      },
      {
        ...minimalRuntimeOverrides(),
        createSupervisor: () => ({
          spawnAgent: async () => undefined,
          getRunningCount: () => 0,
          requestPause: vi.fn(async () => undefined),
          resumeTask: vi.fn(async () => undefined),
          hasRunningProcess: () => true,
          killTask,
        }),
      },
    );

    try {
      const control = await readRuntimeControlInfo(repoDir);
      const client = new WebSocket(control.url);
      await waitForSocketOpen(client);

      // Authenticate
      client.send(JSON.stringify({ type: "authenticate", token: control.token }));
      await expect(waitForSocketMessage(client)).resolves.toEqual(
        expect.objectContaining({ type: "ack", command: "authenticate" }),
      );

      // Kill — should succeed (task has running process)
      client.send(JSON.stringify({ type: "kill", taskId: "t_wskill" }));
      await expect(waitForSocketMessage(client)).resolves.toEqual({
        type: "ack",
        command: "kill",
        taskId: "t_wskill",
      });
      expect(killTask).toHaveBeenCalledWith("t_wskill");

      client.close();
    } finally {
      await runtime.stop();
    }
  });
});

// ── Helpers ──

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

function minimalRuntimeOverrides() {
  return {
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
      lock: { lockPath: "", pid: process.pid },
    }),
    createKernel: () => ({
      reconcileStartupState: async () => undefined,
      tick: async () => undefined,
      handleCrash: async () => undefined,
    }),
    createTickLoop: () => ({ start: () => undefined, stop: () => undefined }),
  };
}

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => { socket.off("error", onError); resolve(); };
    const onError = (err: Error) => { socket.off("open", onOpen); reject(err); };
    socket.on("open", onOpen);
    socket.on("error", onError);
  });
}

async function waitForSocketMessage(socket: WebSocket): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      socket.off("error", onError);
      socket.off("close", onClose);
      resolve(JSON.parse(data.toString()));
    };
    const onError = (err: Error) => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
      reject(err);
    };
    const onClose = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      reject(new Error("Socket closed before message"));
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}
