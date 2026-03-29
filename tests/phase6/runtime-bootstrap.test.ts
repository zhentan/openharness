import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TickLoop } from "../../src/tick.js";
import type { KernelCrashState, StartupSignalResolution } from "../../src/kernel.js";

describe("Phase 6: runtime bootstrap", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "oh-runtime-"));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("boots through preflight, reconciles startup state, and starts the Phase 6 kernel loop", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");

    const lock = { lockPath: join(repoDir, ".openharness", "kernel.pid"), pid: 123 };
    const runPreflight = vi.fn(async () => ({
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
        port: 3000,
        backoffBaseDelayMs: 1000,
        backoffMaxDelayMs: 10_000,
      },
      tasks: [],
      lock,
    }));
    const reconcileStartupState = vi.fn(async () => undefined);
    const tick = vi.fn(async () => undefined);
    const handleCrash = vi.fn(async () => undefined);
    const createKernel = vi.fn(() => ({ reconcileStartupState, tick, handleCrash }));
    const loopStart = vi.fn(() => undefined);
    const loopStop = vi.fn(() => undefined);
    const createTickLoop = vi.fn((): TickLoop => ({ start: loopStart, stop: loopStop }));
    const disposeHooks = vi.fn(() => undefined);
    const installProcessHooks = vi.fn(() => disposeHooks);
    const releaseKernelLock = vi.fn(async () => undefined);

    const runtime = await startKernelRuntime(
      {
        repoDir,
        tasksDir: join(repoDir, "tasks"),
        dbPath: ":memory:",
      },
      {
        runPreflight,
        createKernel,
        createTickLoop,
        installProcessHooks,
        releaseKernelLock,
      },
    );

    expect(runPreflight).toHaveBeenCalledOnce();
    expect(reconcileStartupState).toHaveBeenCalledOnce();
    expect(createTickLoop).toHaveBeenCalledWith(expect.any(Function), {
      intervalMs: 25,
      onError: expect.any(Function),
    });
    expect(loopStart).toHaveBeenCalledOnce();

    await runtime.stop();

    expect(loopStop).toHaveBeenCalledOnce();
    expect(disposeHooks).toHaveBeenCalledOnce();
    expect(releaseKernelLock).toHaveBeenCalledWith(lock);
  });

  it("shuts down active supervisor processes before releasing runtime ownership", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");

    const lock = { lockPath: join(repoDir, ".openharness", "kernel.pid"), pid: 123 };
    const shutdown = vi.fn(async () => undefined);
    const releaseKernelLock = vi.fn(async () => undefined);

    const runtime = await startKernelRuntime(
      {
        repoDir,
        tasksDir: join(repoDir, "tasks"),
        dbPath: ":memory:",
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
            port: 3000,
            backoffBaseDelayMs: 1000,
            backoffMaxDelayMs: 10_000,
          },
          tasks: [],
          lock,
        }),
        createSupervisor: () => ({
          spawnAgent: async () => undefined,
          shutdown,
        }),
        createKernel: () => ({
          reconcileStartupState: async () => undefined,
          tick: async () => undefined,
          handleCrash: async () => undefined,
        }),
        createTickLoop: (): TickLoop => ({ start: () => undefined, stop: () => undefined }),
        releaseKernelLock,
      },
    );

    await runtime.stop();

    expect(shutdown).toHaveBeenCalledOnce();
    expect(releaseKernelLock).toHaveBeenCalledWith(lock);
  });

  it("writes crash state when an installed uncaught exception hook fires", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");

    const lock = { lockPath: join(repoDir, ".openharness", "kernel.pid"), pid: 123 };
    let uncaughtExceptionHandler: ((error: Error) => Promise<void> | void) | undefined;

    const runtime = await startKernelRuntime(
      {
        repoDir,
        tasksDir: join(repoDir, "tasks"),
        dbPath: ":memory:",
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
            port: 3000,
            backoffBaseDelayMs: 1000,
            backoffMaxDelayMs: 10_000,
          },
          tasks: [],
          lock,
        }),
        createStore: () => ({
          list: async () => [{
            id: "t_running",
            title: "Running task",
            status: "generator_running",
            priority: "high",
            depends_on: [],
            agent_prompt: "test",
            exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
            escalation_rules: [],
          }],
          updateStatus: async () => undefined,
        }),
        createKernel: ({ writeCrashState }) => ({
          reconcileStartupState: async () => undefined,
          tick: async () => undefined,
          handleCrash: async (error: unknown, activeTasks: Array<{ id: string }>) => {
            await writeCrashState({
              timestamp: "2026-03-28T00:00:00.000Z",
              error: { message: error instanceof Error ? error.message : String(error) },
              activeTaskIds: activeTasks.map((task) => task.id),
            });
          },
        }),
        createTickLoop: (): TickLoop => ({ start: () => undefined, stop: () => undefined }),
        installProcessHooks: (handlers) => {
          uncaughtExceptionHandler = handlers.onUncaughtException;
          return () => undefined;
        },
      },
    );

    await uncaughtExceptionHandler?.(new Error("kernel exploded"));

    const crashState = JSON.parse(
      await readFile(join(repoDir, ".openharness", "crash-state.json"), "utf8"),
    ) as KernelCrashState;
    expect(crashState.error.message).toBe("kernel exploded");
    expect(crashState.activeTaskIds).toEqual(["t_running"]);

    await runtime.stop();
  });

  it("still writes crash state when active task listing fails during crash handling", async () => {
    const { startKernelRuntime } = await import("../../src/runtime.js");

    const lock = { lockPath: join(repoDir, ".openharness", "kernel.pid"), pid: 123 };
    let uncaughtExceptionHandler: ((error: Error) => Promise<void> | void) | undefined;

    const runtime = await startKernelRuntime(
      {
        repoDir,
        tasksDir: join(repoDir, "tasks"),
        dbPath: ":memory:",
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
            port: 3000,
            backoffBaseDelayMs: 1000,
            backoffMaxDelayMs: 10_000,
          },
          tasks: [],
          lock,
        }),
        createStore: () => ({
          list: async () => {
            throw new Error("store exploded");
          },
          updateStatus: async () => undefined,
        }),
        createKernel: ({ writeCrashState }) => ({
          reconcileStartupState: async () => undefined,
          tick: async () => undefined,
          handleCrash: async (error: unknown, activeTasks: Array<{ id: string }>) => {
            await writeCrashState({
              timestamp: "2026-03-28T00:00:00.000Z",
              error: { message: error instanceof Error ? error.message : String(error) },
              activeTaskIds: activeTasks.map((task) => task.id),
            });
          },
        }),
        createTickLoop: (): TickLoop => ({ start: () => undefined, stop: () => undefined }),
        installProcessHooks: (handlers) => {
          uncaughtExceptionHandler = handlers.onUncaughtException;
          return () => undefined;
        },
      },
    );

    await uncaughtExceptionHandler?.(new Error("kernel exploded"));

    const crashState = JSON.parse(
      await readFile(join(repoDir, ".openharness", "crash-state.json"), "utf8"),
    ) as KernelCrashState;
    expect(crashState.error.message).toBe("kernel exploded");
    expect(crashState.activeTaskIds).toEqual([]);

    await runtime.stop();
  });

  it("reads scoped startup signals from the task worktree using assigned_at as the run id", async () => {
    const { createRuntimeSignalInspector } = await import("../../src/runtime.js");

    const assignedAt = "2026-03-28T00:00:00.000Z";
    const worktreeDir = join(repoDir, ".worktrees", "t_signal");
    await mkdir(join(worktreeDir, ".openharness"), { recursive: true });
    await writeFile(
      join(worktreeDir, ".openharness", "completion.json"),
      JSON.stringify({
        status: "completed",
        summary: "done",
        task_id: "t_signal",
        run_id: assignedAt,
      }),
      "utf8",
    );

    const inspectSignal = createRuntimeSignalInspector(repoDir, ".worktrees");
    const result = await inspectSignal({
      id: "t_signal",
      assigned_at: assignedAt,
    });

    expect(result).toEqual<StartupSignalResolution>({
      status: "completed",
      metadata: { summary: "done" },
    });
  });

  it("reads scoped startup signals from the repo signal directory when agent output was written there", async () => {
    const { createRuntimeSignalInspector } = await import("../../src/runtime.js");

    const assignedAt = "2026-03-28T00:00:00.000Z";
    await mkdir(join(repoDir, ".openharness"), { recursive: true });
    await writeFile(
      join(repoDir, ".openharness", "completion.json"),
      JSON.stringify({
        status: "completed",
        summary: "done from repo root",
        task_id: "t_signal",
        run_id: assignedAt,
      }),
      "utf8",
    );

    const inspectSignal = createRuntimeSignalInspector(repoDir, ".worktrees");
    const result = await inspectSignal({
      id: "t_signal",
      assigned_at: assignedAt,
    });

    expect(result).toEqual<StartupSignalResolution>({
      status: "completed",
      metadata: { summary: "done from repo root" },
    });
  });
});