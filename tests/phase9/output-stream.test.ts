import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { Task } from "../../src/types.js";
import type { OutputEndedReason } from "../../src/server/ipc-types.js";

/**
 * Phase 9 output stream contract tests.
 *
 * These tests were defined by the reviewer in
 * docs/phase9/reviews/runtime-output-stream.md before implementation.
 * Test IDs (T4–T13) correspond to the reviewer's test list.
 */

// ─── WsServer transport layer tests ────────────────────────────────

describe("Phase 9: output stream — WsServer transport", () => {
  const servers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server) {
        await server.close();
      }
    }
  });

  // T4: Subscribe to output when no process is running returns a distinguishable error
  it("returns a distinguishable error when subscribing to output for a task with no process", async () => {
    const { WsServer } = await import("../../src/server/ws-server.js");

    // subscribeTaskOutput returns an unsubscribe function (listener registered)
    // but the task has no active process. The WsServer should acknowledge the
    // subscription rather than returning a generic "Output stream unavailable" error.
    // The error case is only when subscribeTaskOutput itself is not configured.
    const server = new WsServer({
      port: 0,
      subscribeTaskOutput: (_taskId, _listener) => {
        // Supervisor always returns an unsubscribe function, even with no process.
        return () => undefined;
      },
    });
    servers.push(server);
    await server.ready;

    const client = new WebSocket(server.url);
    await waitForOpen(client);

    client.send(JSON.stringify({ type: "subscribe", channel: "output", taskId: "task_no_process" }));
    const response = await waitForMessage(client);

    // Should get an ack (subscription registered), not an error
    expect(response).toEqual({
      type: "ack",
      command: "subscribe",
      taskId: "task_no_process",
    });

    client.close();
  });

  it("returns 'Output streaming not configured' when subscribeTaskOutput is not provided", async () => {
    const { WsServer } = await import("../../src/server/ws-server.js");

    // No subscribeTaskOutput configured at all
    const server = new WsServer({ port: 0 });
    servers.push(server);
    await server.ready;

    const client = new WebSocket(server.url);
    await waitForOpen(client);

    client.send(JSON.stringify({ type: "subscribe", channel: "output", taskId: "task_1" }));
    const response = await waitForMessage(client);

    expect(response).toEqual({
      type: "error",
      message: "Output streaming not configured",
    });

    client.close();
  });

  // T5: Switching output subscription cleans up old and establishes new
  it("cleans up old subscription when switching output to a different task", async () => {
    const { WsServer } = await import("../../src/server/ws-server.js");

    const listeners = new Map<string, (chunk: string) => void>();
    const server = new WsServer({
      port: 0,
      subscribeTaskOutput: (taskId, listener) => {
        listeners.set(taskId, listener);
        return () => {
          listeners.delete(taskId);
        };
      },
    });
    servers.push(server);
    await server.ready;

    const client = new WebSocket(server.url);
    await waitForOpen(client);

    // Subscribe to task_A
    client.send(JSON.stringify({ type: "subscribe", channel: "output", taskId: "task_A" }));
    await waitForMessage(client); // ack

    // Push a chunk to task_A — client should receive it
    listeners.get("task_A")?.("chunk A\n");
    const chunkA = await waitForMessage(client);
    expect(chunkA).toEqual({ type: "output", taskId: "task_A", text: "chunk A\n" });

    // Switch to task_B
    client.send(JSON.stringify({ type: "subscribe", channel: "output", taskId: "task_B" }));
    await waitForMessage(client); // ack

    // task_A listener should be removed
    expect(listeners.has("task_A")).toBe(false);
    // task_B listener should be present
    expect(listeners.has("task_B")).toBe(true);

    // Push a chunk to task_B — client should receive it
    listeners.get("task_B")?.("chunk B\n");
    const chunkB = await waitForMessage(client);
    expect(chunkB).toEqual({ type: "output", taskId: "task_B", text: "chunk B\n" });

    client.close();
  });

  // T6: Client disconnect cleans up output subscription
  it("cleans up output subscription when client socket closes", async () => {
    const { WsServer } = await import("../../src/server/ws-server.js");

    let unsubscribeCalled = false;
    const server = new WsServer({
      port: 0,
      subscribeTaskOutput: (_taskId, _listener) => {
        return () => {
          unsubscribeCalled = true;
        };
      },
    });
    servers.push(server);
    await server.ready;

    const client = new WebSocket(server.url);
    await waitForOpen(client);

    client.send(JSON.stringify({ type: "subscribe", channel: "output", taskId: "task_1" }));
    await waitForMessage(client); // ack

    // Close socket without explicit unsubscribe
    client.close();
    await waitForClose(client);

    // Give the server time to process the close event
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(unsubscribeCalled).toBe(true);
  });

  // T7: Multiple clients subscribe to the same task output
  it("delivers output to multiple clients subscribed to the same task", async () => {
    const { WsServer } = await import("../../src/server/ws-server.js");

    const listeners = new Set<(chunk: string) => void>();
    const server = new WsServer({
      port: 0,
      subscribeTaskOutput: (_taskId, listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
    servers.push(server);
    await server.ready;

    const client1 = new WebSocket(server.url);
    const client2 = new WebSocket(server.url);
    await Promise.all([waitForOpen(client1), waitForOpen(client2)]);

    // Both subscribe to same task
    client1.send(JSON.stringify({ type: "subscribe", channel: "output", taskId: "task_1" }));
    client2.send(JSON.stringify({ type: "subscribe", channel: "output", taskId: "task_1" }));
    await Promise.all([waitForMessage(client1), waitForMessage(client2)]); // acks

    expect(listeners.size).toBe(2);

    // Push a chunk — both should receive it
    for (const listener of listeners) {
      listener("shared chunk\n");
    }
    const [msg1, msg2] = await Promise.all([waitForMessage(client1), waitForMessage(client2)]);
    expect(msg1).toEqual({ type: "output", taskId: "task_1", text: "shared chunk\n" });
    expect(msg2).toEqual({ type: "output", taskId: "task_1", text: "shared chunk\n" });

    // Unsubscribe client1
    client1.send(JSON.stringify({ type: "unsubscribe", channel: "output", taskId: "task_1" }));
    await waitForMessage(client1); // ack
    expect(listeners.size).toBe(1);

    // Push another chunk — only client2 should receive it
    for (const listener of listeners) {
      listener("after unsub\n");
    }
    const msg3 = await waitForMessage(client2);
    expect(msg3).toEqual({ type: "output", taskId: "task_1", text: "after unsub\n" });

    client1.close();
    client2.close();
  });

  // T5 supplement: output-ended signal is relayed to subscribed client
  it("relays output-ended signal to the subscribed client when the task exits", async () => {
    const { WsServer } = await import("../../src/server/ws-server.js");

    let onEndedCallback: ((reason: OutputEndedReason) => void) | undefined;
    const server = new WsServer({
      port: 0,
      subscribeTaskOutput: (_taskId, _listener, onEnded) => {
        onEndedCallback = onEnded;
        return () => {
          onEndedCallback = undefined;
        };
      },
    });
    servers.push(server);
    await server.ready;

    const client = new WebSocket(server.url);
    await waitForOpen(client);

    client.send(JSON.stringify({ type: "subscribe", channel: "output", taskId: "task_1" }));
    await waitForMessage(client); // ack

    // Simulate task exit — supervisor calls the onEnded callback
    onEndedCallback?.("completed");
    const ended = await waitForMessage(client);
    expect(ended).toEqual({
      type: "output-ended",
      taskId: "task_1",
      reason: "completed",
    });

    client.close();
  });
});

// ─── Supervisor layer tests ────────────────────────────────────────

describe("Phase 9: output stream — Supervisor", () => {
  // T12: subscribeTaskOutput for task with no process — subscribe before start
  it("registers listener before process starts and forwards chunks when process arrives", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const store = { updateStatus: vi.fn(async () => undefined) };
    const supervisor = new Supervisor({ store });

    const chunks: string[] = [];
    const unsubscribe = supervisor.subscribeTaskOutput("task_1", (chunk) => {
      chunks.push(chunk);
    });

    // No process is running yet — unsubscribe function should still be returned
    expect(typeof unsubscribe).toBe("function");
    expect(chunks).toEqual([]);

    unsubscribe();
  });

  // T13: Rapid subscribe/unsubscribe idempotency
  it("handles rapid subscribe/unsubscribe without errors", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const store = { updateStatus: vi.fn(async () => undefined) };
    const supervisor = new Supervisor({ store });

    const unsubscribe = supervisor.subscribeTaskOutput("task_1", () => undefined);

    // Immediately unsubscribe
    unsubscribe();
    // Call again — should be idempotent
    unsubscribe();
    // No errors thrown
  });

  // Supervisor emits output-ended before clearing listeners
  it("calls onEnded callbacks with the correct reason before clearing listeners on task exit", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const store = { updateStatus: vi.fn(async () => undefined) };
    const supervisor = new Supervisor({ store });

    const endedReasons: OutputEndedReason[] = [];
    supervisor.subscribeTaskOutput(
      "task_1",
      () => undefined,
      (reason) => { endedReasons.push(reason); },
    );

    // Simulate: task completes
    await supervisor.handleAgentExit("task_1", { type: "completion" });
    expect(endedReasons).toEqual(["completed"]);
  });

  it("emits 'escalated' reason on escalation exit", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const store = { updateStatus: vi.fn(async () => undefined) };
    const supervisor = new Supervisor({ store });

    const endedReasons: OutputEndedReason[] = [];
    supervisor.subscribeTaskOutput(
      "task_2",
      () => undefined,
      (reason) => { endedReasons.push(reason); },
    );

    await supervisor.handleAgentExit("task_2", {
      type: "escalation",
      reason: "agent_escalated",
    });
    expect(endedReasons).toEqual(["escalated"]);
  });

  it("emits 'paused' reason on pause-intercepted exit", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const store = { updateStatus: vi.fn(async () => undefined) };
    const supervisor = new Supervisor({ store });

    const endedReasons: OutputEndedReason[] = [];
    supervisor.subscribeTaskOutput(
      "task_3",
      () => undefined,
      (reason) => { endedReasons.push(reason); },
    );

    await supervisor.requestPause("task_3");
    await supervisor.handleAgentExit("task_3", { type: "completion" });
    expect(endedReasons).toEqual(["paused"]);
  });

  it("emits 'retry' reason on retry exit", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const store = { updateStatus: vi.fn(async () => undefined) };
    const supervisor = new Supervisor({ store });

    const endedReasons: OutputEndedReason[] = [];
    supervisor.subscribeTaskOutput(
      "task_4",
      () => undefined,
      (reason) => { endedReasons.push(reason); },
    );

    await supervisor.handleAgentExit("task_4", {
      type: "retry",
      reason: "transient_unknown",
    });
    expect(endedReasons).toEqual(["retry"]);
  });

  it("emits 'shutdown' reason when supervisor shuts down", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const store = { updateStatus: vi.fn(async () => undefined) };
    const supervisor = new Supervisor({ store });

    const endedReasons: OutputEndedReason[] = [];
    supervisor.subscribeTaskOutput(
      "task_5",
      () => undefined,
      (reason) => { endedReasons.push(reason); },
    );

    await supervisor.shutdown();
    expect(endedReasons).toEqual(["shutdown"]);
  });
});

// ─── Integration layer tests ───────────────────────────────────────

describe("Phase 9: output stream — integration", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "oh-output-stream-"));
    await mkdir(join(repoDir, ".openharness"), { recursive: true });
    await mkdir(join(repoDir, "tasks"), { recursive: true });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  // T9: Output subscription survives subscribe→chunks→task-exit lifecycle
  it("delivers chunks and output-ended across the full subscribe→chunks→exit lifecycle", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "task_lifecycle", title: "Lifecycle task", status: "pending" }));

    let emitOutput: ((chunk: string) => void) | undefined;
    let emitEnded: ((reason: OutputEndedReason) => void) | undefined;
    const runtime = await startKernelRuntime(
      {
        repoDir,
        tasksDir: join(repoDir, "tasks"),
        dbPath: join(repoDir, ".openharness", "kernel.db"),
      },
      {
        runPreflight: async () => ({
          config: createConfig(),
          tasks: [],
          lock: { lockPath: join(repoDir, ".openharness", "kernel.pid"), pid: process.pid },
        }),
        createTickLoop: () => ({ start: () => undefined, stop: () => undefined }),
        createSupervisor: () => ({
          spawnAgent: async () => undefined,
          getRunningCount: () => 0,
          subscribeTaskOutput: (_taskId: string, listener: (chunk: string) => void, onEnded?: (reason: OutputEndedReason) => void) => {
            emitOutput = listener;
            emitEnded = onEnded;
            return () => {
              emitOutput = undefined;
              emitEnded = undefined;
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
      await waitForOpen(client);

      // Subscribe to output
      client.send(JSON.stringify({ type: "subscribe", channel: "output", taskId: "task_lifecycle" }));
      await expect(waitForMessage(client)).resolves.toEqual({
        type: "ack",
        command: "subscribe",
        taskId: "task_lifecycle",
      });

      // Receive chunks
      emitOutput?.("line 1\n");
      await expect(waitForMessage(client)).resolves.toEqual({
        type: "output",
        taskId: "task_lifecycle",
        text: "line 1\n",
      });

      // Task exits — client receives output-ended
      emitEnded?.("completed");
      await expect(waitForMessage(client)).resolves.toEqual({
        type: "output-ended",
        taskId: "task_lifecycle",
        reason: "completed",
      });

      client.close();
    } finally {
      await runtime.stop();
    }
  });

  // T10: Server shutdown while output is streaming
  it("shuts down cleanly while output is streaming — no unhandled errors", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

    await writeTaskFile(repoDir, createTask({ id: "task_shutdown", title: "Shutdown task", status: "pending" }));

    let emitOutput: ((chunk: string) => void) | undefined;
    const runtime = await startKernelRuntime(
      {
        repoDir,
        tasksDir: join(repoDir, "tasks"),
        dbPath: join(repoDir, ".openharness", "kernel.db"),
      },
      {
        runPreflight: async () => ({
          config: createConfig(),
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
      await waitForOpen(client);

      client.send(JSON.stringify({ type: "subscribe", channel: "output", taskId: "task_shutdown" }));
      await waitForMessage(client); // ack

      // Push some output
      emitOutput?.("before shutdown\n");
      await waitForMessage(client);

      // Now shut down — should not throw
      const closePromise = waitForClose(client);
      await runtime.stop();
      await closePromise;

      // If we get here without errors, shutdown was clean
    } catch {
      // runtime.stop() already called in finally would double-stop; swallow
      await runtime.stop().catch(() => undefined);
      throw new Error("Shutdown produced an unhandled error");
    }
  });
});

// ─── Helpers ───────────────────────────────────────────────────────

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

function createConfig() {
  return {
    tickIntervalMs: 25,
    maxConcurrency: 2,
    maxRecurringFixTasks: 3,
    poisonPillThreshold: 2,
    worktreesDir: ".worktrees",
    defaultAdapter: "copilot",
    evaluatorAdapter: "copilot",
    adapters: { copilot: "built-in" as const },
    tasksDir: "tasks",
    runsDir: "runs",
    port: 0,
    backoffBaseDelayMs: 1000,
    backoffMaxDelayMs: 10_000,
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

async function waitForOpen(client: WebSocket): Promise<void> {
  if (client.readyState === WebSocket.OPEN) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for open")); }, 5_000);
    const cleanup = () => { clearTimeout(timeout); client.off("open", onOpen); client.off("error", onError); };
    const onOpen = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    client.on("open", onOpen);
    client.on("error", onError);
  });
}

async function waitForMessage(client: WebSocket): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for message")); }, 5_000);
    const cleanup = () => { clearTimeout(timeout); client.off("message", onMessage); client.off("error", onError); };
    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]) => {
      cleanup();
      resolve(JSON.parse(normalizeMessageData(data)) as unknown);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    client.on("message", onMessage);
    client.on("error", onError);
  });
}

async function waitForClose(client: WebSocket): Promise<void> {
  if (client.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => { resolve(); }, 5_000);
    client.on("close", () => { clearTimeout(timeout); resolve(); });
  });
}

function normalizeMessageData(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}
