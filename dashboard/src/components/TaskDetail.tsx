import { useEffect, useRef, useState, useCallback } from "react";
import type { TaskSummary, TaskStatus, Task } from "../types.js";
import type {
  ConnectionState,
  KernelConnection,
  OutputListener,
  LogsResult,
} from "../lib/connection.js";
import { TaskControls } from "./TaskControls.js";

export interface TaskDetailProps {
  selectedTaskId: string | null;
  tasks: ReadonlyMap<string, TaskSummary>;
  connectionState: ConnectionState;
  connection: KernelConnection;
}

const MONO = "'Geist Mono', 'SF Mono', 'Consolas', monospace";
const SANS = "'Geist Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

const RUNNING_STATUSES = new Set<TaskStatus>(["generator_running", "evaluator_running"]);

// Never-run statuses: tasks that have never been assigned to an agent.
const NEVER_RUN_STATUSES = new Set<TaskStatus>(["pending", "reserved"]);

/** Output cap: 256 KB for both historical and live rolling buffer (B1). */
const OUTPUT_CAP_BYTES = 256 * 1024;

type OutputMode = "live" | "historical" | "none";

interface OutputState {
  mode: OutputMode;
  text: string;
  totalBytes: number;     // total bytes received/loaded (for truncation indicator)
  truncated: boolean;
}

// Status color mapping (mirrors SummaryGrid)
const STATUS_COLORS: Partial<Record<TaskStatus, string>> = {
  escalated: "#ef4444",
  paused: "#a78bfa",
  retry_pending: "#f59e0b",
  generator_running: "#22c55e",
  evaluator_running: "#22c55e",
};

const MUTED_STATUS_COLOR = "#737373";

function statusColor(status: TaskStatus): string {
  return STATUS_COLORS[status] ?? MUTED_STATUS_COLOR;
}

export function TaskDetail({
  selectedTaskId,
  tasks,
  connectionState,
  connection,
}: TaskDetailProps) {
  const [fullTask, setFullTask] = useState<Task | null>(null);
  const [taskNotFound, setTaskNotFound] = useState(false);
  const [output, setOutput] = useState<OutputState>({
    mode: "none",
    text: "",
    totalBytes: 0,
    truncated: false,
  });

  // Track previous values for change detection
  const prevSelectedIdRef = useRef<string | null>(null);
  const prevStatusRef = useRef<TaskStatus | undefined>(undefined);
  const prevConnectionStateRef = useRef<ConnectionState>(connectionState);
  const outputUnsubRef = useRef<(() => void) | null>(null);

  // Get current summary for the selected task
  const summary = selectedTaskId ? tasks.get(selectedTaskId) ?? null : null;
  const isRunning = summary ? RUNNING_STATUSES.has(summary.status) : false;

  // Cleanup output subscription
  const cleanupOutputSub = useCallback(() => {
    if (outputUnsubRef.current) {
      outputUnsubRef.current();
      outputUnsubRef.current = null;
    }
  }, []);

  // Fetch full task via get-task
  const fetchTask = useCallback(
    async (taskId: string) => {
      if (connectionState !== "connected") return;
      try {
        const result = await connection.getTask(taskId);
        if (result.task) {
          setFullTask(result.task);
          setTaskNotFound(false);
        } else {
          setFullTask(null);
          setTaskNotFound(true);
        }
      } catch {
        // Connection error — don't retry
        setTaskNotFound(true);
      }
    },
    [connection, connectionState],
  );

  // Fetch historical logs
  const fetchLogs = useCallback(
    async (taskId: string) => {
      if (connectionState !== "connected") return;
      try {
        const logs: LogsResult = await connection.getLogs(taskId);
        const raw = logs.output;
        const totalBytes = new Blob([raw]).size;
        const truncated = totalBytes > OUTPUT_CAP_BYTES;
        const text = truncated ? raw.slice(raw.length - OUTPUT_CAP_BYTES) : raw;
        setOutput({ mode: "historical", text, totalBytes, truncated });
      } catch {
        setOutput({ mode: "historical", text: "", totalBytes: 0, truncated: false });
      }
    },
    [connection, connectionState],
  );

  // Subscribe to live output
  const subscribeLiveOutput = useCallback(
    (taskId: string) => {
      cleanupOutputSub();
      setOutput({ mode: "live", text: "", totalBytes: 0, truncated: false });

      const listener: OutputListener = {
        onChunk: (text: string) => {
          setOutput((prev) => {
            const combined = prev.text + text;
            const newTotalBytes = prev.totalBytes + new Blob([text]).size;
            if (combined.length > OUTPUT_CAP_BYTES) {
              // Rolling buffer: keep latest OUTPUT_CAP_BYTES
              const trimmed = combined.slice(combined.length - OUTPUT_CAP_BYTES);
              return {
                mode: "live",
                text: trimmed,
                totalBytes: newTotalBytes,
                truncated: true,
              };
            }
            return {
              mode: "live",
              text: combined,
              totalBytes: newTotalBytes,
              truncated: prev.truncated,
            };
          });
        },
        onEnded: (_reason) => {
          outputUnsubRef.current = null;
          // Transition to historical: fetch complete logs (O3)
          void fetchLogs(taskId);
        },
      };

      outputUnsubRef.current = connection.subscribeOutput(taskId, listener);
    },
    [connection, cleanupOutputSub, fetchLogs],
  );

  // Main effect: handle selection changes, status changes, reconnect
  useEffect(() => {
    const prevId = prevSelectedIdRef.current;
    const prevStatus = prevStatusRef.current;
    const prevConnState = prevConnectionStateRef.current;

    prevSelectedIdRef.current = selectedTaskId;
    prevStatusRef.current = summary?.status;
    prevConnectionStateRef.current = connectionState;

    // No selection
    if (!selectedTaskId) {
      cleanupOutputSub();
      setFullTask(null);
      setTaskNotFound(false);
      setOutput({ mode: "none", text: "", totalBytes: 0, truncated: false });
      return;
    }

    const selectionChanged = selectedTaskId !== prevId;
    const statusChanged = summary?.status !== prevStatus && prevStatus !== undefined;
    const reconnected =
      connectionState === "connected" &&
      prevConnState !== "connected" &&
      prevConnState !== undefined;

    // Task disappeared from summary map
    if (!summary && !selectionChanged) {
      setTaskNotFound(true);
      cleanupOutputSub();
      return;
    }

    // Fetch on selection, status change, or reconnect
    if (selectionChanged || statusChanged || reconnected) {
      cleanupOutputSub();
      void fetchTask(selectedTaskId);

      // Set up output based on running state
      if (summary && RUNNING_STATUSES.has(summary.status)) {
        subscribeLiveOutput(selectedTaskId);
      } else if (summary && connectionState === "connected") {
        // Non-running: decide what output to show
        if (NEVER_RUN_STATUSES.has(summary.status)) {
          setOutput({ mode: "none", text: "", totalBytes: 0, truncated: false });
        } else {
          void fetchLogs(selectedTaskId);
        }
      }
    }
  }, [
    selectedTaskId,
    summary?.status,
    connectionState,
    cleanupOutputSub,
    fetchTask,
    fetchLogs,
    subscribeLiveOutput,
    summary,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupOutputSub();
    };
  }, [cleanupOutputSub]);

  // ── Render ──────────────────────────────────────────────────────────────

  // Empty selection (L4, T23)
  if (!selectedTaskId) {
    return (
      <div data-testid="detail-empty" style={styles.emptyPanel}>
        Select a task to view details
      </div>
    );
  }

  // Tombstone: task not found (M2, T6, T7)
  if (taskNotFound) {
    return (
      <div data-testid="task-detail-panel" style={styles.panel}>
        <div data-testid="detail-tombstone" style={styles.tombstone}>
          <span style={styles.tombstoneIcon}>⊘</span>
          <span>Task <strong>{selectedTaskId}</strong> is no longer known to the kernel</span>
        </div>
      </div>
    );
  }

  // Loading state (before get-task responds)
  if (!fullTask) {
    return (
      <div data-testid="task-detail-panel" style={styles.panel}>
        <div style={styles.loading}>Loading...</div>
      </div>
    );
  }

  const isStale = connectionState !== "connected";
  const currentSummary = tasks.get(selectedTaskId);
  const taskIsRunning = currentSummary ? RUNNING_STATUSES.has(currentSummary.status) : false;
  const runHealth = currentSummary?.runHealth;

  return (
    <div
      data-testid="task-detail-panel"
      style={{ ...styles.panel, opacity: isStale ? 0.6 : 1 }}
    >
      {/* Header section */}
      <div style={styles.headerSection}>
        <div style={styles.headerRow}>
          <span data-testid="detail-task-id" style={styles.taskId}>
            {fullTask.id}
          </span>
          <span
            data-testid="detail-task-status"
            style={{
              ...styles.statusBadge,
              color: statusColor(fullTask.status),
            }}
          >
            {fullTask.status}
          </span>
        </div>
        <div
          data-testid="detail-task-title"
          style={styles.taskTitle}
        >
          {fullTask.title}
        </div>

        {/* Run-health indicator (R1, R2, R3) */}
        {taskIsRunning && runHealth && (
          <div
            data-testid="detail-run-health"
            style={{
              ...styles.runHealthBadge,
              color: runHealth === "quiet" ? "#f59e0b" : "#22c55e",
              borderColor: runHealth === "quiet" ? "#78350f" : "#14532d",
            }}
          >
            {runHealth === "quiet" ? "⏸ QUIET" : "● ACTIVE"}
          </div>
        )}
      </div>

      {/* Controls section (V1, V6: near task status, compact single row) */}
      {currentSummary && (
        <TaskControls
          taskId={selectedTaskId}
          taskStatus={currentSummary.status}
          connectionState={connectionState}
          connection={connection}
        />
      )}

      {/* Metadata section */}
      <div style={styles.metadataSection}>
        <MetadataRow label="Attempt" testId="detail-attempt" value={String(fullTask.current_attempt ?? 0)} />
        <MetadataRow label="Crashes" testId="detail-crash-count" value={String(fullTask.crash_count ?? 0)} />
        {fullTask.assigned_at && (
          <MetadataRow label="Assigned" value={formatTimestamp(fullTask.assigned_at)} />
        )}
        {fullTask.completed_at && (
          <MetadataRow label="Completed" value={formatTimestamp(fullTask.completed_at)} />
        )}
        {fullTask.cooldown_until && (
          <MetadataRow label="Cooldown until" value={formatTimestamp(fullTask.cooldown_until)} />
        )}
        {currentSummary?.transitionReason && (
          <MetadataRow label="Reason" value={currentSummary.transitionReason} />
        )}
      </div>

      {/* Output section */}
      <div style={styles.outputSection}>
        <OutputPanel
          output={output}
          fullTask={fullTask}
          summary={currentSummary ?? null}
          isStale={isStale}
        />
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function MetadataRow({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId?: string;
}) {
  return (
    <div style={styles.metadataRow}>
      <span style={styles.metadataLabel}>{label}</span>
      <span data-testid={testId} style={styles.metadataValue}>{value}</span>
    </div>
  );
}

function OutputPanel({
  output,
  fullTask,
  summary,
  isStale,
}: {
  output: OutputState;
  fullTask: Task;
  summary: TaskSummary | null;
  isStale: boolean;
}) {
  const isRunning = summary ? RUNNING_STATUSES.has(summary.status) : false;

  // Determine empty state message (O8)
  const emptyState = getEmptyStateMessage(output, fullTask, summary);

  return (
    <>
      {/* Mode indicator (O5, T12) */}
      {output.mode !== "none" && (
        <div
          data-testid="output-mode-indicator"
          style={{
            ...styles.modeIndicator,
            color: output.mode === "live" ? "#22c55e" : "#737373",
          }}
        >
          {output.mode === "live" ? "● LIVE" : "◆ HISTORICAL — latest run"}
        </div>
      )}

      {/* Stale indicator (D1, T20) */}
      {isStale && output.mode === "live" && (
        <div data-testid="output-stale-indicator" style={styles.outputStale}>
          Output may be incomplete — connection lost
        </div>
      )}

      {/* Truncation indicator (B2, T14, T15, T16) */}
      {output.truncated && (
        <div data-testid="truncation-indicator" style={styles.truncationBanner}>
          Output truncated — showing latest {Math.round(OUTPUT_CAP_BYTES / 1024)} KB
          {output.totalBytes > 0 && ` of ${Math.round(output.totalBytes / 1024)} KB total`}
        </div>
      )}

      {/* Output content or empty state */}
      {emptyState ? (
        <div data-testid="output-empty-state" style={styles.emptyOutput}>
          {emptyState}
        </div>
      ) : (
        <pre
          data-testid="output-panel"
          style={{
            ...styles.outputPre,
            fontFamily: MONO,
          }}
        >
          {output.text}
        </pre>
      )}
    </>
  );
}

function getEmptyStateMessage(
  output: OutputState,
  fullTask: Task,
  summary: TaskSummary | null,
): string | null {
  const isRunning = summary ? RUNNING_STATUSES.has(summary.status) : false;

  // Never run (pending/reserved)
  if (NEVER_RUN_STATUSES.has(fullTask.status) && output.mode === "none") {
    return "No output — task has not run yet";
  }

  // Running but no output yet
  if (isRunning && output.mode === "live" && output.text === "") {
    return "Waiting for output...";
  }

  // Historical mode with empty text
  if (output.mode === "historical" && output.text === "") {
    // Has run logs but empty output
    if (fullTask.current_attempt && fullTask.current_attempt > 0) {
      return "Output unavailable for this run";
    }
    return "No output recorded for this run";
  }

  // Non-running, non-pending, mode is none (shouldn't normally happen)
  if (output.mode === "none" && !NEVER_RUN_STATUSES.has(fullTask.status) && !isRunning) {
    return "Output unavailable for this run";
  }

  return null;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso;
  // Compact format for detail view
  const now = Date.now();
  const diff = now - date.getTime();
  if (diff < 0) return iso;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toISOString().replace("T", " ").slice(0, 19);
}

// ── Styles ────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column" as const,
    height: "100%",
    backgroundColor: "#0a0a0a",
    borderLeft: "1px solid #262626",
    overflow: "hidden",
  },
  emptyPanel: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    color: "#525252",
    fontFamily: MONO,
    fontSize: "12px",
    backgroundColor: "#0a0a0a",
    borderLeft: "1px solid #262626",
  },
  tombstone: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    padding: "24px",
    color: "#a3a3a3",
    fontFamily: SANS,
    fontSize: "12px",
    textAlign: "center" as const,
    flex: 1,
  },
  tombstoneIcon: {
    fontSize: "24px",
    color: "#525252",
  },
  loading: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    color: "#525252",
    fontFamily: MONO,
    fontSize: "12px",
  },
  headerSection: {
    padding: "12px 16px 8px",
    borderBottom: "1px solid #1a1a1a",
  },
  headerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
  },
  taskId: {
    fontFamily: MONO,
    fontSize: "13px",
    fontWeight: 600,
    color: "#e5e5e5",
  },
  statusBadge: {
    fontFamily: MONO,
    fontSize: "11px",
    fontWeight: 600,
    letterSpacing: "0.05em",
  },
  taskTitle: {
    fontFamily: SANS,
    fontSize: "12px",
    color: "#a3a3a3",
    marginTop: "4px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  runHealthBadge: {
    fontFamily: MONO,
    fontSize: "11px",
    fontWeight: 600,
    marginTop: "6px",
    padding: "2px 6px",
    borderRadius: "3px",
    border: "1px solid",
    display: "inline-block",
  },
  metadataSection: {
    padding: "8px 16px",
    borderBottom: "1px solid #1a1a1a",
    display: "flex",
    flexDirection: "column" as const,
    gap: "2px",
  },
  metadataRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    height: "20px",
  },
  metadataLabel: {
    fontFamily: MONO,
    fontSize: "10px",
    fontWeight: 600,
    color: "#525252",
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    width: "100px",
    flexShrink: 0,
  },
  metadataValue: {
    fontFamily: MONO,
    fontSize: "12px",
    color: "#d4d4d4",
  },
  outputSection: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
    minHeight: 0,
  },
  modeIndicator: {
    fontFamily: MONO,
    fontSize: "10px",
    fontWeight: 600,
    letterSpacing: "0.08em",
    padding: "4px 16px",
    borderBottom: "1px solid #1a1a1a",
  },
  outputStale: {
    fontFamily: MONO,
    fontSize: "11px",
    color: "#fbbf24",
    backgroundColor: "#451a03",
    padding: "4px 16px",
    borderBottom: "1px solid #78350f",
  },
  truncationBanner: {
    fontFamily: MONO,
    fontSize: "11px",
    color: "#f59e0b",
    backgroundColor: "#1c1917",
    padding: "4px 16px",
    borderBottom: "1px solid #292524",
  },
  emptyOutput: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    color: "#525252",
    fontFamily: MONO,
    fontSize: "12px",
    padding: "16px",
  },
  outputPre: {
    flex: 1,
    margin: 0,
    padding: "8px 16px",
    overflowY: "auto" as const,
    overflowX: "auto" as const,
    fontSize: "12px",
    color: "#d4d4d4",
    lineHeight: "1.5",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-all" as const,
    backgroundColor: "#0a0a0a",
  },
};
