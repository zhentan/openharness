import type { OutputEndedReason } from "../server/ipc-types.js";
import type { AgentAdapter, AgentProcess, Task, TaskStatus, TransitionReason } from "../types.js";
import { isSchedulable } from "../types.js";

interface StatusStore {
  updateStatus(taskId: string, status: TaskStatus, metadata?: Record<string, unknown>): Promise<void>;
}

interface PreEvaluator {
  run?(task: Task): Promise<unknown>;
}

interface AttachedProcess {
  pid: number;
  pgid: number;
}

type OutputListener = (chunk: string) => void;

interface SupervisorOptions {
  store: StatusStore;
  preEvaluator?: PreEvaluator;
  generatorAdapter?: Pick<AgentAdapter, "name" | "spawn">;
  resolveGeneratorAdapter?: (task: Task) => Pick<AgentAdapter, "name" | "spawn">;
  resolveWorkingDirectory?: (task: Task) => string;
  prepareWorkingDirectory?: (task: Task, runId: string) => Promise<string>;
  resolveOutputFilePath?: (task: Task, runId: string) => string | undefined;
  terminateProcessGroup?: (pgid: number) => Promise<void>;
  cleanupPausedWorktree?: (taskId: string) => Promise<void>;
  onTaskOutput?: (taskId: string, chunk: string) => void;
  verifyMainWorktreeIntegrity?: (task: Task) => Promise<string | undefined>;
}

type ExitEvent =
  | { type: "completion" }
  | { type: "escalation"; reason: TransitionReason; feedback?: string }
  | { type: "retry"; reason: TransitionReason; feedback?: string };

type ExitEventWithDuration = ExitEvent & { durationMs?: number };

/**
 * Initial Phase 5 supervisor slice.
 *
 * This class intentionally implements the smallest coherent surface needed
 * for the first supervisor invariants: reserve-before-async, fire-and-forget
 * spawn, drain-and-pause, and resume.
 */
export class Supervisor {
  private readonly store: StatusStore;
  private readonly preEvaluator?: PreEvaluator;
  private readonly generatorAdapter?: Pick<AgentAdapter, "name" | "spawn">;
  private readonly resolveGeneratorAdapter?: (task: Task) => Pick<AgentAdapter, "name" | "spawn">;
  private readonly resolveWorkingDirectory?: (task: Task) => string;
  private readonly prepareWorkingDirectory?: (task: Task, runId: string) => Promise<string>;
  private readonly resolveOutputFilePath?: (task: Task, runId: string) => string | undefined;
  private readonly terminateProcessGroup: (pgid: number) => Promise<void>;
  private readonly cleanupPausedWorktree: (taskId: string) => Promise<void>;
  private readonly onTaskOutput?: (taskId: string, chunk: string) => void;
  private readonly verifyMainWorktreeIntegrity?: (task: Task) => Promise<string | undefined>;
  private readonly processes = new Map<string, AttachedProcess>();
  private readonly outputListeners = new Map<string, Set<OutputListener>>();
  private readonly outputEndListeners = new Map<string, Set<(reason: OutputEndedReason) => void>>();
  private readonly pauseRequested = new Set<string>();

  constructor(options: SupervisorOptions) {
    this.store = options.store;
    this.preEvaluator = options.preEvaluator;
    this.generatorAdapter = options.generatorAdapter;
    this.resolveGeneratorAdapter = options.resolveGeneratorAdapter;
    this.resolveWorkingDirectory = options.resolveWorkingDirectory;
    this.prepareWorkingDirectory = options.prepareWorkingDirectory;
    this.resolveOutputFilePath = options.resolveOutputFilePath;
    this.terminateProcessGroup = options.terminateProcessGroup ?? (async () => undefined);
    this.cleanupPausedWorktree = options.cleanupPausedWorktree ?? (async () => undefined);
    this.onTaskOutput = options.onTaskOutput;
    this.verifyMainWorktreeIntegrity = options.verifyMainWorktreeIntegrity;
  }

  async spawnAgent(task: Task): Promise<void> {
    if (!isSchedulable(task.status)) {
      throw new Error(`Task ${task.id} is not in a schedulable state`);
    }

    const adapter = this.resolveGeneratorAdapter?.(task) ?? this.generatorAdapter;
    if (!adapter) {
      throw new Error(`Task ${task.id} cannot start: generator adapter is not configured`);
    }

    const runId = new Date().toISOString();

    // P6: Task must leave schedulable states BEFORE spawnAgent returns.
    // This prevents the scheduler from re-dispatching it on the next tick.
    // The await ensures the status is flushed to SQLite before we return.
    await this.store.updateStatus(task.id, "reserved", {
      source: "supervisor.spawnAgent",
      assignedAt: runId,
    });
    Object.assign(task, { assigned_at: runId });

    // P5: Fire-and-forget — background work doesn't block the tick loop.
    void this.beginAgentRun(task, adapter, runId).catch(async (error) => {
      await this.store.updateStatus(task.id, "retry_pending", {
        source: "supervisor.beginAgentRun",
        reason: "failed_to_spawn",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  attachProcess(taskId: string, process: AttachedProcess): void {
    this.processes.set(taskId, process);
  }

  subscribeTaskOutput(taskId: string, listener: OutputListener, onEnded?: (reason: OutputEndedReason) => void): () => void {
    const listeners = this.outputListeners.get(taskId) ?? new Set<OutputListener>();
    listeners.add(listener);
    this.outputListeners.set(taskId, listeners);

    if (onEnded) {
      const endListeners = this.outputEndListeners.get(taskId) ?? new Set<(reason: OutputEndedReason) => void>();
      endListeners.add(onEnded);
      this.outputEndListeners.set(taskId, endListeners);
    }

    let unsubscribed = false;
    return () => {
      if (unsubscribed) {
        return;
      }
      unsubscribed = true;
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.outputListeners.delete(taskId);
      }
      if (onEnded) {
        const endListeners = this.outputEndListeners.get(taskId);
        if (endListeners) {
          endListeners.delete(onEnded);
          if (endListeners.size === 0) {
            this.outputEndListeners.delete(taskId);
          }
        }
      }
    };
  }

  hasRunningProcess(taskId: string): boolean {
    return this.processes.has(taskId);
  }

  clearPauseFlag(taskId: string): void {
    this.pauseRequested.delete(taskId);
  }

  async requestPause(taskId: string): Promise<void> {
    this.pauseRequested.add(taskId);
  }

  async killTask(taskId: string): Promise<void> {
    const proc = this.processes.get(taskId);
    if (!proc) {
      throw new Error(`No running process for task ${taskId}`);
    }

    // Kill supersedes pause (reviewer §3: clear pending pause flag)
    this.pauseRequested.delete(taskId);

    // Remove from tracking before termination — the process exit handler
    // will be a no-op for the process map since we already removed it,
    // but handleAgentExit still runs for state transitions.
    this.processes.delete(taskId);

    await this.terminateProcessGroup(proc.pgid);
  }

  async shutdown(): Promise<void> {
    const runningProcesses = Array.from(this.processes.values());
    this.pauseRequested.clear();

    // Notify all output subscribers before clearing state
    for (const taskId of this.outputEndListeners.keys()) {
      this.notifyOutputEnded(taskId, "shutdown");
    }

    await Promise.all(
      runningProcesses.map(async (process) => {
        await this.terminateProcessGroup(process.pgid);
      }),
    );

    this.processes.clear();
  }

  async handleAgentExit(taskId: string, event: ExitEvent): Promise<void> {
    this.processes.delete(taskId);

    if (this.pauseRequested.has(taskId)) {
      this.notifyOutputEnded(taskId, "paused");
      this.pauseRequested.delete(taskId);
      await this.store.updateStatus(taskId, "paused", {
        source: "supervisor.handleAgentExit",
        intercepted: event.type,
      });
      return;
    }

    if (event.type === "completion") {
      this.notifyOutputEnded(taskId, "completed");
      await this.store.updateStatus(taskId, "completed", { source: "supervisor.handleAgentExit" });
      return;
    }

    if (event.type === "escalation") {
      const reason = requireReason(event, taskId);
      this.notifyOutputEnded(taskId, "escalated");
      await this.store.updateStatus(taskId, "escalated", {
        source: "supervisor.handleAgentExit",
        reason,
        feedback: event.feedback,
      });
      return;
    }

    const reason = requireReason(event, taskId);

    if (reason === "eval_failed") {
      this.notifyOutputEnded(taskId, "retry");
      await this.store.updateStatus(taskId, "revisions_requested", {
        source: "supervisor.handleAgentExit",
        reason,
        feedback: event.feedback,
      });
      return;
    }

    // Fatal failures bypass retry budget — escalate immediately (H22)
    if (isFatalReason(reason)) {
      this.notifyOutputEnded(taskId, "escalated");
      await this.store.updateStatus(taskId, "escalated", {
        source: "supervisor.handleAgentExit",
        reason,
        feedback: event.feedback,
      });
      return;
    }

    this.notifyOutputEnded(taskId, "retry");
    await this.store.updateStatus(taskId, "retry_pending", {
      source: "supervisor.handleAgentExit",
      reason,
      feedback: event.feedback,
    });
  }

  /**
   * Handle agent exit with full task context for budget enforcement.
   *
   * This is the budget-aware version of handleAgentExit. It checks:
   * - H22: Fatal failures bypass retry budget → escalated immediately
   * - H9: Cumulative total_timeout across all attempts → total_timeout_exhausted
   * - Otherwise: delegates to handleAgentExit for standard routing
   */
  async handleAgentExitWithTask(task: Task, event: ExitEventWithDuration): Promise<void> {
    this.processes.delete(task.id);

    // Pause intercept (same as handleAgentExit)
    if (this.pauseRequested.has(task.id)) {
      this.notifyOutputEnded(task.id, "paused");
      this.pauseRequested.delete(task.id);
      await this.store.updateStatus(task.id, "paused", {
        source: "supervisor.handleAgentExitWithTask",
        intercepted: event.type,
      });
      return;
    }

    // Completion and escalation pass through directly
    if (event.type === "completion") {
      this.notifyOutputEnded(task.id, "completed");
      await this.store.updateStatus(task.id, "completed", { source: "supervisor.handleAgentExitWithTask" });
      return;
    }

    if (event.type === "escalation") {
      const reason = requireReason(event, task.id);
      this.notifyOutputEnded(task.id, "escalated");
      await this.store.updateStatus(task.id, "escalated", {
        source: "supervisor.handleAgentExitWithTask",
        reason,
        feedback: event.feedback,
      });
      return;
    }

    // Retry path — check budgets before allowing retry
    const reason = requireReason(event, task.id);

    // H22: Fatal failures bypass retry budget
    if (isFatalReason(reason)) {
      this.notifyOutputEnded(task.id, "escalated");
      await this.store.updateStatus(task.id, "escalated", {
        source: "supervisor.handleAgentExitWithTask",
        reason,
        feedback: event.feedback,
      });
      return;
    }

    const currentAttempt = task.current_attempt ?? 1;
    const maxAttempts = task.exploration_budget.max_attempts;

    if (currentAttempt >= maxAttempts) {
      this.notifyOutputEnded(task.id, "escalated");
      await this.store.updateStatus(task.id, "escalated", {
        source: "supervisor.handleAgentExitWithTask",
        reason: "max_attempts_exhausted",
        lastFailureReason: reason,
        feedback: event.feedback,
        currentAttempt,
        maxAttempts,
      });
      return;
    }

    // H9: Check cumulative total_timeout
    const previousDuration = (task.previous_attempts ?? [])
      .reduce((sum, a) => sum + (a.duration_ms ?? 0), 0);
    const cumulativeDuration = previousDuration + (event.durationMs ?? 0);
    const totalTimeoutMs = task.exploration_budget.total_timeout * 60_000;

    if (cumulativeDuration >= totalTimeoutMs) {
      this.notifyOutputEnded(task.id, "escalated");
      await this.store.updateStatus(task.id, "escalated", {
        source: "supervisor.handleAgentExitWithTask",
        reason: "total_timeout_exhausted",
        lastFailureReason: reason,
        feedback: event.feedback,
        cumulativeDurationMs: cumulativeDuration,
        totalTimeoutMs,
      });
      return;
    }

    // eval_failed → revisions_requested (with feedback)
    if (reason === "eval_failed") {
      this.notifyOutputEnded(task.id, "retry");
      await this.store.updateStatus(task.id, "revisions_requested", {
        source: "supervisor.handleAgentExitWithTask",
        reason,
        feedback: event.feedback,
      });
      return;
    }

    this.notifyOutputEnded(task.id, "retry");
    await this.store.updateStatus(task.id, "retry_pending", {
      source: "supervisor.handleAgentExitWithTask",
      reason,
      feedback: event.feedback,
    });
  }

  async resumeTask(taskId: string): Promise<void> {
    await this.cleanupPausedWorktree(taskId);
    await this.store.updateStatus(taskId, "pending", { source: "supervisor.resumeTask" });
  }

  private async beginAgentRun(task: Task, adapter: Pick<AgentAdapter, "name" | "spawn">, runId: string): Promise<void> {
    // Pre-eval runs after reserve is confirmed (reserve awaited in spawnAgent)
    await this.preEvaluator?.run?.(task);

    const workingDirectory = await this.prepareWorkingDirectory?.(task, runId)
      ?? this.resolveWorkingDirectory?.(task)
      ?? ".";

    const agentProcess = adapter.spawn({
      prompt: buildAgentPrompt(task.agent_prompt, task.id, runId),
      workingDirectory,
      timeoutMinutes: task.exploration_budget.timeout_per_attempt,
      outputFilePath: this.resolveOutputFilePath?.(task, runId),
      env: {
        OPENHARNESS_TASK_ID: task.id,
        OPENHARNESS_RUN_ID: runId,
      },
    });

    await this.store.updateStatus(task.id, "generator_running", {
      source: "supervisor.beginAgentRun",
      adapter: adapter.name,
    });
    this.attachProcess(task.id, { pid: agentProcess.pid, pgid: agentProcess.pgid });
    void this.forwardAgentOutput(task.id, agentProcess.output);

    void this.monitorAgentRun(task, agentProcess).catch(async (error) => {
      await this.handleAgentExitWithTask(task, {
        type: "retry",
        reason: "transient_unknown",
        feedback: error instanceof Error ? error.message : String(error),
        durationMs: 0,
      });
    });
  }

  private async monitorAgentRun(task: Task, agentProcess: Awaited<ReturnType<AgentAdapter["spawn"]>>): Promise<void> {
    const result = await agentProcess.wait();
    const integrityViolation = await this.verifyMainWorktreeIntegrity?.(task);
    if (integrityViolation) {
      await this.handleAgentExitWithTask(task, {
        type: "escalation",
        reason: "main_worktree_contaminated",
        feedback: integrityViolation,
        durationMs: result.duration,
      });
      return;
    }
    const event = mapAgentResultToExitEvent(result);
    await this.handleAgentExitWithTask(task, {
      ...event,
      durationMs: result.duration,
    });
  }

  private notifyOutputEnded(taskId: string, reason: OutputEndedReason): void {
    const endListeners = this.outputEndListeners.get(taskId);
    if (endListeners) {
      for (const listener of endListeners) {
        listener(reason);
      }
    }
    this.outputListeners.delete(taskId);
    this.outputEndListeners.delete(taskId);
  }

  private async forwardAgentOutput(taskId: string, output: AsyncIterable<string>): Promise<void> {
    try {
      for await (const chunk of output) {
        this.onTaskOutput?.(taskId, chunk);
        const listeners = this.outputListeners.get(taskId);
        if (!listeners || listeners.size === 0) {
          continue;
        }
        for (const listener of listeners) {
          listener(chunk);
        }
      }
    } catch {
      // Output forwarding is best-effort; exit classification comes from wait().
    }
  }
}

function buildAgentPrompt(taskPrompt: string, taskId: string, runId: string): string {
  return [
    "OpenHarness signal protocol:",
    "- Work inside the current working directory.",
    "- On successful completion, write .openharness/completion.json before exiting.",
    "- The completion payload must be valid JSON with keys: status, summary, task_id, run_id.",
    "- Set status to \"completed\".",
    "- Set task_id from the OPENHARNESS_TASK_ID environment variable.",
    "- Set run_id from the OPENHARNESS_RUN_ID environment variable.",
    `- For this run, task_id must be exactly \"${taskId}\".`,
    `- For this run, run_id must be exactly \"${runId}\".`,
    "- On irreversible failure or if you must hand work back to a human, write .openharness/escalation.json before exiting.",
    "- The escalation payload must be valid JSON with keys: reason, rule, task_id, run_id.",
    "- Never write both .openharness/completion.json and .openharness/escalation.json in the same run.",
    "",
    "Original task:",
    taskPrompt,
  ].join("\n");
}

function mapAgentResultToExitEvent(result: Awaited<ReturnType<AgentProcess["wait"]>>): ExitEvent {
  if (result.completionSignal) {
    return { type: "completion" };
  }

  if (
    result.escalationSignal ||
    result.classification?.severity === "AGENT" ||
    result.classification?.reason === "conflicting_signals"
  ) {
    return {
      type: "escalation",
      reason: result.classification?.reason ?? "agent_escalated",
      feedback: result.classification?.detail ?? result.escalationSignal?.reason,
    };
  }

  return {
    type: "retry",
    reason: result.classification?.reason ?? "transient_unknown",
    feedback: result.classification?.detail,
  };
}

const FATAL_REASONS = new Set<string>([
  "fatal_disk_full",
  "fatal_permissions",
  "fatal_git_corrupted",
  "fatal_unknown",
  "worktree_lost",
  "main_worktree_contaminated",
]);

function isFatalReason(reason?: TransitionReason): boolean {
  return reason !== undefined && FATAL_REASONS.has(reason);
}

function requireReason(
  event: Extract<ExitEvent, { type: "retry" | "escalation" }>,
  taskId: string,
): TransitionReason {
  if (!event.reason) {
    throw new Error(`Task ${taskId} exit event of type ${event.type} requires a reason`);
  }

  return event.reason;
}
