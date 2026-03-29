import type {
  IpcResponse,
  RuntimeTaskSummary,
  SnapshotResponse,
  TaskStatusCounts,
  TaskSummariesUpdatedResponse,
} from "./ipc-types.js";
import type { Task, TaskStatus } from "../types.js";

const DEFAULT_BATCH_MS = 50;
const DEFAULT_QUIET_AFTER_MS = 2 * 60_000;
const IMMEDIATE_FLUSH_STATUSES = new Set<TaskStatus>(["completed", "escalated", "merged"]);
const RUNNING_STATUSES = new Set<TaskStatus>(["generator_running", "evaluator_running"]);

export interface RuntimeStateHubOptions {
  batchMs?: number;
  quietAfterMs?: number;
}

export interface QueueTaskUpdateOptions {
  updatedAt?: string;
  lastOutputAt?: string;
}

export interface RuntimeStateHub {
  createSnapshot(tasks?: Task[]): SnapshotResponse;
  queueTaskUpdate(task: Task, options?: QueueTaskUpdateOptions): void;
  noteTaskOutput(taskId: string, options?: { outputAt?: string }): void;
  subscribe(listener: (message: IpcResponse) => void, initialTasks?: Task[]): () => void;
}

export function createRuntimeStateHub(options: RuntimeStateHubOptions = {}): RuntimeStateHub {
  const batchMs = options.batchMs ?? DEFAULT_BATCH_MS;
  const quietAfterMs = options.quietAfterMs ?? DEFAULT_QUIET_AFTER_MS;
  const subscribers = new Set<(message: IpcResponse) => void>();
  const currentSummaries = new Map<string, RuntimeTaskSummary>();
  const pendingSummaries = new Map<string, RuntimeTaskSummary>();
  const quietTimers = new Map<string, NodeJS.Timeout>();
  let sequence = 0;
  let flushTimer: NodeJS.Timeout | null = null;

  const createSnapshot = (tasks: Task[] = []): SnapshotResponse => {
    seedTasks(tasks);
    const taskSummaries = sortSummaries(Array.from(currentSummaries.values()).map((summary) => applyRunHealth(summary, quietAfterMs)));
    return {
      type: "snapshot",
      sequence,
      counts: createStatusCounts(taskSummaries),
      tasks: taskSummaries,
    };
  };

  const flushPending = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingSummaries.size === 0) {
      return;
    }

    const summaries = sortSummaries(Array.from(pendingSummaries.values()).map((summary) => applyRunHealth(summary, quietAfterMs)));
    pendingSummaries.clear();
    sequence += 1;

    for (const summary of summaries) {
      currentSummaries.set(summary.taskId, summary);
    }

    const message: TaskSummariesUpdatedResponse = {
      type: "task-summaries-updated",
      sequence,
      summaries,
    };
    broadcast(message);
  };

  const scheduleFlush = (): void => {
    if (flushTimer) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushPending();
    }, batchMs);
    flushTimer.unref?.();
  };

  const queueTaskUpdate = (task: Task, updateOptions: QueueTaskUpdateOptions = {}): void => {
    const summary = applyRunHealth(
      toTaskSummary(task, updateOptions, currentSummaries.get(task.id)),
      quietAfterMs,
    );
    currentSummaries.set(summary.taskId, summary);
    pendingSummaries.set(summary.taskId, summary);
    scheduleQuietTransition(summary);

    if (IMMEDIATE_FLUSH_STATUSES.has(summary.status)) {
      flushPending();
      return;
    }

    scheduleFlush();
  };

  const noteTaskOutput = (taskId: string, options: { outputAt?: string } = {}): void => {
    const existing = currentSummaries.get(taskId);
    if (!existing) {
      return;
    }

    const summary = applyRunHealth(
      {
        ...existing,
        lastOutputAt: options.outputAt ?? new Date().toISOString(),
      },
      quietAfterMs,
    );

    currentSummaries.set(taskId, summary);
    pendingSummaries.set(taskId, summary);
    scheduleQuietTransition(summary);
    scheduleFlush();
  };

  const subscribe = (listener: (message: IpcResponse) => void, initialTasks: Task[] = []): (() => void) => {
    subscribers.add(listener);
    // Always send a snapshot on subscribe, even for empty kernels (E8).
    // This gives the client a deterministic "subscribe → snapshot" contract.
    listener(createSnapshot(initialTasks));

    let unsubscribed = false;
    return () => {
      if (unsubscribed) {
        return;
      }
      unsubscribed = true;
      subscribers.delete(listener);
    };
  };

  const seedTasks = (tasks: Task[]): void => {
    for (const task of tasks) {
      const summary = applyRunHealth(toTaskSummary(task, {}, currentSummaries.get(task.id)), quietAfterMs);
      const existing = currentSummaries.get(summary.taskId);
      if (!existing || existing.updatedAt <= summary.updatedAt) {
        currentSummaries.set(summary.taskId, summary);
        scheduleQuietTransition(summary);
      }
    }
  };

  const broadcast = (message: IpcResponse): void => {
    for (const subscriber of subscribers) {
      subscriber(message);
    }
  };

  return {
    createSnapshot,
    queueTaskUpdate,
    noteTaskOutput,
    subscribe,
  };

  function scheduleQuietTransition(summary: RuntimeTaskSummary): void {
    clearQuietTimer(summary.taskId);

    if (!RUNNING_STATUSES.has(summary.status)) {
      return;
    }

    const activityAt = summary.lastOutputAt ?? summary.updatedAt;
    const activityMs = Date.parse(activityAt);
    if (Number.isNaN(activityMs)) {
      return;
    }

    const delayMs = Math.max(0, activityMs + quietAfterMs - Date.now());
    const timer = setTimeout(() => {
      quietTimers.delete(summary.taskId);
      markTaskQuiet(summary.taskId, activityAt);
    }, delayMs);
    timer.unref?.();
    quietTimers.set(summary.taskId, timer);
  }

  function markTaskQuiet(taskId: string, expectedActivityAt: string): void {
    const current = currentSummaries.get(taskId);
    if (!current || !RUNNING_STATUSES.has(current.status)) {
      return;
    }

    const currentActivityAt = current.lastOutputAt ?? current.updatedAt;
    if (currentActivityAt !== expectedActivityAt) {
      return;
    }

    const summary = applyRunHealth(current, quietAfterMs);
    if (summary.runHealth === current.runHealth) {
      return;
    }

    currentSummaries.set(taskId, summary);
    pendingSummaries.set(taskId, summary);
    flushPending();
  }

  function clearQuietTimer(taskId: string): void {
    const timer = quietTimers.get(taskId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    quietTimers.delete(taskId);
  }
}

function toTaskSummary(
  task: Task,
  options: QueueTaskUpdateOptions = {},
  existing?: RuntimeTaskSummary,
): RuntimeTaskSummary {
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    // Callers should pass explicit updatedAt values for real status transitions.
    // This fallback only exists so snapshot seeding can produce a best-effort summary
    // from the current task row when no transition timestamp was supplied.
    updatedAt: options.updatedAt ?? deriveUpdatedAt(task),
    lastOutputAt: options.lastOutputAt ?? existing?.lastOutputAt,
    transitionReason: task.previous_attempts?.[task.previous_attempts.length - 1]?.reason,
  };
}

function applyRunHealth(summary: RuntimeTaskSummary, quietAfterMs: number): RuntimeTaskSummary {
  if (!RUNNING_STATUSES.has(summary.status)) {
    return {
      ...summary,
      runHealth: undefined,
    };
  }

  const activityAt = summary.lastOutputAt ?? summary.updatedAt;
  const activityMs = Date.parse(activityAt);
  if (Number.isNaN(activityMs)) {
    return {
      ...summary,
      runHealth: "quiet",
    };
  }

  return {
    ...summary,
    runHealth: Date.now() - activityMs >= quietAfterMs ? "quiet" : "active",
  };
}

function deriveUpdatedAt(task: Task): string {
  return task.completed_at
    ?? task.assigned_at
    ?? task.enqueued_at
    ?? new Date(0).toISOString();
}

function sortSummaries(summaries: RuntimeTaskSummary[]): RuntimeTaskSummary[] {
  return [...summaries].sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function createStatusCounts(summaries: RuntimeTaskSummary[]): TaskStatusCounts {
  const counts: TaskStatusCounts = {
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
  };

  for (const summary of summaries) {
    counts[summary.status] += 1;
  }

  return counts;
}
