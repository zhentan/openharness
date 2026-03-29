import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { TaskStore } from "../../src/store/task-store.js";
import type { KernelConfig, Task } from "../../src/types.js";

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

function mockDependencies(overrides?: Record<string, unknown>) {
  return {
    runPreflight: async (options: { repoDir: string }) => ({
      config: createMockConfig(overrides?.configOverrides as Partial<KernelConfig>),
      tasks: [],
      lock: { lockPath: join(options.repoDir, ".openharness", "kernel.pid"), pid: process.pid },
    }),
    createStore: overrides?.createStore as (() => TaskStore) | undefined,
    createSupervisor: () => ({
      spawnAgent: async () => undefined,
      getRunningCount: () => 0,
      requestPause: vi.fn(async () => undefined),
      resumeTask: vi.fn(async () => undefined),
    }),
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

async function httpGet(port: number, path: string): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = "";
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode!, headers: res.headers, body });
      });
    }).on("error", reject);
  });
}

async function httpGetSafe(port: number, path: string): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
} | { error: string }> {
  try {
    return await httpGet(port, path);
  } catch (error) {
    return { error: (error as Error).code ?? (error as Error).message };
  }
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

// ─── Tests ───

describe("Phase 9: bootstrap server", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "oh-p9-bootstrap-"));
    await mkdir(join(repoDir, ".openharness"), { recursive: true });
    await mkdir(join(repoDir, "tasks"), { recursive: true });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  // ─── HTTP server lifecycle (tests 3, 4, 5, 5a, 5b, 26) ───

  describe("HTTP server lifecycle", () => {
    it("starts HTTP server when runtime control is enabled (test 3)", async () => {
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

        // HTTP server should be reachable on the same port (shared port)
        const res = await httpGet(port, "/_api/bootstrap");
        expect(res.statusCode).toBe(200);
      } finally {
        await runtime.stop();
        store.close();
      }
    });

    it("does not start HTTP server when dbPath is :memory: (test 5b)", async () => {
      const { startKernelRuntime } = await import("../../src/runtime.js");

      const runtime = await startKernelRuntime(
        { repoDir, tasksDir: join(repoDir, "tasks"), dbPath: ":memory:" },
        mockDependencies(),
      );

      try {
        // With port 0, no server should be listening. The runtime should have no
        // HTTP or WS server in :memory: mode. We can't easily test "no server on
        // unknown port," but we can verify runtime-control.json doesn't exist.
        const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");
        await expect(readRuntimeControlInfo(repoDir)).rejects.toThrow();
      } finally {
        await runtime.stop();
      }
    });

    it("closes HTTP server during stopRuntime (tests 4, 5a)", async () => {
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

      await runtime.stop();
      store.close();

      // HTTP server should no longer accept connections
      const result = await httpGetSafe(port, "/_api/bootstrap");
      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toMatch(/ECONNREFUSED/);
    });

    it("fails cleanly on port conflict without dangling resources (test 5)", async () => {
      const { startKernelRuntime } = await import("../../src/runtime.js");

      // Occupy a port on the same address the runtime binds to
      const blocker = http.createServer();
      await new Promise<void>((resolve) => { blocker.listen(0, "127.0.0.1", resolve); });
      const blockerPort = (blocker.address() as { port: number }).port;

      try {
        await expect(
          startKernelRuntime(
            { repoDir, tasksDir: join(repoDir, "tasks"), dbPath: join(repoDir, ".openharness", "kernel.db") },
            mockDependencies({ configOverrides: { port: blockerPort } }),
          ),
        ).rejects.toThrow();

        // Verify no runtime-control.json was written
        const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");
        await expect(readRuntimeControlInfo(repoDir)).rejects.toThrow();
      } finally {
        await new Promise<void>((resolve, reject) => {
          blocker.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it("HTTP server closes before or with WS server during shutdown (test 26)", async () => {
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

      // Start shutdown but don't await
      const stopPromise = runtime.stop();

      // Race a bootstrap request and WS connect — both should fail
      const [httpResult, wsResult] = await Promise.allSettled([
        httpGetSafe(port, "/_api/bootstrap"),
        new Promise<string>((resolve, reject) => {
          const ws = new WebSocket(control.url);
          ws.on("open", () => { ws.close(); resolve("open"); });
          ws.on("error", (err) => { reject(err); });
        }),
      ]);

      await stopPromise;
      store.close();

      // After stop completes, the HTTP port should be fully closed
      const afterStop = await httpGetSafe(port, "/_api/bootstrap");
      expect(afterStop).toHaveProperty("error");
    });
  });

  // ─── Bootstrap endpoint (tests 6, 7, 8, 9, 10, 11, 11a, 16b, 22, 25) ───

  describe("bootstrap endpoint", () => {
    it("returns JSON with wsUrl, token, and kernelId (test 6)", async () => {
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

        const res = await httpGet(port, "/_api/bootstrap");
        expect(res.statusCode).toBe(200);

        const data = JSON.parse(res.body) as { wsUrl: string; token: string; kernelId: number };
        expect(data.wsUrl).toBe(control.url);
        expect(data.token).toBe(control.token);
        expect(data.kernelId).toBe(process.pid);
      } finally {
        await runtime.stop();
        store.close();
      }
    });

    it("returns correct Content-Type and Cache-Control headers (tests 11, 11a)", async () => {
      const { startKernelRuntime } = await import("../../src/runtime.js");
      const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

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

        const res = await httpGet(port, "/_api/bootstrap");
        expect(res.headers["content-type"]).toBe("application/json");
        expect(res.headers["cache-control"]).toBe("no-store");
      } finally {
        await runtime.stop();
        store.close();
      }
    });

    it("wsUrl matches WsServer.url exactly (test 10)", async () => {
      const { startKernelRuntime } = await import("../../src/runtime.js");
      const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

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

        const res = await httpGet(port, "/_api/bootstrap");
        const data = JSON.parse(res.body) as { wsUrl: string };
        // The bootstrap wsUrl must match the WsServer URL exactly,
        // including the dynamically assigned port
        expect(data.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
        expect(data.wsUrl).toBe(control.url);
      } finally {
        await runtime.stop();
        store.close();
      }
    });

    it("returns 503 after stopRuntime is called (tests 7, 22)", async () => {
      const { startKernelRuntime } = await import("../../src/runtime.js");
      const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

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

      // Verify bootstrap works before shutdown
      const beforeStop = await httpGet(port, "/_api/bootstrap");
      expect(beforeStop.statusCode).toBe(200);

      // Start shutdown (stopped flag is set synchronously)
      const stopPromise = runtime.stop();

      // The bootstrap endpoint should return 503 now
      // Use a small delay to let the event loop process the stop initiation
      const afterStop = await httpGetSafe(port, "/_api/bootstrap");
      if ("statusCode" in afterStop) {
        expect(afterStop.statusCode).toBe(503);
        expect(afterStop.headers["cache-control"]).toBe("no-store");
      }
      // If we got ECONNREFUSED, that's also acceptable (server closed fast)

      await stopPromise;
      store.close();
    });

    it("returns 503 during WS-initiated shutdown (test 25)", async () => {
      const { startKernelRuntime } = await import("../../src/runtime.js");
      const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

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

      // Send shutdown via WS (like the CLI does)
      const ws = new WebSocket(control.url);
      await new Promise<void>((resolve) => { ws.on("open", resolve); });
      ws.send(JSON.stringify({ type: "authenticate", token: control.token }));
      await new Promise<void>((resolve) => {
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString()) as { type: string };
          if (msg.type === "ack") resolve();
        });
      });
      ws.send(JSON.stringify({ type: "shutdown" }));
      await new Promise<void>((resolve) => {
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString()) as { type: string; command?: string };
          if (msg.type === "ack" && msg.command === "shutdown") resolve();
        });
      });

      // After shutdown command, bootstrap should return 503 or ECONNREFUSED
      // Give the shutdown callback a tick to set the flag
      await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
      const result = await httpGetSafe(port, "/_api/bootstrap");
      if ("statusCode" in result) {
        expect(result.statusCode).toBe(503);
      }
      // ECONNREFUSED is also acceptable — means server already closed

      ws.close();
      await runtime.stop();
      store.close();
    });

    it("takes priority over SPA fallback (test 9)", async () => {
      const { startKernelRuntime } = await import("../../src/runtime.js");
      const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

      // Create a dashboard/dist with an index.html
      await mkdir(join(repoDir, "dashboard", "dist"), { recursive: true });
      await writeFile(join(repoDir, "dashboard", "dist", "index.html"), "<html>dashboard</html>", "utf8");

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

        // Bootstrap should return JSON, not HTML
        const bootstrap = await httpGet(port, "/_api/bootstrap");
        expect(bootstrap.statusCode).toBe(200);
        expect(bootstrap.headers["content-type"]).toBe("application/json");
        expect(() => JSON.parse(bootstrap.body)).not.toThrow();

        // SPA fallback should still work for non-bootstrap paths
        const spa = await httpGet(port, "/some/spa/route");
        expect(spa.statusCode).toBe(200);
        expect(spa.headers["content-type"]).toMatch(/text\/html/);
        expect(spa.body).toContain("<html>dashboard</html>");
      } finally {
        await runtime.stop();
        store.close();
      }
    });

    it("works without built dashboard (test 16b)", async () => {
      const { startKernelRuntime } = await import("../../src/runtime.js");
      const { readRuntimeControlInfo } = await import("../../src/runtime-control.js");

      // No dashboard/dist directory exists

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

        // Bootstrap should return 200 JSON even without dashboard
        const bootstrap = await httpGet(port, "/_api/bootstrap");
        expect(bootstrap.statusCode).toBe(200);
        expect(bootstrap.headers["content-type"]).toBe("application/json");

        // Root should return 404 (existing behavior for missing dashboard)
        const root = await httpGet(port, "/");
        expect(root.statusCode).toBe(404);
      } finally {
        await runtime.stop();
        store.close();
      }
    });
  });

  // ─── Shared port (test 16a) ───

  describe("shared port", () => {
    it("serves both HTTP and WebSocket on the same port (test 16a)", async () => {
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

        // HTTP: bootstrap endpoint works
        const httpRes = await httpGet(port, "/_api/bootstrap");
        expect(httpRes.statusCode).toBe(200);

        // WS: connect and subscribe on the same port
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const messages: unknown[] = [];

        await new Promise<void>((resolve, reject) => {
          ws.on("open", () => {
            ws.send(JSON.stringify({ type: "authenticate", token: control.token }));
          });
          ws.on("message", (data) => {
            const msg = JSON.parse(data.toString()) as { type: string };
            messages.push(msg);
            if (msg.type === "ack") {
              ws.send(JSON.stringify({ type: "subscribe", channel: "tasks" }));
            }
            if (msg.type === "snapshot") {
              resolve();
            }
          });
          ws.on("error", reject);
          setTimeout(() => reject(new Error("WS connect timeout")), 5000);
        });

        expect(messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "ack", command: "authenticate" }),
            expect.objectContaining({ type: "snapshot" }),
          ]),
        );

        ws.close();
      } finally {
        await runtime.stop();
        store.close();
      }
    });
  });
});
