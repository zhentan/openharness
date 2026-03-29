import type { TaskSummary, TaskStatus } from "../types.js";
import type { ConnectionState } from "../lib/connection.js";

export interface SummaryGridProps {
  tasks: ReadonlyMap<string, TaskSummary>;
  connectionState: ConnectionState;
  selectedTaskId?: string | null;
  onSelectTask?: (taskId: string | null) => void;
}

const MONO = "'Geist Mono', 'SF Mono', 'Consolas', monospace";
const SANS = "'Geist Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

const RUNNING_STATUSES = new Set<TaskStatus>(["generator_running", "evaluator_running"]);

// Status color mapping — calm for steady states, loud for exceptions (DC-2).
const STATUS_COLORS: Partial<Record<TaskStatus, string>> = {
  escalated: "#ef4444",
  paused: "#a78bfa",
  retry_pending: "#f59e0b",
};

const QUIET_COLOR = "#f59e0b";
const MUTED_STATUS_COLOR = "#737373";

function statusColor(status: TaskStatus, runHealth?: "active" | "quiet"): string {
  if (RUNNING_STATUSES.has(status) && runHealth === "quiet") return QUIET_COLOR;
  return STATUS_COLORS[status] ?? MUTED_STATUS_COLOR;
}

// Relative time formatter — compact, scannable (DC-3, T10).
function formatRelativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return iso;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function SummaryGrid({ tasks, connectionState, selectedTaskId, onSelectTask }: SummaryGridProps) {
  const isStale = connectionState !== "connected";

  // I-SORT: Sort by taskId, matching server-side sortSummaries.
  const sorted = Array.from(tasks.values()).sort((a, b) => a.taskId.localeCompare(b.taskId));

  return (
    <div
      data-testid="summary-grid"
      style={{
        ...styles.grid,
        opacity: isStale ? 0.5 : 1,
      }}
    >
      {isStale && (
        <div data-testid="stale-indicator" style={styles.staleBanner}>
          Data may be stale — {connectionState}
        </div>
      )}
      {sorted.length === 0 ? (
        <div style={styles.empty}>No tasks</div>
      ) : (
        <>
          <div style={styles.headerRow}>
            <span style={{ ...styles.colId, ...styles.headerCell }}>ID</span>
            <span style={{ ...styles.colTitle, ...styles.headerCell }}>TITLE</span>
            <span style={{ ...styles.colStatus, ...styles.headerCell }}>STATUS</span>
            <span style={{ ...styles.colHealth, ...styles.headerCell }}>HEALTH</span>
            <span style={{ ...styles.colTime, ...styles.headerCell }}>UPDATED</span>
            <span style={{ ...styles.colReason, ...styles.headerCell }}>REASON</span>
          </div>
          {sorted.map((task) => (
            <TaskRow
              key={task.taskId}
              task={task}
              isSelected={task.taskId === selectedTaskId}
              onSelect={onSelectTask}
            />
          ))}
        </>
      )}
    </div>
  );
}

function TaskRow({
  task,
  isSelected,
  onSelect,
}: {
  task: TaskSummary;
  isSelected: boolean;
  onSelect?: (taskId: string | null) => void;
}) {
  const isRunning = RUNNING_STATUSES.has(task.status);
  const color = statusColor(task.status, task.runHealth);

  return (
    <div
      data-testid="task-row"
      data-status={task.status}
      data-run-health={isRunning ? (task.runHealth ?? "active") : undefined}
      style={{
        ...styles.row,
        backgroundColor: isSelected ? "#1a1a1a" : "transparent",
        cursor: onSelect ? "pointer" : undefined,
      }}
      onClick={() => onSelect?.(isSelected ? null : task.taskId)}
    >
      <span
        data-testid="task-id"
        style={{ ...styles.colId, ...styles.cellMono }}
      >
        {task.taskId}
      </span>
      <span
        data-testid="task-title"
        style={{
          ...styles.colTitle,
          ...styles.cellSans,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {task.title}
      </span>
      <span
        data-testid="task-status"
        style={{
          ...styles.colStatus,
          ...styles.cellMono,
          color,
          fontWeight: color !== MUTED_STATUS_COLOR ? 600 : 400,
        }}
      >
        {task.status}
      </span>
      <span
        style={{ ...styles.colHealth, ...styles.cellMono }}
      >
        {isRunning && task.runHealth && (
          <span
            data-testid="run-health-indicator"
            style={{
              color: task.runHealth === "quiet" ? QUIET_COLOR : "#22c55e",
              fontWeight: task.runHealth === "quiet" ? 600 : 400,
            }}
          >
            {task.runHealth === "quiet" ? "QUIET" : "active"}
          </span>
        )}
      </span>
      <span
        data-testid="updated-at"
        style={{ ...styles.colTime, ...styles.cellMono }}
      >
        {formatRelativeTime(task.updatedAt)}
      </span>
      <span
        data-testid="transition-reason"
        style={{ ...styles.colReason, ...styles.cellMono, color: "#a3a3a3" }}
      >
        {task.transitionReason ?? ""}
      </span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  grid: {
    flex: 1,
    overflowY: "auto",
    padding: 0,
    margin: 0,
  },
  staleBanner: {
    padding: "4px 16px",
    backgroundColor: "#451a03",
    color: "#fbbf24",
    fontFamily: MONO,
    fontSize: "11px",
    textAlign: "center",
    borderBottom: "1px solid #78350f",
  },
  empty: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "200px",
    color: "#525252",
    fontFamily: MONO,
    fontSize: "13px",
  },
  headerRow: {
    display: "flex",
    alignItems: "center",
    padding: "4px 16px",
    borderBottom: "1px solid #262626",
    backgroundColor: "#0f0f0f",
    position: "sticky" as const,
    top: 0,
    zIndex: 1,
  },
  headerCell: {
    fontFamily: MONO,
    fontSize: "10px",
    fontWeight: 600,
    color: "#525252",
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
  },
  row: {
    display: "flex",
    alignItems: "center",
    padding: "0 16px",
    height: "32px",
    borderBottom: "1px solid #1a1a1a",
  },
  colId: {
    width: "160px",
    flexShrink: 0,
    minWidth: 0,
  },
  colTitle: {
    flex: 1,
    minWidth: 0,
  },
  colStatus: {
    width: "140px",
    flexShrink: 0,
  },
  colHealth: {
    width: "64px",
    flexShrink: 0,
  },
  colTime: {
    width: "64px",
    flexShrink: 0,
    textAlign: "right" as const,
  },
  colReason: {
    width: "180px",
    flexShrink: 0,
    marginLeft: "8px",
  },
  cellMono: {
    fontFamily: MONO,
    fontSize: "12px",
    color: "#d4d4d4",
  },
  cellSans: {
    fontFamily: SANS,
    fontSize: "12px",
    color: "#e5e5e5",
  },
};
