// Phase 9, Slice 8: Connection module control tests (CT1-CT8)
// Written BEFORE implementation per reviewer acceptance criteria in
// docs/phase9/reviews/controls.md Section 8.
//
// These tests verify the connection module's pauseTask/resumeTask/killTask
// methods follow the ack/delta split: ack = receipt, delta = state change.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { TaskStore } from "../../src/store/task-store.js";
import type { KernelConfig, Task } from "../../src/types.js";
import {
  createKernelConnection,
  type ConnectionState,
  type KernelConnection,
  type ControlResult,
  type TaskSummary,
} from "../../dashboard/src/lib/connection.js";

// ─── Helpers (shared with connection-module.test.ts) ───

function createMockConfig(overrides?: Partial<KernelConfig>): KernelConfig {
  return {
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
    ...overrides,
  };
}

interface RuntimeStore {
  list(options?: { initializeMissingState?: boolean }): Promise<Task[]>;
  get?(taskId: string): Promise<Task | null>;
  updateStatus(taskId: string, status: Task["status"], metadata?: Record<string, unknown>): Promise<void>;
  createTask?(task: Task): Promise<void>;
  close?(): void;
}

function mockDependencies(overrides?: Record<string, unknown> & { onStoreReady?: (store: RuntimeStore) => void }) {
  return {
    runPreflight: async (options: { repoDir: string }) => ({
      config: createMockConfig(overrides?.configOverrides as Partial<KernelConfig>),
      tasks: [],
      lock: { lockPath: join(options.repoDir, ".openharness", "kernel.pid"), pid: process.pid },
    }),
    createStore: overrides?.createStore as (() => TaskStore) | undefined,
    createSupervisor: (opts: { store: RuntimeStore }) => {
      overrides?.onStoreReady?.(opts.store);
      return {
        spawnAgent: async () => undefined,
        getRunningCount: () => 0,
        hasRunningProcess: (taskId: string) => {
          // Simulate running process for tasks we mark as running
          return (overrides?.runningTasks as Set<string>)?.has(taskId) ?? false;
        },
        requestPause: vi.fn(async () => undefined),
        resumeTask: vi.fn(async () => undefined),
        killTask: vi.fn(async () => undefined),
      };
    },
    createKernel: () => ({
      reconcileStartupState: async () => undefined,
      tick: async () => undefined,
      handleCrash: async () => undefined,
    }),
    createTickLoop: () => ({ start: () => undefined, stop: () => undefined }),
    ...overrides,
  };
}

function createTask(overrides: Partial<Task> & { id: string; title: string }): Task {
  return {
    status: "pending",
    priority: "medium",
    depends_on: [],
    agent_prompt: "test prompt",
    exploration_budget: { max_attempts: 3, timeout_per_attempt: 5, total_timeout: 15 },
    escalation_rules: [],
    ...overrides,
  };
}

async function writeTaskFile(repoDir: string, task: Task): Promise<void> {
  const taskPath = join(repoDir, "tasks", `${task.id}.yaml`);
  const { stringify } = await import("yaml");
  await writeFile(taskPath, stringify(task), "utf8");
}

function waitForState(
  states: ConnectionState[],
  target: ConnectionState,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (states[states.length - 1] === target) { resolve(); return; }
    const interval = setInterval(() => {
      if (states[states.length - 1] === target) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve();
      }
    }, 10);
    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timed out waiting for state "${target}". States seen: ${JSON.stringify(states)}`));
    }, timeoutMs);
  });
}

function getPortFromWsUrl(wsUrl: string): number {
  const match = wsUrl.match(/:(\d+)$/);
  if (!match) throw new Error(`Cannot extract port from URL: ${wsUrl}`);
  return Number(match[1]);
}

// ─── Tests ───

describe("Phase 9, Slice 8: connection module controls", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "oh-p9-ctrl-"));
    await mkdir(join(repoDir, ".openharness"), { recursive: true });
    await mkdir(join(repoDir, "tasks"), { recursive: true });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  // CT1: pauseTask sends pause message and resolves on ack
  it("CT1: pauseTask sends pause request and resolves with ok on ack", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

    const runningTasks = new Set(["task_1"]);
    await writeTaskFile(repoDir, createTask({ id: "task_1", title: "Running task", status: "generator_running" }));

    let wrappedStore: RuntimeStore | undefined;
    const store = new TaskStore({
      tasksDir: join(repoDir, "tasks"),
      dbPath: join(repoDir, ".openharness", "kernel.db"),
    });

    const runtime = await startKernelRuntime(
      { repoDir, tasksDir: join(repoDir, "tasks"), dbPath: join(repoDir, ".openharness", "kernel.db") },
      mockDependencies({
        createStore: () => store,
        onStoreReady: (s) => { wrappedStore = s; },
        runningTasks,
      }),
    );

    try {
      const control = await readRuntimeControlInfo(repoDir);
      const port = getPortFromWsUrl(control.url);
      const states: ConnectionState[] = [];

      const conn = createKernelConnection(
        { bootstrapUrl: `http://127.0.0.1:${port}/_api/bootstrap` },
        {
          onStateChange: (state) => { states.push(state); },
          onTasksUpdated: () => {},
        },
        { fetch: globalThis.fetch, WebSocket: WebSocket as unknown as typeof globalThis.WebSocket },
      );

      conn.connect();
      await waitForState(states, "connected");

      // pauseTask should resolve with { ok: true } after ack
      const result = await conn.pauseTask("task_1");
      expect(result).toEqual({ ok: true });

      conn.disconnect();
    } finally {
      await runtime.stop();
      store.close();
    }
  });

  // CT2: resumeTask sends resume request and resolves on ack
  it("CT2: resumeTask resolves with ok on ack", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

    // Start as pending, then transition to paused through the store
    await writeTaskFile(repoDir, createTask({ id: "task_1", title: "Paused task" }));

    let wrappedStore: RuntimeStore | undefined;
    const store = new TaskStore({
      tasksDir: join(repoDir, "tasks"),
      dbPath: join(repoDir, ".openharness", "kernel.db"),
    });

    const runtime = await startKernelRuntime(
      { repoDir, tasksDir: join(repoDir, "tasks"), dbPath: join(repoDir, ".openharness", "kernel.db") },
      mockDependencies({
        createStore: () => store,
        onStoreReady: (s) => { wrappedStore = s; },
      }),
    );

    try {
      // Transition the task to paused through the store so runtime sees it
      await wrappedStore!.updateStatus("task_1", "paused");

      const control = await readRuntimeControlInfo(repoDir);
      const port = getPortFromWsUrl(control.url);
      const states: ConnectionState[] = [];

      const conn = createKernelConnection(
        { bootstrapUrl: `http://127.0.0.1:${port}/_api/bootstrap` },
        {
          onStateChange: (state) => { states.push(state); },
          onTasksUpdated: () => {},
        },
        { fetch: globalThis.fetch, WebSocket: WebSocket as unknown as typeof globalThis.WebSocket },
      );

      conn.connect();
      await waitForState(states, "connected");

      const result = await conn.resumeTask("task_1");
      expect(result).toEqual({ ok: true });

      conn.disconnect();
    } finally {
      await runtime.stop();
      store.close();
    }
  });

  // CT3: killTask sends kill request and resolves on ack
  it("CT3: killTask resolves with ok on ack", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

    const runningTasks = new Set(["task_1"]);
    await writeTaskFile(repoDir, createTask({ id: "task_1", title: "Running task", status: "generator_running" }));

    const store = new TaskStore({
      tasksDir: join(repoDir, "tasks"),
      dbPath: join(repoDir, ".openharness", "kernel.db"),
    });

    const runtime = await startKernelRuntime(
      { repoDir, tasksDir: join(repoDir, "tasks"), dbPath: join(repoDir, ".openharness", "kernel.db") },
      mockDependencies({ createStore: () => store, runningTasks }),
    );

    try {
      const control = await readRuntimeControlInfo(repoDir);
      const port = getPortFromWsUrl(control.url);
      const states: ConnectionState[] = [];

      const conn = createKernelConnection(
        { bootstrapUrl: `http://127.0.0.1:${port}/_api/bootstrap` },
        {
          onStateChange: (state) => { states.push(state); },
          onTasksUpdated: () => {},
        },
        { fetch: globalThis.fetch, WebSocket: WebSocket as unknown as typeof globalThis.WebSocket },
      );

      conn.connect();
      await waitForState(states, "connected");

      const result = await conn.killTask("task_1");
      expect(result).toEqual({ ok: true });

      conn.disconnect();
    } finally {
      await runtime.stop();
      store.close();
    }
  });

  // CT4: control on invalid state returns error result
  it("CT4: pauseTask on paused task returns error result", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

    // Task is paused, no running process — pause should fail
    await writeTaskFile(repoDir, createTask({ id: "task_1", title: "Paused task", status: "paused" }));

    const store = new TaskStore({
      tasksDir: join(repoDir, "tasks"),
      dbPath: join(repoDir, ".openharness", "kernel.db"),
    });

    const runtime = await startKernelRuntime(
      { repoDir, tasksDir: join(repoDir, "tasks"), dbPath: join(repoDir, ".openharness", "kernel.db") },
      mockDependencies({ createStore: () => store }),
    );

    try {
      const control = await readRuntimeControlInfo(repoDir);
      const port = getPortFromWsUrl(control.url);
      const states: ConnectionState[] = [];

      const conn = createKernelConnection(
        { bootstrapUrl: `http://127.0.0.1:${port}/_api/bootstrap` },
        {
          onStateChange: (state) => { states.push(state); },
          onTasksUpdated: () => {},
        },
        { fetch: globalThis.fetch, WebSocket: WebSocket as unknown as typeof globalThis.WebSocket },
      );

      conn.connect();
      await waitForState(states, "connected");

      const result = await conn.pauseTask("task_1");
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toContain("Cannot pause");

      conn.disconnect();
    } finally {
      await runtime.stop();
      store.close();
    }
  });

  // CT5: control rejects immediately when disconnected
  it("CT5: pauseTask rejects when not connected", async () => {
    const conn = createKernelConnection(
      { bootstrapUrl: "http://localhost:0/_api/bootstrap" },
      {
        onStateChange: () => {},
        onTasksUpdated: () => {},
      },
      { fetch: globalThis.fetch, WebSocket: WebSocket as unknown as typeof globalThis.WebSocket },
    );

    // Not connected — should reject immediately
    const result = await conn.pauseTask("task_1");
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("Not connected");
  });

  // CT6: control timeout returns error (simulated by mock)
  it("CT6: control times out if no ack within timeout", async () => {
    // Use a mock WebSocket that accepts but never responds to control messages
    let capturedSend: ((data: string) => void) | undefined;

    const mockWs = {
      readyState: 1, // OPEN
      OPEN: 1,
      CONNECTING: 0,
      send: vi.fn(),
      close: vi.fn(),
      onopen: null as (() => void) | null,
      onmessage: null as ((event: { data: string }) => void) | null,
      onclose: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ wsUrl: "ws://localhost:0", token: "test-token", kernelId: 1 }),
    });

    const conn = createKernelConnection(
      { bootstrapUrl: "http://localhost:0/_api/bootstrap", ackTimeoutMs: 100 },
      {
        onStateChange: () => {},
        onTasksUpdated: () => {},
      },
      {
        fetch: mockFetch as unknown as typeof globalThis.fetch,
        WebSocket: function () { return mockWs; } as unknown as typeof globalThis.WebSocket,
      },
    );

    conn.connect();

    // Simulate WebSocket open → auth ack → snapshot
    await vi.waitFor(() => { expect(mockWs.onopen).toBeTruthy(); });
    mockWs.onopen!();

    // Wait for auth send, then send auth ack
    await vi.waitFor(() => { expect(mockWs.send).toHaveBeenCalled(); });
    mockWs.onmessage!({ data: JSON.stringify({ type: "ack", command: "authenticate" }) });

    // Wait for subscribe send, then send snapshot
    await vi.waitFor(() => { expect(mockWs.send).toHaveBeenCalledTimes(2); });
    mockWs.onmessage!({
      data: JSON.stringify({
        type: "snapshot",
        sequence: 1,
        counts: {},
        tasks: [{ taskId: "task_1", title: "Test", status: "generator_running", updatedAt: new Date().toISOString() }],
      }),
    });

    // Now send a pause — the mock WS will never respond
    const resultPromise = conn.pauseTask("task_1");

    // Should timeout and return error
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("timed out");

    conn.disconnect();
  });

  // CT7: disconnect while control pending rejects the pending promise
  it("CT7: disconnect while control pending returns error", async () => {
    const mockWs = {
      readyState: 1,
      OPEN: 1,
      CONNECTING: 0,
      send: vi.fn(),
      close: vi.fn(),
      onopen: null as (() => void) | null,
      onmessage: null as ((event: { data: string }) => void) | null,
      onclose: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ wsUrl: "ws://localhost:0", token: "test-token", kernelId: 1 }),
    });

    const conn = createKernelConnection(
      { bootstrapUrl: "http://localhost:0/_api/bootstrap", ackTimeoutMs: 5000 },
      {
        onStateChange: () => {},
        onTasksUpdated: () => {},
      },
      {
        fetch: mockFetch as unknown as typeof globalThis.fetch,
        WebSocket: function () { return mockWs; } as unknown as typeof globalThis.WebSocket,
      },
    );

    conn.connect();
    await vi.waitFor(() => { expect(mockWs.onopen).toBeTruthy(); });
    mockWs.onopen!();
    await vi.waitFor(() => { expect(mockWs.send).toHaveBeenCalled(); });
    mockWs.onmessage!({ data: JSON.stringify({ type: "ack", command: "authenticate" }) });
    await vi.waitFor(() => { expect(mockWs.send).toHaveBeenCalledTimes(2); });
    mockWs.onmessage!({
      data: JSON.stringify({
        type: "snapshot", sequence: 1, counts: {},
        tasks: [{ taskId: "task_1", title: "Test", status: "generator_running", updatedAt: new Date().toISOString() }],
      }),
    });

    const resultPromise = conn.pauseTask("task_1");

    // Disconnect while pending
    conn.disconnect();

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("closed");
  });

  // CT8: concurrent controls on different tasks both resolve independently
  it("CT8: concurrent controls on different tasks resolve independently", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");
    const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

    const runningTasks = new Set(["task_1", "task_2"]);
    await writeTaskFile(repoDir, createTask({ id: "task_1", title: "Running 1", status: "generator_running" }));
    await writeTaskFile(repoDir, createTask({ id: "task_2", title: "Running 2", status: "generator_running" }));

    const store = new TaskStore({
      tasksDir: join(repoDir, "tasks"),
      dbPath: join(repoDir, ".openharness", "kernel.db"),
    });

    const runtime = await startKernelRuntime(
      { repoDir, tasksDir: join(repoDir, "tasks"), dbPath: join(repoDir, ".openharness", "kernel.db") },
      mockDependencies({ createStore: () => store, runningTasks }),
    );

    try {
      const control = await readRuntimeControlInfo(repoDir);
      const port = getPortFromWsUrl(control.url);
      const states: ConnectionState[] = [];

      const conn = createKernelConnection(
        { bootstrapUrl: `http://127.0.0.1:${port}/_api/bootstrap` },
        {
          onStateChange: (state) => { states.push(state); },
          onTasksUpdated: () => {},
        },
        { fetch: globalThis.fetch, WebSocket: WebSocket as unknown as typeof globalThis.WebSocket },
      );

      conn.connect();
      await waitForState(states, "connected");

      // Fire both controls concurrently
      const [result1, result2] = await Promise.all([
        conn.pauseTask("task_1"),
        conn.pauseTask("task_2"),
      ]);

      expect(result1).toEqual({ ok: true });
      expect(result2).toEqual({ ok: true });

      conn.disconnect();
    } finally {
      await runtime.stop();
      store.close();
    }
  });
});
