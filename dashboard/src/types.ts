// Duplicated from src/server/ipc-types.ts and src/types.ts for browser independence.
// These types define the wire protocol between the kernel WS server and the dashboard.
// Keep in sync manually and backstop with contract tests to catch drift.

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

export type TransitionReason =
  | "timed_out"
  | "rate_limited"
  | "sigkill_unknown"
  | "transient_unknown"
  | "eval_failed"
  | "eval_timed_out"
  | "fatal_disk_full"
  | "fatal_permissions"
  | "fatal_git_corrupted"
  | "fatal_unknown"
  | "max_attempts_exhausted"
  | "total_timeout_exhausted"
  | "agent_escalated"
  | "missing_signal"
  | "conflicting_signals"
  | "failed_to_spawn"
  | "merge_reverted"
  | "worktree_lost"
  | "main_worktree_contaminated"
  | "poison_pill"
  | "orphan_reaped";

export interface TaskSummary {
  taskId: string;
  title: string;
  status: TaskStatus;
  updatedAt: string;
  lastOutputAt?: string;
  runHealth?: "active" | "quiet";
  transitionReason?: TransitionReason;
}

export type TaskStatusCounts = Record<TaskStatus, number>;

export interface SnapshotResponse {
  type: "snapshot";
  sequence: number;
  counts: TaskStatusCounts;
  tasks: TaskSummary[];
}

export interface TaskSummariesUpdatedResponse {
  type: "task-summaries-updated";
  sequence: number;
  summaries: TaskSummary[];
}

export interface AckResponse {
  type: "ack";
  command: string;
  taskId?: string;
}

export interface ErrorResponse {
  type: "error";
  message: string;
}

export type IpcResponse =
  | SnapshotResponse
  | TaskSummariesUpdatedResponse
  | AckResponse
  | ErrorResponse
  | TaskResponse
  | LogsResponse
  | OutputResponse
  | OutputEndedResponse;

export interface BootstrapData {
  wsUrl: string;
  token: string;
  kernelId: number;
}

// ── Detail pane types (from src/server/ipc-types.ts and src/types.ts) ──────

export type TaskPriority = "high" | "medium" | "low";

export interface ExplorationBudget {
  max_attempts: number;
  timeout_per_attempt: number;
  total_timeout: number;
}

export interface PreviousAttempt {
  attempt: number;
  reason: TransitionReason;
  error?: string;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
}

/** Full task object returned by get-task. */
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

  evaluate?: boolean;
  agent?: string;
  evaluator_agent?: string;
  success_criteria?: string[];
  recurring?: boolean;
  recurring_interval_hours?: number;

  // Runtime state
  current_attempt?: number;
  enqueued_at?: string;
  assigned_at?: string;
  completed_at?: string;
  previous_attempts?: PreviousAttempt[];
  cooldown_until?: string;
  crash_count?: number;
}

export interface TaskResponse {
  type: "task";
  taskId: string;
  task: Task | null;
}

export interface RunLogSummary {
  runId: string;
  path: string;
}

export interface LogsResponse {
  type: "logs";
  taskId: string;
  logs: { runLogs: RunLogSummary[]; output: string };
}

export interface OutputResponse {
  type: "output";
  taskId: string;
  text: string;
}

export type OutputEndedReason = "completed" | "escalated" | "paused" | "retry" | "shutdown";

export interface OutputEndedResponse {
  type: "output-ended";
  taskId: string;
  reason: OutputEndedReason;
}
