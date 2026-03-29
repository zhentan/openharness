import { join } from "node:path";
import { loadConfig } from "./config.js";
import {
  RuntimeUnavailableError,
  sendRuntimeCommand as defaultSendRuntimeCommand,
  waitForRuntimeStop as defaultWaitForRuntimeStop,
  watchTaskStream as defaultWatchTaskStream,
} from "./runtime-control.js";
import type { SnapshotResponse, TaskSummariesUpdatedResponse } from "./server/ipc-types.js";
import { startKernelRuntime as defaultStartKernelRuntime } from "./runtime.js";
import { TaskStore } from "./store/task-store.js";
import type { Task, TaskStatus } from "./types.js";

const STATUS_ORDER: TaskStatus[] = [
  "pending",
  "reserved",
  "pre_eval",
  "generator_running",
  "evaluator_running",
  "revisions_requested",
  "completed",
  "merge_pending",
  "merged",
  "paused",
  "retry_pending",
  "escalated",
];

const ACTIVE_TASK_STATUSES = new Set<TaskStatus>([
  "reserved",
  "pre_eval",
  "generator_running",
  "evaluator_running",
]);

const USAGE = "Usage: openharness [start|restart|status|watch|pause|resume|help|stop]";

interface CliDependencies {
  cwd?: () => string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  exitProcess?: (code: number) => void;
  startKernelRuntime?: typeof defaultStartKernelRuntime;
  sendRuntimeCommand?: typeof defaultSendRuntimeCommand;
  waitForRuntimeStop?: typeof defaultWaitForRuntimeStop;
  watchTaskStream?: typeof defaultWatchTaskStream;
  installSignalHandler?: (signal: NodeJS.Signals, listener: () => void) => void;
}

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const cwd = dependencies.cwd ?? (() => process.cwd());
  const stdout = dependencies.stdout ?? ((text: string) => console.log(text));
  const stderr = dependencies.stderr ?? ((text: string) => console.error(text));
  const command = args[0] ?? "start";

  switch (command) {
    case "help":
      renderUsage(stdout);
      return 0;
    case "start":
      return runStartCommand(cwd(), dependencies);
    case "restart":
      return runRestartCommand(cwd(), stdout, stderr, dependencies);
    case "status":
      return runStatusCommand(cwd(), stdout);
    case "watch":
      return runWatchCommand(cwd(), stdout, stderr, dependencies);
    case "pause":
      return runTaskControlCommand("pause", args[1], cwd(), stdout, stderr, dependencies);
    case "resume":
      return runTaskControlCommand("resume", args[1], cwd(), stdout, stderr, dependencies);
    case "stop":
      return runStopCommand(cwd(), stdout, stderr, dependencies);
    default:
      stderr(`Unknown command: ${command}`);
      stderr(USAGE);
      return 1;
  }
}

async function runStartCommand(repoDir: string, dependencies: CliDependencies): Promise<number> {
  const config = loadConfig();
  const exitProcess = dependencies.exitProcess ?? process.exit;
  const runtime = await (dependencies.startKernelRuntime ?? defaultStartKernelRuntime)({
    repoDir,
    tasksDir: join(repoDir, config.tasksDir),
    dbPath: join(repoDir, ".openharness", "kernel.db"),
  });

  let shuttingDown = false;
  const installSignalHandler = dependencies.installSignalHandler ?? ((signal, listener) => {
    process.on(signal, listener);
  });

  return new Promise<number>((resolve) => {
    const shutdown = async (signal: string) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;

      try {
        await runtime.stop();
        exitProcess(0);
        resolve(0);
      } catch (error) {
        console.error(`[kernel] ${signal} shutdown failed:`, error);
        exitProcess(1);
        resolve(1);
      }
    };

    installSignalHandler("SIGINT", () => {
      void shutdown("SIGINT");
    });
    installSignalHandler("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  });
}

async function runRestartCommand(
  repoDir: string,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
  dependencies: CliDependencies,
): Promise<number> {
  const sendRuntimeCommand = dependencies.sendRuntimeCommand ?? defaultSendRuntimeCommand;
  const waitForRuntimeStop = dependencies.waitForRuntimeStop ?? defaultWaitForRuntimeStop;

  try {
    await sendRuntimeCommand(repoDir, { type: "shutdown" });
    await waitForRuntimeStop(repoDir, { timeoutMs: 5_000 });
    stdout("Kernel stopped.");
  } catch (error) {
    if (!(error instanceof RuntimeUnavailableError)) {
      stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  return await runStartCommand(repoDir, dependencies);
}

async function runStatusCommand(repoDir: string, stdout: (text: string) => void): Promise<number> {
  const config = loadConfig();
  const store = new TaskStore({
    tasksDir: join(repoDir, config.tasksDir),
    dbPath: join(repoDir, ".openharness", "kernel.db"),
  });

  try {
    const tasks = await store.list({ initializeMissingState: false });
    if (tasks.length === 0) {
      stdout("No tasks found.");
      return 0;
    }

    renderTaskTable(stdout, tasks);

    return 0;
  } finally {
    store.close();
  }
}

async function runWatchCommand(
  repoDir: string,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
  dependencies: CliDependencies,
): Promise<number> {
  const watchTaskStream = dependencies.watchTaskStream ?? defaultWatchTaskStream;
  const exitProcess = dependencies.exitProcess ?? process.exit;
  const installSignalHandler = dependencies.installSignalHandler ?? ((signal, listener) => {
    process.on(signal, listener);
  });

  try {
    stdout("Watching runtime task stream...");
    const stream = watchTaskStream(repoDir);
    let interrupted = false;
    const stopWatching = new Promise<void>((resolve) => {
      const onInterrupt = () => {
        interrupted = true;
        resolve();
      };
      installSignalHandler("SIGINT", onInterrupt);
      installSignalHandler("SIGTERM", onInterrupt);
    });

    while (true) {
      const nextMessage = await Promise.race([
        stream.next(),
        stopWatching.then(() => ({ done: true, value: undefined })),
      ]);

      if (nextMessage.done || nextMessage.value === undefined) {
        if (interrupted) {
          await stream.return?.(undefined);
          exitProcess(0);
        }
        break;
      }

      const message = nextMessage.value;
      if (message.type === "snapshot") {
        renderSnapshot(stdout, message);
        continue;
      }
      renderTaskUpdates(stdout, message);
    }
    return 0;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runTaskControlCommand(
  command: "pause" | "resume",
  taskId: string | undefined,
  repoDir: string,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
  dependencies: CliDependencies,
): Promise<number> {
  if (!taskId) {
    stderr(`Usage: openharness ${command} <task-id>`);
    return 1;
  }

  try {
    const sendRuntimeCommand = dependencies.sendRuntimeCommand ?? defaultSendRuntimeCommand;
    await sendRuntimeCommand(repoDir, { type: command, taskId });
    stdout(`${capitalize(command)} requested for ${taskId}.`);
    return 0;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runStopCommand(
  repoDir: string,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
  dependencies: CliDependencies,
): Promise<number> {
  try {
    const sendRuntimeCommand = dependencies.sendRuntimeCommand ?? defaultSendRuntimeCommand;
    const waitForRuntimeStop = dependencies.waitForRuntimeStop ?? defaultWaitForRuntimeStop;
    await sendRuntimeCommand(repoDir, { type: "shutdown" });
    await waitForRuntimeStop(repoDir, { timeoutMs: 5_000 });
    stdout("Kernel stopped.");
    return 0;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function countTasksByStatus(tasks: Task[]): Map<TaskStatus, number> {
  const counts = new Map<TaskStatus, number>();
  for (const task of tasks) {
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  }
  return counts;
}

function renderUsage(stdout: (text: string) => void): void {
  stdout(USAGE);
  stdout("Commands:");
  stdout("  start                 Start the kernel in the foreground.");
  stdout("  restart               Stop any running kernel, then start a fresh one.");
  stdout("  status                Show current task counts and task states.");
  stdout("  watch                 Stream task summary updates from the running kernel.");
  stdout("  pause <task-id>       Drain and pause a running task.");
  stdout("  resume <task-id>      Return a paused task to pending.");
  stdout("  stop                  Request kernel shutdown.");
  stdout("  help                  Show this usage text.");
}

function renderTaskTable(stdout: (text: string) => void, tasks: Task[]): void {
  const counts = countTasksByStatus(tasks);
  stdout("Task counts:");
  for (const status of STATUS_ORDER) {
    const count = counts.get(status);
    if (count) {
      stdout(`${status}: ${count}`);
    }
  }

  const activeTasks = tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status));
  if (activeTasks.length > 0) {
    stdout("Active tasks:");
    renderTaskLines(stdout, activeTasks, (task) => `${task.id}  ${task.status}  ${task.title}`);
  }

  stdout("Tasks:");
  renderTaskLines(stdout, tasks, (task) => `${task.id}  ${task.status.padEnd(getStatusWidth(tasks))}  ${task.title}`);
}

function renderSnapshot(stdout: (text: string) => void, snapshot: SnapshotResponse): void {
  stdout("Task counts:");
  for (const status of STATUS_ORDER) {
    const count = snapshot.counts[status];
    if (count) {
      stdout(`${status}: ${count}`);
    }
  }

  const activeTasks = snapshot.tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status));
  if (activeTasks.length > 0) {
    stdout("Active tasks:");
    renderTaskLines(stdout, activeTasks, (task) => `${task.taskId}  ${formatStatusWithHealth(task.status, task.runHealth)}  ${task.title}`);
  }

  stdout("Tasks:");
  renderTaskLines(stdout, snapshot.tasks, (task) => `${task.taskId}  ${task.status.padEnd(getStatusWidth(snapshot.tasks))}  ${task.title}`);
}

function renderTaskUpdates(stdout: (text: string) => void, update: TaskSummariesUpdatedResponse): void {
  for (const summary of update.summaries) {
    stdout(`${summary.updatedAt}  ${summary.taskId}  ${formatStatusWithHealth(summary.status, summary.runHealth)}  ${summary.title}`);
  }
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function getStatusWidth(tasks: Array<{ status: string }>): number {
  return Math.max(...tasks.map((task) => task.status.length));
}

function formatStatusWithHealth(status: string, runHealth?: "active" | "quiet"): string {
  if (runHealth === "quiet") {
    return `${status} [quiet]`;
  }
  return status;
}

function renderTaskLines<T>(stdout: (text: string) => void, tasks: T[], render: (task: T) => string): void {
  for (const task of tasks) {
    stdout(render(task));
  }
}
