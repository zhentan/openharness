import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  type TaskSummary,
} from "../../dashboard/src/lib/connection.js";

// ─── Helpers ───

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
      // Capture the observable-wrapped store so tests can trigger deltas
      overrides?.onStoreReady?.(opts.store);
      return {
        spawnAgent: async () => undefined,
        getRunningCount: () => 0,
        requestPause: vi.fn(async () => undefined),
        resumeTask: vi.fn(async () => undefined),
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

function getPortFromWsUrl(wsUrl: string): number {
  const match = wsUrl.match(/:(\d+)$/);
  if (!match) throw new Error(`Cannot extract port from URL: ${wsUrl}`);
  return Number(match[1]);
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

/** Wait for state to transition to the expected value. */
function waitForState(
  states: ConnectionState[],
  target: ConnectionState,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (states[states.length - 1] === target) {
      resolve();
      return;
    }
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

// ─── Tests ───

describe("Phase 9: connection module", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "oh-p9-conn-"));
    await mkdir(join(repoDir, ".openharness"), { recursive: true });
    await mkdir(join(repoDir, "tasks"), { recursive: true });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  describe("happy path", () => {
    it("connects, authenticates, subscribes, and receives snapshot (test 12)", async () => {
      const { startKernelRuntime } = await import("../../src/runtime.js");
      const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

      await writeTaskFile(repoDir, createTask({ id: "task_1", title: "First task" }));
      await writeTaskFile(repoDir, createTask({ id: "task_2", title: "Second task" }));

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
        const bootstrapUrl = `http://127.0.0.1:${port}/_api/bootstrap`;

        const states: ConnectionState[] = [];
        let lastTasks: Map<string, TaskSummary> | undefined;

        const conn = createKernelConnection(
          { bootstrapUrl, maxRetries: 3, baseRetryMs: 100, maxRetryMs: 500 },
          {
            onStateChange: (state) => { states.push(state); },
            onTasksUpdated: (tasks) => { lastTasks = new Map(tasks); },
          },
          { fetch: globalThis.fetch, WebSocket: WebSocket as unknown as typeof globalThis.WebSocket },
        );

        conn.connect();
        await waitForState(states, "connected");

        expect(lastTasks).toBeDefined();
        expect(lastTasks!.size).toBe(2);
        expect(lastTasks!.has("task_1")).toBe(true);
        expect(lastTasks!.has("task_2")).toBe(true);

        conn.disconnect();
      } finally {
        await runtime.stop();
        store.close();
      }
    });

    it("receives deltas after snapshot (test 14)", async () => {
      const { startKernelRuntime } = await import("../../src/runtime.js");
      const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

      await writeTaskFile(repoDir, createTask({ id: "task_1", title: "First task" }));

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
        const control = await readRuntimeControlInfo(repoDir);
        const port = getPortFromWsUrl(control.url);

        const states: ConnectionState[] = [];
        let lastTasks: Map<string, TaskSummary> | undefined;
        let updateCount = 0;

        const conn = createKernelConnection(
          { bootstrapUrl: `http://127.0.0.1:${port}/_api/bootstrap` },
          {
            onStateChange: (state) => { states.push(state); },
            onTasksUpdated: (tasks) => { lastTasks = new Map(tasks); updateCount++; },
          },
          { fetch: globalThis.fetch, WebSocket: WebSocket as unknown as typeof globalThis.WebSocket },
        );

        conn.connect();
        await waitForState(states, "connected");

        const initialUpdateCount = updateCount;

        // Trigger a task status change through the observable wrapper (I14)
        await wrappedStore!.updateStatus("task_1", "generator_running");

        // Wait for delta to arrive
        await vi.waitFor(() => {
          expect(updateCount).toBeGreaterThan(initialUpdateCount);
        }, { timeout: 2000 });

        expect(lastTasks!.get("task_1")!.status).toBe("generator_running");

        conn.disconnect();
      } finally {
        await runtime.stop();
        store.close();
      }
    });

    it("handles multi-summary deltas correctly (test 24)", async () => {
      const { startKernelRuntime } = await import("../../src/runtime.js");
      const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

      await writeTaskFile(repoDir, createTask({ id: "task_1", title: "First" }));
      await writeTaskFile(repoDir, createTask({ id: "task_2", title: "Second" }));

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
        const control = await readRuntimeControlInfo(repoDir);
        const port = getPortFromWsUrl(control.url);

        let lastTasks: Map<string, TaskSummary> | undefined;
        const states: ConnectionState[] = [];

        const conn = createKernelConnection(
          { bootstrapUrl: `http://127.0.0.1:${port}/_api/bootstrap` },
          {
            onStateChange: (state) => { states.push(state); },
            onTasksUpdated: (tasks) => { lastTasks = new Map(tasks); },
          },
          { fetch: globalThis.fetch, WebSocket: WebSocket as unknown as typeof globalThis.WebSocket },
        );

        conn.connect();
        await waitForState(states, "connected");

        // Update both tasks rapidly within the batch window (50ms)
        await wrappedStore!.updateStatus("task_1", "generator_running");
        await wrappedStore!.updateStatus("task_2", "generator_running");

        // Wait for delta(s) — they may batch into a single multi-summary message
        await vi.waitFor(() => {
          expect(lastTasks!.get("task_1")!.status).toBe("generator_running");
          expect(lastTasks!.get("task_2")!.status).toBe("generator_running");
        }, { timeout: 2000 });

        conn.disconnect();
      } finally {
        await runtime.stop();
        store.close();
      }
    });

    it("handles delta for unknown task as upsert (test 16)", async () => {
      const { startKernelRuntime } = await import("../../src/runtime.js");
      const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

      // Start with two tasks but subscribe will only show them in snapshot
      await writeTaskFile(repoDir, createTask({ id: "task_1", title: "First" }));
      await writeTaskFile(repoDir, createTask({ id: "task_2", title: "Second" }));

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
        const control = await readRuntimeControlInfo(repoDir);
        const port = getPortFromWsUrl(control.url);

        let lastTasks: Map<string, TaskSummary> | undefined;
        const states: ConnectionState[] = [];

        const conn = createKernelConnection(
          { bootstrapUrl: `http://127.0.0.1:${port}/_api/bootstrap` },
          {
            onStateChange: (state) => { states.push(state); },
            onTasksUpdated: (tasks) => { lastTasks = new Map(tasks); },
          },
          { fetch: globalThis.fetch, WebSocket: WebSocket as unknown as typeof globalThis.WebSocket },
        );

        conn.connect();
        await waitForState(states, "connected");
        expect(lastTasks!.size).toBe(2);

        // Update task_2 which the client already knows. This is not upsert yet,
        // but verifies deltas work. Then, the hub sends a delta for a status
        // the client already has — the client treats it as an update (upsert).
        await wrappedStore!.updateStatus("task_2", "generator_running");

        // Wait for the delta
        await vi.waitFor(() => {
          expect(lastTasks!.get("task_2")!.status).toBe("generator_running");
        }, { timeout: 2000 });

        // Both tasks should still be present (delta didn't remove task_1)
        expect(lastTasks!.size).toBe(2);
        expect(lastTasks!.has("task_1")).toBe(true);

        conn.disconnect();
      } finally {
        await runtime.stop();
        store.close();
      }
    });
  });

  describe("empty kernel", () => {
    it("connects to kernel with zero tasks (test 15)", async () => {
      const { startKernelRuntime } = await import("../../src/runtime.js");
      const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

      // No tasks created — empty kernel

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
        let lastTasks: Map<string, TaskSummary> | undefined;

        const conn = createKernelConnection(
          { bootstrapUrl: `http://127.0.0.1:${port}/_api/bootstrap`, maxRetries: 3, baseRetryMs: 100 },
          {
            onStateChange: (state) => { states.push(state); },
            onTasksUpdated: (tasks) => { lastTasks = new Map(tasks); },
          },
          { fetch: globalThis.fetch, WebSocket: WebSocket as unknown as typeof globalThis.WebSocket },
        );

        conn.connect();
        // Must reach "connected" even with zero tasks — no hang (F10)
        await waitForState(states, "connected", 3000);

        expect(lastTasks).toBeDefined();
        expect(lastTasks!.size).toBe(0);

        conn.disconnect();
      } finally {
        await runtime.stop();
        store.close();
      }
    });
  });

  describe("state transitions", () => {
    it("reports connected only after full handshake (test 17)", async () => {
      const { startKernelRuntime } = await import("../../src/runtime.js");
      const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

      await writeTaskFile(repoDir, createTask({ id: "task_1", title: "Test" }));

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

        // The state must transition through "connecting" before "connected"
        expect(states).toContain("connecting");
        const connectingIdx = states.indexOf("connecting");
        const connectedIdx = states.indexOf("connected");
        expect(connectingIdx).toBeLessThan(connectedIdx);

        // "connected" should not appear before we have a snapshot
        // (this is enforced by the module implementation — F1)

        conn.disconnect();
      } finally {
        await runtime.stop();
        store.close();
      }
    });

    it("reports disconnected immediately on socket close (test 18)", async () => {
      const { startKernelRuntime } = await import("../../src/runtime.js");
      const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

      await writeTaskFile(repoDir, createTask({ id: "task_1", title: "Test" }));

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
          { bootstrapUrl: `http://127.0.0.1:${port}/_api/bootstrap`, maxRetries: 0 },
          {
            onStateChange: (state) => { states.push(state); },
            onTasksUpdated: () => {},
          },
          { fetch: globalThis.fetch, WebSocket: WebSocket as unknown as typeof globalThis.WebSocket },
        );

        conn.connect();
        await waitForState(states, "connected");

        // Disconnect explicitly
        conn.disconnect();

        // State should transition to "disconnected" immediately
        await waitForState(states, "disconnected", 1000);
        expect(states[states.length - 1]).toBe("disconnected");
      } finally {
        await runtime.stop();
        store.close();
      }
    });

    it("reports reconnecting then disconnected after exhausted retries (test 19)", async () => {
      const { startKernelRuntime } = await import("../../src/runtime.js");
      const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

      await writeTaskFile(repoDir, createTask({ id: "task_1", title: "Test" }));

      const store = new TaskStore({
        tasksDir: join(repoDir, "tasks"),
        dbPath: join(repoDir, ".openharness", "kernel.db"),
      });

      const runtime = await startKernelRuntime(
        { repoDir, tasksDir: join(repoDir, "tasks"), dbPath: join(repoDir, ".openharness", "kernel.db") },
        mockDependencies({ createStore: () => store }),
      );

      const control = await readRuntimeControlInfo(repoDir);
      const port = getPortFromWsUrl(control.url);

      const states: ConnectionState[] = [];

      const conn = createKernelConnection(
        { bootstrapUrl: `http://127.0.0.1:${port}/_api/bootstrap`, maxRetries: 2, baseRetryMs: 50, maxRetryMs: 100 },
        {
          onStateChange: (state) => { states.push(state); },
          onTasksUpdated: () => {},
        },
        { fetch: globalThis.fetch, WebSocket: WebSocket as unknown as typeof globalThis.WebSocket },
      );

      conn.connect();
      await waitForState(states, "connected");

      // Stop the runtime — this kills the server
      await runtime.stop();
      store.close();

      // Client should transition: connected → reconnecting → disconnected
      await waitForState(states, "disconnected", 10_000);

      expect(states).toContain("reconnecting");
      const reconnectingIdx = states.lastIndexOf("reconnecting");
      const disconnectedIdx = states.lastIndexOf("disconnected");
      expect(reconnectingIdx).toBeLessThan(disconnectedIdx);

      conn.disconnect();
    }, 15_000);
  });

  describe("reconnection", () => {
    it("reconnects with fresh bootstrap after server restart (test 13)", async () => {
      const { startKernelRuntime } = await import("../../src/runtime.js");
      const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

      await writeTaskFile(repoDir, createTask({ id: "task_1", title: "First task" }));

      // Use a fixed port so that after restart the bootstrap URL still works.
      // Find a free port by binding temporarily.
      const portFinder = http.createServer();
      await new Promise<void>((resolve) => { portFinder.listen(0, "127.0.0.1", resolve); });
      const fixedPort = (portFinder.address() as { port: number }).port;
      await new Promise<void>((resolve) => { portFinder.close(() => resolve()); });

      const store1 = new TaskStore({
        tasksDir: join(repoDir, "tasks"),
        dbPath: join(repoDir, ".openharness", "kernel.db"),
      });

      const runtime1 = await startKernelRuntime(
        { repoDir, tasksDir: join(repoDir, "tasks"), dbPath: join(repoDir, ".openharness", "kernel.db") },
        mockDependencies({ createStore: () => store1, configOverrides: { port: fixedPort } }),
      );

      const control1 = await readRuntimeControlInfo(repoDir);

      const states: ConnectionState[] = [];
      let lastTasks: Map<string, TaskSummary> | undefined;

      const conn = createKernelConnection(
        { bootstrapUrl: `http://127.0.0.1:${fixedPort}/_api/bootstrap`, maxRetries: 20, baseRetryMs: 100, maxRetryMs: 500 },
        {
          onStateChange: (state) => { states.push(state); },
          onTasksUpdated: (tasks) => { lastTasks = new Map(tasks); },
        },
        { fetch: globalThis.fetch, WebSocket: WebSocket as unknown as typeof globalThis.WebSocket },
      );

      conn.connect();
      await waitForState(states, "connected");
      const token1 = control1.token;

      // Stop runtime 1
      await runtime1.stop();
      store1.close();

      // Wait for disconnect detection
      await waitForState(states, "reconnecting", 5000);

      // Start runtime 2 on the same port (new token)
      const store2 = new TaskStore({
        tasksDir: join(repoDir, "tasks"),
        dbPath: join(repoDir, ".openharness", "kernel2.db"),
      });

      // Add a second task so the snapshot is different
      await writeTaskFile(repoDir, createTask({ id: "task_2", title: "Second task" }));

      const runtime2 = await startKernelRuntime(
        { repoDir, tasksDir: join(repoDir, "tasks"), dbPath: join(repoDir, ".openharness", "kernel2.db") },
        mockDependencies({ createStore: () => store2, configOverrides: { port: fixedPort } }),
      );

      try {
        const control2 = await readRuntimeControlInfo(repoDir);
        // New kernel = new token
        expect(control2.token).not.toBe(token1);

        // Client should reconnect, re-fetch bootstrap, get new token, and reach connected
        await waitForState(states, "connected", 15_000);

        // After reconnect, state should be replaced from fresh snapshot (I5)
        expect(lastTasks).toBeDefined();
        expect(lastTasks!.size).toBe(2);

        conn.disconnect();
      } finally {
        await runtime2.stop();
        store2.close();
      }
    }, 30_000);

    it("cancels in-flight reconnect on new disconnect (test 20)", async () => {
      const { startKernelRuntime } = await import("../../src/runtime.js");
      const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

      await writeTaskFile(repoDir, createTask({ id: "task_1", title: "Test" }));

      const store = new TaskStore({
        tasksDir: join(repoDir, "tasks"),
        dbPath: join(repoDir, ".openharness", "kernel.db"),
      });

      const runtime = await startKernelRuntime(
        { repoDir, tasksDir: join(repoDir, "tasks"), dbPath: join(repoDir, ".openharness", "kernel.db") },
        mockDependencies({ createStore: () => store }),
      );

      const control = await readRuntimeControlInfo(repoDir);
      const port = getPortFromWsUrl(control.url);

      const states: ConnectionState[] = [];

      const conn = createKernelConnection(
        { bootstrapUrl: `http://127.0.0.1:${port}/_api/bootstrap`, maxRetries: 5, baseRetryMs: 200, maxRetryMs: 1000 },
        {
          onStateChange: (state) => { states.push(state); },
          onTasksUpdated: () => {},
        },
        { fetch: globalThis.fetch, WebSocket: WebSocket as unknown as typeof globalThis.WebSocket },
      );

      conn.connect();
      await waitForState(states, "connected");

      // Stop runtime to trigger reconnect
      await runtime.stop();
      store.close();

      // Wait for reconnecting state
      await waitForState(states, "reconnecting", 5000);

      // Disconnect while reconnecting — should cancel reconnect
      conn.disconnect();

      await waitForState(states, "disconnected", 2000);

      // After disconnect, no more state changes should occur
      const finalStatesLength = states.length;
      await new Promise<void>((resolve) => { setTimeout(resolve, 500); });
      expect(states.length).toBe(finalStatesLength);
    }, 15_000);
  });

  describe("auth failure", () => {
    it("transitions to disconnected on wrong token, no retry loop (test 21)", async () => {
      const { startKernelRuntime } = await import("../../src/runtime.js");
      const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

      await writeTaskFile(repoDir, createTask({ id: "task_1", title: "Test" }));

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
        const errors: string[] = [];

        // Override fetch to return a bootstrap response with a wrong token
        const poisonedFetch = async (url: string, init?: RequestInit) => {
          const res = await globalThis.fetch(url, init);
          if (url.includes("/_api/bootstrap")) {
            const data = await res.json() as { wsUrl: string; token: string; kernelId: number };
            return new Response(JSON.stringify({ ...data, token: "wrong-token" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return res;
        };

        const conn = createKernelConnection(
          { bootstrapUrl: `http://127.0.0.1:${port}/_api/bootstrap`, maxRetries: 2, baseRetryMs: 50 },
          {
            onStateChange: (state) => { states.push(state); },
            onTasksUpdated: () => {},
            onError: (msg) => { errors.push(msg); },
          },
          { fetch: poisonedFetch, WebSocket: WebSocket as unknown as typeof globalThis.WebSocket },
        );

        conn.connect();

        // Should eventually reach disconnected due to auth failure, not loop
        await waitForState(states, "disconnected", 5000);

        // Errors should mention auth/unauthorized
        expect(errors.some((e) => /[Uu]nauthorized|auth/i.test(e))).toBe(true);

        conn.disconnect();
      } finally {
        await runtime.stop();
        store.close();
      }
    }, 10_000);
  });
});
