import type { Task, TaskStatus } from "../types.js";
import { isSchedulable } from "../types.js";

const PRIORITY_SCORES: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

interface SchedulerOptions {
  maxConcurrency: number;
  runningCount: number;
}

/**
 * Select tasks eligible for dispatch.
 *
 * A task is eligible when:
 * - It is in a schedulable state (pending or retry_pending)
 * - Its retry cooldown has expired (H24)
 * - All depends_on are completed or merged
 * - It has not exceeded max_attempts (P4)
 * - There is concurrency capacity available
 */
export function selectTasks(tasks: Task[], options: SchedulerOptions): Task[] {
  const { maxConcurrency, runningCount } = options;
  const available = maxConcurrency - runningCount;
  if (available <= 0) return [];

  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  const eligible = tasks.filter((task) => {
    if (!isSchedulable(task.status)) return false;

    // P4: reject tasks past their attempt budget
    const attempt = task.current_attempt ?? 1;
    if (attempt > task.exploration_budget.max_attempts) return false;

    // H24: respect cooldown_until for backoff
    if (task.cooldown_until) {
      const cooldownExpiry = new Date(task.cooldown_until).getTime();
      if (Date.now() < cooldownExpiry) return false;
    }

    // P13: dependency resolution — all deps must be completed or merged
    for (const depId of task.depends_on) {
      const dep = taskMap.get(depId);
      if (!dep || (dep.status !== "completed" && dep.status !== "merged")) return false;
    }

    return true;
  });

  // Priority scoring with age-based starvation prevention.
  // Uses enqueued_at (first seen by store) for age, not assigned_at (first dispatch).
  // This ensures tasks stuck in pending accumulate age bonus over time.
  const now = Date.now();
  eligible.sort((a, b) => {
    const scoreA = PRIORITY_SCORES[a.priority] ?? 0;
    const scoreB = PRIORITY_SCORES[b.priority] ?? 0;
    const ageA = a.enqueued_at ? ((now - new Date(a.enqueued_at).getTime()) / 3_600_000) * 0.1 : 0;
    const ageB = b.enqueued_at ? ((now - new Date(b.enqueued_at).getTime()) / 3_600_000) * 0.1 : 0;
    return scoreB + ageB - (scoreA + ageA);
  });

  return eligible.slice(0, available);
}

/**
 * Find completed tasks ready to merge.
 * A task is merge-ready when all depends_on are merged (not just completed).
 */
export function findMergeReady(tasks: Task[]): Task[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  return tasks.filter((task) => {
    if (task.status !== "completed") return false;
    for (const depId of task.depends_on) {
      const dep = taskMap.get(depId);
      if (!dep || dep.status !== "merged") return false;
    }
    return true;
  });
}

/**
 * Find schedulable tasks blocked by escalated dependencies.
 * This applies to both pending and retry_pending via isSchedulable().
 * These tasks can never be satisfied and should cascade to escalated.
 *
 * NOTE: This only cascades one level per call. For a chain A→B→C where C
 * is escalated, B is detected first. A is only detected on a later pass
 * after B has been marked escalated. Phase 6 kernel must either loop until
 * no new cascades are found during a tick or compute the transitive closure
 * before applying escalations.
 */
export function findCascadedEscalations(tasks: Task[]): Task[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  return tasks.filter((task) => {
    if (!isSchedulable(task.status)) return false;
    return task.depends_on.some((depId) => {
      const dep = taskMap.get(depId);
      return dep?.status === "escalated";
    });
  });
}

/**
 * Determine if a recurring task should be re-queued.
 * Only re-queues after merging — completed tasks haven't been verified
 * against main yet and shouldn't restart the cycle.
 */
export function shouldRequeueRecurring(task: Pick<Task, "status" | "recurring" | "recurring_interval_hours" | "completed_at">): boolean {
  if (!task.recurring) return false;
  if (task.status !== "merged") return false;
  if (!task.completed_at) return false;

  const cooldownHours = task.recurring_interval_hours ?? 24;
  const elapsed = Date.now() - new Date(task.completed_at).getTime();
  return elapsed >= cooldownHours * 3_600_000;
}

type RecurringSourceLike = Pick<Task, "id"> & {
  source_task_id?: string;
};

type RecurringFixTaskLike = RecurringSourceLike & {
  title: string;
  status: TaskStatus;
};

export function getRecurringSourceTaskId(task: RecurringSourceLike): string {
  return task.source_task_id ?? task.id;
}

export function canSpawnRecurringFixTask(
  candidate: Pick<Task, "id" | "title"> & { source_task_id?: string },
  tasks: RecurringFixTaskLike[],
  maxRecurringFixTasks: number,
): boolean {
  const sourceTaskId = getRecurringSourceTaskId(candidate);
  const normalizedCandidateTitle = normalizeRecurringTitle(candidate.title);

  let openFixCount = 0;

  for (const task of tasks) {
    if (task.id === sourceTaskId) continue;
    if (getRecurringSourceTaskId(task) !== sourceTaskId) continue;
    if (isRecurringTerminal(task.status)) continue;

    openFixCount += 1;

    if (normalizeRecurringTitle(task.title) === normalizedCandidateTitle) {
      return false;
    }
  }

  return openFixCount < maxRecurringFixTasks;
}

function normalizeRecurringTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function isRecurringTerminal(status: TaskStatus): boolean {
  return status === "merged" || status === "escalated";
}
