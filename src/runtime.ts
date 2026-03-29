import { execFile as execFileCb } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { AdapterRegistry } from "./adapters/registry.js";
import { ConflictingSignalsError, readScopedSignals } from "./evaluator/signal.js";
import { Kernel, type KernelCrashState, type StartupSignalResolution } from "./kernel.js";
import { mergeWorktreeToMain as executeMergeWorktreeToMain } from "./merge.js";
import {
  removeRuntimeControlInfo,
  writeRuntimeControlInfo,
} from "./runtime-control.js";
import type { IpcResponse } from "./server/ipc-types.js";
import { createRuntimeStateHub, type RuntimeStateHub } from "./server/runtime-state-hub.js";
import { WsServer } from "./server/ws-server.js";
import { Supervisor } from "./supervisor/supervisor.js";
import {
  releaseKernelLock as defaultReleaseKernelLock,
  runPreflight as defaultRunPreflight,
  type PreflightOptions,
  type PreflightResult,
} from "./startup.js";
import { TaskStore } from "./store/task-store.js";
import { createTickLoop as defaultCreateTickLoop, type TickLoop } from "./tick.js";
import type { KernelConfig, Task, TaskStatus } from "./types.js";
import { sleep } from "./utils/sleep.js";
import {
  createWorktree as defaultCreateWorktree,
  gcWorktrees as defaultGcWorktrees,
  verifyWorktreeMetadata,
} from "./worktree.js";

const execFile = promisify(execFileCb);

interface RuntimeStore {
  list(options?: { initializeMissingState?: boolean }): Promise<Task[]>;
  get?(taskId: string): Promise<Task | null>;
  updateStatus(taskId: string, status: TaskStatus, metadata?: Record<string, unknown>): Promise<void>;
  createTask?(task: Task): Promise<void>;
  close?(): void;
}

interface RuntimeSupervisor {
  spawnAgent(task: Task): Promise<void>;
  getRunningCount?(): number | Promise<number>;
  hasRunningProcess?(taskId: string): boolean;
  requestPause?(taskId: string): Promise<void>;
  resumeTask?(taskId: string): Promise<void>;
  killTask?(taskId: string): Promise<void>;
  subscribeTaskOutput?(taskId: string, listener: (chunk: string) => void, onEnded?: (reason: import("./server/ipc-types.js").OutputEndedReason) => void): (() => void) | undefined;
  shutdown?(): Promise<void>;
}

interface RuntimeKernel {
  reconcileStartupState(): Promise<void>;
  tick(): Promise<void>;
  handleCrash(error: unknown, activeTasks: Array<Pick<Task, "id">>): Promise<void>;
}

interface ProcessHookHandlers {
  onUncaughtException(error: Error): void | Promise<void>;
  onUnhandledRejection(reason: unknown): void | Promise<void>;
}

interface RuntimeKernelFactoryOptions {
  store: RuntimeStore;
  supervisor: RuntimeSupervisor;
  config: KernelConfig;
  writeCrashState: (state: KernelCrashState) => Promise<void>;
  inspectStartupSignal: (task: Task) => Promise<StartupSignalResolution | undefined>;
  isTaskProcessAlive: (task: Task) => Promise<boolean>;
  terminateOrphanProcess: (task: Task) => Promise<void>;
  gcWorktrees: (tasks: Task[], mergeQueuedTaskIds: string[]) => Promise<void>;
}

interface RuntimeDependencies {
  runPreflight?: (options: PreflightOptions) => Promise<PreflightResult>;
  createStore?: (options: Pick<PreflightOptions, "tasksDir" | "dbPath">) => RuntimeStore;
  createSupervisor?: (options: {
    store: RuntimeStore;
    config: KernelConfig;
    adapterRegistry: AdapterRegistry;
  }) => RuntimeSupervisor;
  createKernel?: (options: RuntimeKernelFactoryOptions) => RuntimeKernel;
  createTickLoop?: (tickFn: () => Promise<void>, options: { intervalMs: number; onError?: (err: unknown) => void }) => TickLoop;
  installProcessHooks?: (handlers: ProcessHookHandlers) => () => void;
  releaseKernelLock?: (lock: PreflightResult["lock"]) => Promise<void>;
}

export interface KernelRuntime {
  readonly kernel: RuntimeKernel;
  readonly lock: PreflightResult["lock"];
  stop(): Promise<void>;
}

export async function startKernelRuntime(
  options: PreflightOptions,
  dependencies: RuntimeDependencies = {},
): Promise<KernelRuntime> {
  if (options.dbPath !== ":memory:") {
    await mkdir(dirname(options.dbPath), { recursive: true });
  }

  const preflight = await (dependencies.runPreflight ?? defaultRunPreflight)(options);
  const runtimeDir = options.lockDir ?? join(options.repoDir, ".openharness");
  const adapterRegistry = options.adapterRegistry ?? new AdapterRegistry();
  const baseStore = dependencies.createStore?.({ tasksDir: options.tasksDir, dbPath: options.dbPath })
    ?? new TaskStore({ tasksDir: options.tasksDir, dbPath: options.dbPath });
  const runtimeStateHub = shouldStartRuntimeControl(options)
    ? createRuntimeStateHub()
    : undefined;
  const store = runtimeStateHub
    ? createObservableRuntimeStore(baseStore, runtimeStateHub)
    : baseStore;
  const supervisor = dependencies.createSupervisor?.({
    store,
    config: preflight.config,
    adapterRegistry,
  }) ?? createDefaultSupervisor(store, preflight.config, adapterRegistry, options.repoDir, runtimeStateHub);
  const inspectStartupSignal = createRuntimeSignalInspector(options.repoDir, preflight.config.worktreesDir);
  const isTaskProcessAlive = createRuntimeProcessLivenessProbe(options.repoDir, preflight.config.worktreesDir);
  const terminateOrphanProcess = createRuntimeOrphanTerminator(options.repoDir, preflight.config.worktreesDir);
  const writeCrashState = async (state: KernelCrashState) => writeCrashStateFile(runtimeDir, state);
  const kernel = dependencies.createKernel?.({
    store,
    supervisor,
    config: preflight.config,
    writeCrashState,
    inspectStartupSignal,
    isTaskProcessAlive,
    terminateOrphanProcess,
    gcWorktrees: (tasks, mergeQueuedTaskIds) => defaultGcWorktrees(options.repoDir, tasks, mergeQueuedTaskIds),
  }) ?? new Kernel({
    store,
    supervisor,
    config: preflight.config,
    writeCrashState,
    inspectStartupSignal,
    isTaskProcessAlive,
    terminateOrphanProcess,
    mergeWorktreeToMain: createRuntimeMergeWorktreeToMain(options.repoDir, preflight.config.worktreesDir),
    gcWorktrees: (tasks, mergeQueuedTaskIds) => defaultGcWorktrees(options.repoDir, tasks, mergeQueuedTaskIds),
  });

  // Shutdown flags shared between stopRuntime and bootstrap handler.
  // `shutdownRequested` is set synchronously by requestRuntimeShutdown to
  // close the timing gap where setTimeout defers the actual stop (edge case #38).
  let stopped = false;
  let shutdownRequested = false;

  // ── HTTP + WS server setup (shared port, E9 Option B) ──

  let requestRuntimeShutdown: (() => void) | undefined;
  let httpServer: import("node:http").Server | undefined;
  let wsServer: WsServer | undefined;

  if (runtimeStateHub) {
    const { createStaticServer } = await import("./server/http-server.js");

    httpServer = createStaticServer(options.repoDir, {
      getBootstrapData: () => {
        if (!wsServer) return null;
        try {
          return { wsUrl: wsServer.url, token: wsServer.token, kernelId: process.pid };
        } catch {
          return null;
        }
      },
      isStopped: () => stopped || shutdownRequested,
    });

    // Listen on the configured port first.
    await new Promise<void>((resolve, reject) => {
      httpServer!.listen(preflight.config.port, "127.0.0.1", () => { resolve(); });
      httpServer!.once("error", reject);
    });

    // Attach WsServer to the HTTP server (shared port).
    try {
      wsServer = new WsServer({
        server: httpServer,
        runtimeStateHub,
        listTasks: async () => await store.list(),
        subscribeTaskOutput: supervisor.subscribeTaskOutput?.bind(supervisor),
        onRequest: async (request) => {
          try {
            if (request.type === "pause") {
              if (!supervisor.hasRunningProcess?.(request.taskId)) {
                return { type: "error", message: `Cannot pause task ${request.taskId}: no running process` } satisfies IpcResponse;
              }
              await supervisor.requestPause?.(request.taskId);
              return { type: "ack", command: request.type, taskId: request.taskId } satisfies IpcResponse;
            }

            if (request.type === "resume") {
              const task = await store.get?.(request.taskId);
              if (!task || task.status !== "paused") {
                return { type: "error", message: `Cannot resume task ${request.taskId}: task is not paused` } satisfies IpcResponse;
              }
              await supervisor.resumeTask?.(request.taskId);
              return { type: "ack", command: request.type, taskId: request.taskId } satisfies IpcResponse;
            }

            if (request.type === "kill") {
              if (!supervisor.hasRunningProcess?.(request.taskId)) {
                return { type: "error", message: `Cannot kill task ${request.taskId}: no running process` } satisfies IpcResponse;
              }
              await supervisor.killTask?.(request.taskId);
              return { type: "ack", command: request.type, taskId: request.taskId } satisfies IpcResponse;
            }

            if (request.type === "shutdown") {
              requestRuntimeShutdown?.();
              return { type: "ack", command: request.type } satisfies IpcResponse;
            }

            if (request.type === "get-logs") {
              return {
                type: "logs",
                taskId: request.taskId,
                logs: await readTaskLogs(options.repoDir, preflight.config.runsDir, request.taskId),
              } satisfies IpcResponse;
            }

            return {
              type: "error",
              message: `Unsupported request: ${request.type}`,
            } satisfies IpcResponse;
          } catch (error) {
            return {
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            } satisfies IpcResponse;
          }
        },
      });

      await wsServer.ready;
    } catch (error) {
      // Partial startup failure (I11): WS server failed, tear down HTTP server.
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => { httpServer!.close(() => { resolve(); }); });
      throw error;
    }

    await writeRuntimeControlInfo(options.repoDir, {
      pid: process.pid,
      url: wsServer.url,
      token: wsServer.token,
    });
  }

  await kernel.reconcileStartupState();

  const loop = (dependencies.createTickLoop ?? defaultCreateTickLoop)(
    () => kernel.tick(),
    {
      intervalMs: preflight.config.tickIntervalMs,
      onError: (error) => {
        console.error("[kernel] Tick failed:", error);
      },
    },
  );

  const disposeHooks = (dependencies.installProcessHooks ?? defaultInstallProcessHooks)({
    onUncaughtException: async (error) => {
      const activeTasks = await listActiveTasksSafely(store, error);
      await kernel.handleCrash(error, activeTasks);
      process.exitCode = 1;
    },
    onUnhandledRejection: async (reason) => {
      const activeTasks = await listActiveTasksSafely(store, reason);
      await kernel.handleCrash(reason, activeTasks);
      process.exitCode = 1;
    },
  });

  loop.start();

  const stopRuntime = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    loop.stop();
    disposeHooks();

    try {
      await supervisor.shutdown?.();

      // Close WS server first so clients receive proper close frames.
      // Then close HTTP server to reject new connections (I17).
      // The `stopped` flag (already set above) ensures the bootstrap handler
      // returns 503 during this window, preventing stale-bootstrap responses (F6).
      await wsServer?.close();
      if (httpServer) {
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => {
          httpServer!.close(() => { resolve(); });
        });
      }
    } finally {
      baseStore.close?.();
      await (dependencies.releaseKernelLock ?? defaultReleaseKernelLock)(preflight.lock);
      await removeRuntimeControlInfo(options.repoDir, process.pid);
    }
  };

  requestRuntimeShutdown = () => {
    // Set flag synchronously so bootstrap handler returns 503 immediately,
    // before the deferred stopRuntime runs (edge case #38).
    shutdownRequested = true;
    setTimeout(() => {
      void stopRuntime();
    }, 0);
  };

  return {
    kernel,
    lock: preflight.lock,
    stop: stopRuntime,
  };
}

export function createRuntimeSignalInspector(
  repoDir: string,
  worktreesDir: string,
): (task: Pick<Task, "id" | "assigned_at">) => Promise<StartupSignalResolution | undefined> {
  return async (task) => {
    if (!task.assigned_at) {
      return undefined;
    }

    const signalRoots = [repoDir, join(repoDir, worktreesDir, task.id)];

    try {
      let scopedSignals: Awaited<ReturnType<typeof readScopedSignals>> = {};
      for (const signalRoot of signalRoots) {
        scopedSignals = await readScopedSignals(signalRoot, {
          taskId: task.id,
          runId: task.assigned_at,
        });

        if (scopedSignals.completionSignal || scopedSignals.escalationSignal) {
          break;
        }
      }

      if (scopedSignals.completionSignal) {
        return {
          status: "completed",
          metadata: { summary: scopedSignals.completionSignal.summary },
        };
      }

      if (scopedSignals.escalationSignal) {
        return {
          status: "escalated",
          reason: "agent_escalated",
          metadata: {
            escalationReason: scopedSignals.escalationSignal.reason,
            rule: scopedSignals.escalationSignal.rule,
          },
        };
      }

      return undefined;
    } catch (error) {
      if (error instanceof ConflictingSignalsError) {
        return {
          status: "escalated",
          reason: "conflicting_signals",
        };
      }

      throw error;
    }
  };
}

function createRuntimeProcessLivenessProbe(
  repoDir: string,
  worktreesDir: string,
): (task: Task) => Promise<boolean> {
  return async (task) => {
    const recordedProcess = await readRecordedProcess(join(repoDir, worktreesDir, task.id));
    if (!recordedProcess) {
      return false;
    }

    return recordedProcess.kind === "pgid"
      ? isProcessGroupAlive(recordedProcess.value)
      : isProcessAlive(recordedProcess.value);
  };
}

function createRuntimeOrphanTerminator(
  repoDir: string,
  worktreesDir: string,
): (task: Task) => Promise<void> {
  return async (task) => {
    const recordedProcess = await readRecordedProcess(join(repoDir, worktreesDir, task.id));
    if (!recordedProcess) {
      return;
    }

    if (recordedProcess.kind === "pgid") {
      await terminateProcessGroup(recordedProcess.value);
      return;
    }

    await terminateProcess(recordedProcess.value);
  };
}

export async function writeCrashStateFile(runtimeDir: string, state: KernelCrashState): Promise<void> {
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, "crash-state.json"), JSON.stringify(state, null, 2), "utf8");
}

function createDefaultSupervisor(
  store: RuntimeStore,
  config: KernelConfig,
  adapterRegistry: AdapterRegistry,
  repoDir: string,
  runtimeStateHub?: RuntimeStateHub,
): RuntimeSupervisor {
  return new Supervisor({
    store,
    resolveGeneratorAdapter: (task) => adapterRegistry.resolveTaskAdapters(task, config).generator,
    prepareWorkingDirectory: async (task) => {
      const worktreePath = await defaultCreateWorktree(repoDir, task.id);
      await verifyWorktreeMetadata(worktreePath, { taskId: task.id, repoRoot: repoDir });
      return worktreePath;
    },
    resolveOutputFilePath: (task, runId) => join(repoDir, config.runsDir, task.id, `${runId}.log`),
    verifyMainWorktreeIntegrity: createRuntimeMainWorktreeIntegrityVerifier(repoDir, config.runsDir),
    onTaskOutput: runtimeStateHub
      ? (taskId) => {
        runtimeStateHub.noteTaskOutput(taskId);
      }
      : undefined,
  });
}

function createRuntimeMainWorktreeIntegrityVerifier(
  repoDir: string,
  runsDir: string,
): (task: Task) => Promise<string | undefined> {
  return async (task) => {
    const { stdout } = await execFile(
      "git",
      [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ".",
        ":(exclude).openharness",
        ":(exclude).worktrees",
        `:(exclude)${runsDir}`,
      ],
      {
        cwd: repoDir,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      },
    );

    const changed = stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);

    if (changed.length === 0) {
      return undefined;
    }

    return `Unexpected main worktree changes detected during ${task.id}: ${changed.join(", ")}`;
  };
}

function defaultInstallProcessHooks(handlers: ProcessHookHandlers): () => void {
  const onUncaughtException = (error: Error) => {
    void Promise.resolve(handlers.onUncaughtException(error)).catch((hookError) => {
      console.error("[kernel] uncaughtException hook failed:", hookError);
    });
  };
  const onUnhandledRejection = (reason: unknown) => {
    void Promise.resolve(handlers.onUnhandledRejection(reason)).catch((hookError) => {
      console.error("[kernel] unhandledRejection hook failed:", hookError);
    });
  };

  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);

  return () => {
    process.off("uncaughtException", onUncaughtException);
    process.off("unhandledRejection", onUnhandledRejection);
  };
}

async function listActiveTasks(store: RuntimeStore): Promise<Array<Pick<Task, "id">>> {
  const tasks = await store.list();
  return tasks
    .filter((task) => task.status === "generator_running" || task.status === "evaluator_running")
    .map((task) => ({ id: task.id }));
}

async function listActiveTasksSafely(
  store: RuntimeStore,
  originalError: unknown,
): Promise<Array<Pick<Task, "id">>> {
  try {
    return await listActiveTasks(store);
  } catch (listError) {
    console.error("[kernel] Failed to list active tasks during crash handling:", {
      originalError: originalError instanceof Error ? originalError.message : String(originalError),
      listError: listError instanceof Error ? listError.message : String(listError),
    });
    return [];
  }
}

async function readRecordedProcess(worktreeDir: string): Promise<{ kind: "pgid" | "pid"; value: number } | undefined> {
  const signalDir = join(worktreeDir, ".openharness");

  for (const kind of ["pgid", "pid"] as const) {
    try {
      const raw = await readFile(join(signalDir, kind), "utf8");
      const value = Number.parseInt(raw.trim(), 10);
      if (!Number.isNaN(value)) {
        return { kind, value };
      }
    } catch {
      // Keep checking fallbacks.
    }
  }

  return undefined;
}

function createRuntimeMergeWorktreeToMain(
  repoDir: string,
  worktreesDir: string,
): (task: Task) => Promise<{ nextStatus: "merged" }> {
  return async (task) => {
    const worktreeDir = join(repoDir, worktreesDir, task.id);
    const patch = await buildMergePatch(worktreeDir);

    return await executeMergeWorktreeToMain({
      taskId: task.id,
      performMerge: async () => {
        if (!patch) {
          return;
        }

        const patchPath = join(repoDir, ".openharness", `${task.id}.merge.patch`);
        await mkdir(dirname(patchPath), { recursive: true });
        await writeFile(patchPath, patch, "utf8");

        try {
          await execFile(
            "git",
            ["apply", "--index", "--binary", patchPath],
            {
              cwd: repoDir,
              maxBuffer: 20 * 1024 * 1024,
            },
          );

          const hasStagedChanges = !(await isGitDiffQuiet(repoDir, ["diff", "--cached", "--quiet"]));
          if (!hasStagedChanges) {
            return;
          }

          await execFile(
            "git",
            ["commit", "--no-verify", "-m", `openharness: merge ${task.id}`],
            { cwd: repoDir, maxBuffer: 20 * 1024 * 1024 },
          );
        } finally {
          await rm(patchPath, { force: true });
        }
      },
    });
  };
}

async function buildMergePatch(worktreeDir: string): Promise<string> {
  await execFile(
    "git",
    ["add", "-A", "--", "."],
    { cwd: worktreeDir, maxBuffer: 20 * 1024 * 1024 },
  );

  // Unstage runtime-owned paths after the broad add so ignored internals
  // never block merge patch construction.
  await unstageIfPresent(worktreeDir, ".openharness");
  await unstageIfPresent(worktreeDir, "node_modules");

  const { stdout } = await execFile(
    "git",
    ["diff", "--cached", "--binary", "HEAD", "--", ".", ":(exclude).openharness", ":(exclude)node_modules"],
    { cwd: worktreeDir, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );

  return stdout;
}

async function unstageIfPresent(worktreeDir: string, path: string): Promise<void> {
  try {
    await execFile(
      "git",
      ["reset", "--quiet", "HEAD", "--", path],
      { cwd: worktreeDir, maxBuffer: 20 * 1024 * 1024 },
    );
  } catch (error) {
    // `git reset -- <path>` exits non-zero when the path was never staged.
    if (typeof error === "object" && error !== null && "code" in error) {
      return;
    }
    throw error;
  }
}

async function isGitDiffQuiet(repoDir: string, args: string[]): Promise<boolean> {
  try {
    await execFile("git", args, { cwd: repoDir, maxBuffer: 20 * 1024 * 1024 });
    return true;
  } catch (error) {
    // `git diff --quiet` exits 1 when differences are present.
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 1) {
      return false;
    }
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcess(pid: number, gracePeriodMs = 1_000): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  await sleep(gracePeriodMs);

  if (!isProcessAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process exited during grace period.
  }
}

async function terminateProcessGroup(pgid: number, gracePeriodMs = 1_000): Promise<void> {
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    return;
  }

  await sleep(gracePeriodMs);

  if (!isProcessGroupAlive(pgid)) {
    return;
  }

  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // Process group exited during grace period.
  }
}

function shouldStartRuntimeControl(options: PreflightOptions): boolean {
  return options.dbPath !== ":memory:";
}

function createObservableRuntimeStore(baseStore: RuntimeStore, runtimeStateHub: RuntimeStateHub): RuntimeStore {
  return {
    list: async (options) => await baseStore.list(options),
    get: baseStore.get ? async (taskId) => await baseStore.get?.(taskId) ?? null : undefined,
    async updateStatus(taskId, status, metadata) {
      await baseStore.updateStatus(taskId, status, metadata);
      const updatedTask = await readTaskFromStore(baseStore, taskId);
      if (updatedTask) {
        runtimeStateHub.queueTaskUpdate(updatedTask, { updatedAt: new Date().toISOString() });
      }
    },
    createTask: baseStore.createTask
      ? async (task) => {
        await baseStore.createTask?.(task);
        const createdTask = await readTaskFromStore(baseStore, task.id);
        if (createdTask) {
          runtimeStateHub.queueTaskUpdate(createdTask, {
            updatedAt: createdTask.enqueued_at ?? new Date().toISOString(),
          });
        }
      }
      : undefined,
    close: () => {
      baseStore.close?.();
    },
  };
}

async function readTaskFromStore(store: RuntimeStore, taskId: string): Promise<Task | null> {
  if (store.get) {
    return await store.get(taskId);
  }

  const tasks = await store.list();
  return tasks.find((task) => task.id === taskId) ?? null;
}

export type { StartupSignalResolution, KernelCrashState } from "./kernel.js";

interface TaskLogs {
  runLogs: Array<{
    runId: string;
    path: string;
  }>;
  output: string;
}

async function readTaskLogs(repoDir: string, runsDir: string, taskId: string): Promise<TaskLogs> {
  const taskRunsDir = join(repoDir, runsDir, taskId);

  let entries: string[];
  try {
    entries = await readdir(taskRunsDir);
  } catch {
    return { runLogs: [], output: "" };
  }

  const runLogs = entries
    .filter((entry) => entry.endsWith(".log"))
    .sort()
    .map((entry) => ({
      runId: entry.slice(0, -".log".length),
      path: join(taskRunsDir, entry),
    }));

  const latestLog = runLogs[runLogs.length - 1];
  if (!latestLog) {
    return { runLogs, output: "" };
  }

  try {
    const output = await readFile(latestLog.path, "utf8");
    return { runLogs, output };
  } catch {
    return { runLogs, output: "" };
  }
}
