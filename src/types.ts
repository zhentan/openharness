// src/types.ts — Core type definitions for OpenHarness v2

// ─── Task Status ───

export type TaskStatus =
  | "pending"
  | "reserved"
  | "pre_eval"
  | "generator_running"
  | "evaluator_running"
  | "revisions_requested"
  | "completed"
  | "merge_pending"
  | "merged"
  | "paused"
  | "retry_pending"
  | "escalated";

/** Statuses where a task can be picked up by the scheduler. */
export function isSchedulable(status: TaskStatus): boolean {
  return status === "pending" || status === "retry_pending";
}

/** Statuses where the task is actively being processed. */
export function isActive(status: TaskStatus): boolean {
  return (
    status === "reserved" ||
    status === "pre_eval" ||
    status === "generator_running" ||
    status === "evaluator_running" ||
    status === "revisions_requested"
  );
}

/** Statuses where the task is done (no further processing). */
export function isTerminal(status: TaskStatus): boolean {
  return status === "merged" || status === "escalated";
}

/** Statuses where the worktree should be preserved by GC. */
export function shouldPreserveWorktree(status: TaskStatus): boolean {
  return !isTerminal(status);
}

// ─── Transition Reasons ───

export type TransitionReason =
  // Transient (retriable with backoff)
  | "timed_out"
  | "rate_limited"
  | "sigkill_unknown"
  | "transient_unknown"
  // Code quality (revision with feedback)
  | "eval_failed"
  // Evaluator infrastructure
  | "eval_timed_out"
  // Fatal environmental (bypass retry budget)
  | "fatal_disk_full"
  | "fatal_permissions"
  | "fatal_git_corrupted"
  | "fatal_unknown"
  // Budget exhaustion
  | "max_attempts_exhausted"
  | "total_timeout_exhausted"
  // Agent-initiated
  | "agent_escalated"
  // Protocol
  | "missing_signal"
  | "conflicting_signals"
  | "failed_to_spawn"
  | "merge_reverted"
  | "worktree_lost"
  | "main_worktree_contaminated"
  // Restart recovery
  | "poison_pill"
  | "orphan_reaped";

// ─── Error Classification ───

export type ErrorSeverity = "FATAL" | "TRANSIENT" | "AGENT";

export interface ErrorClassification {
  severity: ErrorSeverity;
  reason: TransitionReason;
  detail?: string;
}

// ─── Task ───

export type TaskPriority = "high" | "medium" | "low";

export interface ExplorationBudget {
  max_attempts: number;
  timeout_per_attempt: number; // minutes
  total_timeout: number; // minutes (cumulative across all attempts)
}

export interface PreviousAttempt {
  attempt: number;
  reason: TransitionReason;
  error?: string;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
}

export interface Task {
  id: string;
  source_task_id?: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  depends_on: string[];
  agent_prompt: string;
  exploration_budget: ExplorationBudget;
  escalation_rules: string[];

  // Optional task-level overrides
  evaluate?: boolean;
  agent?: string;
  evaluator_agent?: string;
  success_criteria?: string[];
  recurring?: boolean;
  recurring_interval_hours?: number;

  // Runtime state (managed by kernel, not user-authored)
  current_attempt?: number;
  enqueued_at?: string; // ISO — set once when task is first seen by the store, never overwritten
  assigned_at?: string;
  completed_at?: string;
  previous_attempts?: PreviousAttempt[];
  cooldown_until?: string;
  crash_count?: number;
}

// ─── Agent Interface ───

export interface CompletionSignal {
  status: "completed";
  summary: string;
  task_id?: string;
  run_id?: string;
}

export interface EscalationSignal {
  reason: string;
  rule: string;
  task_id?: string;
  run_id?: string;
}

export interface AgentResult {
  exitCode: number;
  duration: number; // milliseconds
  output: string;
  pgid?: number;
  classification?: ErrorClassification;
  completionSignal?: CompletionSignal;
  escalationSignal?: EscalationSignal;
}

export interface AgentProcess {
  pid: number;
  pgid: number;
  output: AsyncIterable<string>;
  wait(): Promise<AgentResult>;
  kill(): Promise<void>;
}

export interface AgentAdapter {
  name: string;
  command?: string;
  availabilityArgs?: string[];
  spawn(config: {
    prompt: string;
    workingDirectory: string;
    timeoutMinutes: number;
    outputFilePath?: string;
    env?: Record<string, string>;
  }): AgentProcess;
}

// ─── Kernel Config ───

export interface KernelConfig {
  tickIntervalMs: number;
  maxConcurrency: number;
  tasksDir: string;
  runsDir: string;
  worktreesDir: string;
  port: number;
  defaultAdapter: string;
  evaluatorAdapter: string;
  adapters: Record<string, string>;

  // Backoff
  backoffBaseDelayMs: number;
  backoffMaxDelayMs: number;

  // Safety
  poisonPillThreshold: number;

  // Recurring
  maxRecurringFixTasks: number;
}

// ─── Run Log ───

export interface RunLogEntry {
  taskId: string;
  title: string;
  attempt: number;
  startTime: string;
  endTime: string;
  duration: number;
  exitCode: number;
  outcome: TransitionReason;
  filesChanged?: string[];
  completionSummary?: string;
  outputLogPath: string;
  metadata?: Record<string, unknown>;
}
