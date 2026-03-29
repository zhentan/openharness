import type { KernelConfig, Task, TaskStatus } from "./types.js";
import { isSchedulable } from "./types.js";
import { findCascadedEscalations, findMergeReady, selectTasks, shouldRequeueRecurring } from "./scheduler/scheduler.js";
import { mergeWorktreeToMain as defaultMergeWorktreeToMain } from "./merge.js";
import { harvestRecurringFixTasks } from "./harvest.js";

type MergeTransition = { nextStatus?: TaskStatus } | undefined;

interface KernelStore {
  list(): Promise<Task[]>;
  updateStatus(taskId: string, status: TaskStatus, metadata?: Record<string, unknown>): Promise<void>;
  createTask?(task: Task): Promise<void>;
}

interface KernelScheduler {
  selectTasks?(tasks: Task[], options: { maxConcurrency: number; runningCount: number }): Task[];
  findCascadedEscalations?(tasks: Task[]): Task[];
  findMergeReady?(tasks: Task[]): Task[];
}

interface KernelSupervisor {
  spawnAgent(task: Task): Promise<void>;
  getRunningCount?(): number | Promise<number>;
}

interface KernelOptions {
  store: KernelStore;
  scheduler?: KernelScheduler;
  supervisor?: KernelSupervisor;
  gcWorktrees?: (tasks: Task[], mergeQueuedTaskIds: string[]) => Promise<void>;
  mergeWorktreeToMain?: (task: Task) => Promise<MergeTransition>;
  config?: Partial<Pick<KernelConfig, "maxConcurrency" | "maxRecurringFixTasks" | "poisonPillThreshold">>;
  harvestCandidates?: () => Promise<Task[]>;
  writeCrashState?: (state: KernelCrashState) => Promise<void>;
  inspectStartupSignal?: (task: Task) => Promise<StartupSignalResolution | undefined>;
  isTaskProcessAlive?: (task: Task) => boolean | Promise<boolean>;
  terminateOrphanProcess?: (task: Task) => Promise<void>;
}

export interface KernelCrashState {
  timestamp: string;
  error: {
    message: string;
    stack?: string;
  };
  activeTaskIds: string[];
}

export type StartupSignalResolution =
  | {
    status: "completed";
    metadata?: Record<string, unknown>;
  }
  | {
    status: "escalated";
    reason: "agent_escalated" | "conflicting_signals";
    metadata?: Record<string, unknown>;
  };

/**
 * Phase 6 kernel.
 *
 * Tick sequence:
 * 1. Escalate exhausted tasks (budget already spent)
 * 2. Cascade escalations (transitive, resolved in one tick)
 * 3. Merge queue (at most one per tick — P7)
 * 4. Recurring task re-queue (P15)
 * 5. Harvest follow-up tasks from recurring sources (H12)
 * 6. GC orphaned worktrees
 * 7. Dispatch eligible tasks to agents
 *
 * Startup: reconcileStartupState handles orphan recovery (H23).
 * Crash: handleCrash writes diagnosable state (H13, H21).
 *
 */
export class Kernel {
  private readonly store: KernelStore;
  private readonly scheduler: KernelScheduler;
  private readonly supervisor?: KernelSupervisor;
  private readonly gcWorktrees?: (tasks: Task[], mergeQueuedTaskIds: string[]) => Promise<void>;
  private readonly mergeWorktreeToMain: (task: Task) => Promise<MergeTransition>;
  private readonly maxConcurrency: number;
  private readonly maxRecurringFixTasks: number;
  private readonly poisonPillThreshold: number;
  private readonly harvestCandidates?: () => Promise<Task[]>;
  private readonly writeCrashState: (state: KernelCrashState) => Promise<void>;
  private readonly inspectStartupSignal?: (task: Task) => Promise<StartupSignalResolution | undefined>;
  private readonly isTaskProcessAlive: (task: Task) => boolean | Promise<boolean>;
  private readonly terminateOrphanProcess: (task: Task) => Promise<void>;
  private tickInProgress = false;

  constructor(options: KernelOptions) {
    this.store = options.store;
    this.scheduler = options.scheduler ?? {};
    this.supervisor = options.supervisor;
    this.gcWorktrees = options.gcWorktrees;
    this.mergeWorktreeToMain = options.mergeWorktreeToMain ?? (async (task) => defaultMergeWorktreeToMain({ taskId: task.id }));
    this.maxConcurrency = options.config?.maxConcurrency ?? 1;
    this.maxRecurringFixTasks = options.config?.maxRecurringFixTasks ?? 3;
    this.poisonPillThreshold = options.config?.poisonPillThreshold ?? 2;
    this.harvestCandidates = options.harvestCandidates;
    this.writeCrashState = options.writeCrashState ?? (async () => undefined);
    this.inspectStartupSignal = options.inspectStartupSignal;
    this.isTaskProcessAlive = options.isTaskProcessAlive ?? (() => false);
    this.terminateOrphanProcess = options.terminateOrphanProcess ?? (async () => undefined);
  }

  async handleCrash(error: unknown, activeTasks: Array<Pick<Task, "id">> = []): Promise<void> {
    await this.writeCrashState({
      timestamp: new Date().toISOString(),
      error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      activeTaskIds: activeTasks.map((task) => task.id),
    });
  }

  async reconcileStartupState(): Promise<void> {
    const tasks = await this.store.list();

    for (const task of tasks) {
      if (task.status !== "generator_running" && task.status !== "evaluator_running") {
        continue;
      }

      const signalResolution = await this.inspectStartupSignal?.(task);
      if (signalResolution) {
        await this.store.updateStatus(task.id, signalResolution.status, {
          source: "kernel.reconcileStartupState",
          ...(signalResolution.status === "escalated" ? { reason: signalResolution.reason } : {}),
          ...signalResolution.metadata,
        });
        Object.assign(task, { status: signalResolution.status });
        continue;
      }

      if (await this.isTaskProcessAlive(task)) {
        await this.terminateOrphanProcess(task);
      }

      const crashCount = (task.crash_count ?? 0) + 1;
      if (crashCount > this.poisonPillThreshold) {
        await this.store.updateStatus(task.id, "escalated", {
          source: "kernel.reconcileStartupState",
          reason: "poison_pill",
          crashCount,
          threshold: this.poisonPillThreshold,
        });
        Object.assign(task, { status: "escalated" as const, crash_count: crashCount });
        continue;
      }

      await this.store.updateStatus(task.id, "retry_pending", {
        source: "kernel.reconcileStartupState",
        reason: "orphan_reaped",
        crashCount,
      });
      Object.assign(task, { status: "retry_pending" as const, crash_count: crashCount });
    }
  }

  async tick(): Promise<void> {
    if (this.tickInProgress) {
      return;
    }

    this.tickInProgress = true;
    try {
      const tasks = await this.store.list();

      await this.processExhaustedTasks(tasks);
      await this.processCascadedEscalations(tasks);
      await this.processMergeQueue(tasks);
      await this.processRecurringTasks(tasks);
      await this.processHarvest(tasks);
      await this.processGc(tasks);
      await this.processDispatch(tasks);
    } finally {
      this.tickInProgress = false;
    }
  }

  private async processExhaustedTasks(tasks: Task[]): Promise<void> {
    for (const task of tasks) {
      if (!isSchedulable(task.status)) continue;

      const currentAttempt = task.current_attempt ?? 1;
      const maxAttempts = task.exploration_budget.max_attempts;
      if (currentAttempt > maxAttempts) {
        await this.store.updateStatus(task.id, "escalated", {
          source: "kernel.processExhaustedTasks",
          reason: "max_attempts_exhausted",
          currentAttempt,
          maxAttempts,
        });
        Object.assign(task, { status: "escalated" as const });
        continue;
      }

      const cumulativeDurationMs = (task.previous_attempts ?? []).reduce(
        (sum, attempt) => sum + (attempt.duration_ms ?? 0),
        0,
      );
      const totalTimeoutMs = task.exploration_budget.total_timeout * 60_000;

      if (cumulativeDurationMs >= totalTimeoutMs) {
        await this.store.updateStatus(task.id, "escalated", {
          source: "kernel.processExhaustedTasks",
          reason: "total_timeout_exhausted",
          cumulativeDurationMs,
          totalTimeoutMs,
        });
        Object.assign(task, { status: "escalated" as const });
      }
    }
  }

  private async processCascadedEscalations(tasks: Task[]): Promise<void> {
    if (tasks.length === 0) {
      return;
    }

    // Safety bound: at most N passes where N = number of tasks.
    // A valid DAG can cascade at most depth(graph) times. tasks.length is a safe upper bound.
    const maxPasses = tasks.length;
    let lastBlockedCount = 0;

    for (let pass = 0; pass < maxPasses; pass++) {
      const blockedTasks = (this.scheduler.findCascadedEscalations ?? findCascadedEscalations)(tasks);
      if (blockedTasks.length === 0) return;
      lastBlockedCount = blockedTasks.length;

      for (const task of blockedTasks) {
        const blockedBy = task.depends_on.find((depId) => tasks.find((candidate) => candidate.id === depId)?.status === "escalated");

        await this.store.updateStatus(task.id, "escalated", {
          source: "kernel.processCascadedEscalations",
          blockedBy,
        });

        // Keep the in-memory task graph in sync so transitive cascades are resolved in the same tick.
        Object.assign(task, { status: "escalated" as const });
      }
    }

    throw new Error(
      `Cascade escalation did not converge within ${maxPasses} passes (${lastBlockedCount} tasks remained blocked)`,
    );
  }

  private async processMergeQueue(tasks: Task[]): Promise<void> {
    if (!tasks.some((task) => task.status === "completed")) {
      return;
    }

    const mergeReady = (this.scheduler.findMergeReady ?? findMergeReady)(tasks);
    const nextTask = mergeReady[0];
    if (!nextTask) return;

    try {
      const result = await this.mergeWorktreeToMain(nextTask);
      const nextStatus = result?.nextStatus ?? "merged";
      await this.store.updateStatus(nextTask.id, nextStatus, {
        source: "kernel.processMergeQueue",
      });
      Object.assign(nextTask, { status: nextStatus });
    } catch (error) {
      const nextStatus = extractNextStatus(error);
      if (nextStatus) {
        await this.store.updateStatus(nextTask.id, nextStatus, {
          source: "kernel.processMergeQueue",
          error: error instanceof Error ? error.message : String(error),
        });
        Object.assign(nextTask, { status: nextStatus });
        return;
      }

      throw error;
    }
  }

  private async processRecurringTasks(tasks: Task[]): Promise<void> {
    for (const task of tasks) {
      if (task.status !== "merged") continue;
      if (!shouldRequeueRecurring(task)) continue;

      await this.store.updateStatus(task.id, "pending", {
        source: "kernel.processRecurringTasks",
        recurring: true,
      });
      Object.assign(task, { status: "pending" as const });
    }
  }

  private async processHarvest(tasks: Task[]): Promise<void> {
    if (!this.harvestCandidates || !this.store.createTask) {
      return;
    }

    const candidates = await this.harvestCandidates();
    if (candidates.length === 0) {
      return;
    }

    const createdTasks = await harvestRecurringFixTasks({
      candidates,
      existingTasks: tasks,
      maxRecurringFixTasks: this.maxRecurringFixTasks,
      store: {
        createTask: this.store.createTask.bind(this.store),
      },
    });

    tasks.push(...createdTasks);
  }

  private async processGc(tasks: Task[]): Promise<void> {
    if (!this.gcWorktrees) {
      return;
    }

    const mergeQueuedTaskIds = (this.scheduler.findMergeReady ?? findMergeReady)(tasks).map((task) => task.id);
    await this.gcWorktrees(tasks, mergeQueuedTaskIds);
  }

  private async processDispatch(tasks: Task[]): Promise<void> {
    if (!this.supervisor) {
      return;
    }

    const runningCount = this.supervisor.getRunningCount
      ? await this.supervisor.getRunningCount()
      : tasks.filter((task) => hasDispatchCapacityReservation(task.status)).length;

    const nextTasks = (this.scheduler.selectTasks ?? selectTasks)(tasks, {
      maxConcurrency: this.maxConcurrency,
      runningCount,
    });

    for (const task of nextTasks) {
      await this.supervisor.spawnAgent(task);
      Object.assign(task, { status: "reserved" as const });
    }
  }
}

function hasDispatchCapacityReservation(status: TaskStatus): boolean {
  return (
    status === "reserved" ||
    status === "pre_eval" ||
    status === "generator_running" ||
    status === "evaluator_running"
  );
}

function extractNextStatus(error: unknown): TaskStatus | undefined {
  if (typeof error !== "object" || error === null || !("nextStatus" in error)) {
    return undefined;
  }

  const nextStatus = (error as { nextStatus?: unknown }).nextStatus;
  if (nextStatus === "retry_pending" || nextStatus === "escalated") {
    return nextStatus;
  }

  return undefined;
}