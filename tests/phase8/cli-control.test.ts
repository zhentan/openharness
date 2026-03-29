import { describe, expect, it, vi } from "vitest";
import type { IpcRequest, IpcResponse } from "../../src/server/ipc-types.js";
import type { KernelRuntime } from "../../src/runtime.js";

describe("Phase 8: CLI control commands", () => {
  it("prints usage for the help command", async () => {
    const { runCli } = await import("../../src/cli.js");

    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(["help"], {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Usage: openharness [start|restart|status|watch|pause|resume|help|stop]");
  });

  it("sends pause, resume, and stop commands over runtime control", async () => {
    const { runCli } = await import("../../src/cli.js");

    const sendRuntimeCommand = vi.fn(async (_repoDir: string, request: IpcRequest): Promise<IpcResponse> => ({
      type: "ack",
      command: request.type,
      taskId: "taskId" in request ? request.taskId : undefined,
    }));
    const waitForRuntimeStop = vi.fn(async () => undefined);
    const stdout: string[] = [];

    await expect(runCli(["pause", "task_1"], {
      cwd: () => "/tmp/repo",
      stdout: (text) => stdout.push(text),
      sendRuntimeCommand,
      waitForRuntimeStop,
    })).resolves.toBe(0);

    await expect(runCli(["resume", "task_1"], {
      cwd: () => "/tmp/repo",
      stdout: (text) => stdout.push(text),
      sendRuntimeCommand,
      waitForRuntimeStop,
    })).resolves.toBe(0);

    await expect(runCli(["stop"], {
      cwd: () => "/tmp/repo",
      stdout: (text) => stdout.push(text),
      sendRuntimeCommand,
      waitForRuntimeStop,
    })).resolves.toBe(0);

    expect(sendRuntimeCommand).toHaveBeenNthCalledWith(1, "/tmp/repo", { type: "pause", taskId: "task_1" });
    expect(sendRuntimeCommand).toHaveBeenNthCalledWith(2, "/tmp/repo", { type: "resume", taskId: "task_1" });
    expect(sendRuntimeCommand).toHaveBeenNthCalledWith(3, "/tmp/repo", { type: "shutdown" });
    expect(waitForRuntimeStop).toHaveBeenCalledTimes(1);
    expect(stdout.join("\n")).toContain("Pause requested for task_1.");
    expect(stdout.join("\n")).toContain("Resume requested for task_1.");
    expect(stdout.join("\n")).toContain("Kernel stopped.");
  });

  it("restarts by stopping any running kernel and starting a new one", async () => {
    const { runCli } = await import("../../src/cli.js");

    const exitProcess = vi.fn();
    const installSignalHandler = vi.fn((signal: NodeJS.Signals, listener: () => void) => {
      if (signal === "SIGTERM") {
        queueMicrotask(listener);
      }
    });
    const sendRuntimeCommand = vi.fn(async (): Promise<IpcResponse> => ({ type: "ack", command: "shutdown" }));
    const waitForRuntimeStop = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const startKernelRuntime = vi.fn(async (): Promise<KernelRuntime> => ({
      kernel: {
        reconcileStartupState: async () => undefined,
        tick: async () => undefined,
        handleCrash: async () => undefined,
      },
      lock: { lockPath: "/tmp/repo/.openharness/kernel.pid", pid: 123 },
      stop,
    }));

    const exitCode = await runCli(["restart"], {
      cwd: () => "/tmp/repo",
      sendRuntimeCommand,
      waitForRuntimeStop,
      startKernelRuntime,
      installSignalHandler,
      exitProcess,
    });

    expect(exitCode).toBe(0);
    expect(sendRuntimeCommand).toHaveBeenCalledWith("/tmp/repo", { type: "shutdown" });
    expect(waitForRuntimeStop).toHaveBeenCalledWith("/tmp/repo", { timeoutMs: 5_000 });
    expect(startKernelRuntime).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it("forces process exit when start mode is interrupted", async () => {
    const { runCli } = await import("../../src/cli.js");

    const stop = vi.fn(async () => undefined);
    const exitProcess = vi.fn();
    const installSignalHandler = vi.fn((signal: NodeJS.Signals, listener: () => void) => {
      if (signal === "SIGINT") {
        queueMicrotask(listener);
      }
    });

    const exitCode = await runCli(["start"], {
      cwd: () => "/tmp/repo",
      startKernelRuntime: vi.fn(async () => ({
        kernel: {
          reconcileStartupState: async () => undefined,
          tick: async () => undefined,
          handleCrash: async () => undefined,
        },
        lock: { lockPath: "/tmp/repo/.openharness/kernel.pid", pid: 123 },
        stop,
      })),
      installSignalHandler,
      exitProcess,
    });

    expect(exitCode).toBe(0);
    expect(stop).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it("streams task snapshots and deltas in watch mode", async () => {
    const { runCli } = await import("../../src/cli.js");

    const stdout: string[] = [];

    const exitCode = await runCli(["watch"], {
      stdout: (text) => stdout.push(text),
      watchTaskStream: async function* () {
        yield {
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
              updatedAt: "2026-03-28T04:00:00.000Z",
            },
          ],
        };
        yield {
          type: "task-summaries-updated",
          sequence: 1,
          summaries: [
            {
              taskId: "task_1",
              title: "First task",
              status: "generator_running",
              updatedAt: "2026-03-28T04:01:00.000Z",
              runHealth: "quiet",
            },
          ],
        };
      },
    });

    expect(exitCode).toBe(0);
    expect(stdout.join("\n")).toContain("Watching runtime task stream...");
    expect(stdout.join("\n")).toContain("Task counts:");
    expect(stdout.join("\n")).toContain("task_1  pending  First task");
    expect(stdout.join("\n")).toContain("2026-03-28T04:01:00.000Z  task_1  generator_running [quiet]  First task");
  });

  it("exits watch mode cleanly when interrupted", async () => {
    const { runCli } = await import("../../src/cli.js");

    let release: (() => void) | undefined;
    const exitProcess = vi.fn();
    const installSignalHandler = vi.fn((signal: NodeJS.Signals, listener: () => void) => {
      if (signal === "SIGINT") {
        queueMicrotask(() => {
          listener();
          setTimeout(() => release?.(), 0);
        });
      }
    });

    const exitCode = await runCli(["watch"], {
      installSignalHandler,
      exitProcess,
      watchTaskStream: async function* () {
        yield {
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
        };

        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(installSignalHandler).toHaveBeenCalled();
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it("waits for watch stream cleanup before exiting on interrupt", async () => {
    const { runCli } = await import("../../src/cli.js");

    let finishCleanup: (() => void) | undefined;
    const exitProcess = vi.fn();
    const installSignalHandler = vi.fn((signal: NodeJS.Signals, listener: () => void) => {
      if (signal === "SIGINT") {
        queueMicrotask(listener);
      }
    });

    let cleanupStarted = false;
    let cleanupFinished = false;

    const watchTaskStream = (): AsyncGenerator<import("../../src/server/ipc-types.js").SnapshotResponse | import("../../src/server/ipc-types.js").TaskSummariesUpdatedResponse> => ({
      async next() {
        await new Promise<void>(() => undefined);
        return { done: true, value: undefined };
      },
      async return() {
        cleanupStarted = true;
        await new Promise<void>((resolve) => {
          finishCleanup = () => {
            cleanupFinished = true;
            resolve();
          };
        });
        return { done: true, value: undefined };
      },
      async throw(error?: unknown) {
        throw error;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      [Symbol.asyncDispose]: async () => undefined,
    });

    const exitPromise = runCli(["watch"], {
      installSignalHandler,
      exitProcess,
      watchTaskStream,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cleanupStarted).toBe(true);

    let resolved = false;
    void exitPromise.then(() => {
      resolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(false);

    finishCleanup?.();

    await expect(exitPromise).resolves.toBe(0);
    expect(cleanupFinished).toBe(true);
    expect(exitProcess).toHaveBeenCalledWith(0);
  });
});
