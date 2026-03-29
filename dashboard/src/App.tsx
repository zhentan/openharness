import { useEffect, useRef, useState, useCallback } from "react";
import {
  createKernelConnection,
  type ConnectionState,
  type KernelConnection,
  type TaskSummary,
} from "./lib/connection.js";
import { SummaryGrid } from "./components/SummaryGrid.js";
import { TaskDetail } from "./components/TaskDetail.js";

const STATUS_COLORS: Record<ConnectionState, string> = {
  disconnected: "#dc2626",
  connecting: "#d97706",
  connected: "#16a34a",
  reconnecting: "#d97706",
};

const STATUS_LABELS: Record<ConnectionState, string> = {
  disconnected: "DISCONNECTED",
  connecting: "CONNECTING",
  connected: "CONNECTED",
  reconnecting: "RECONNECTING",
};

export function App() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [tasks, setTasks] = useState<Map<string, TaskSummary>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const connRef = useRef<KernelConnection | null>(null);

  const handleSelectTask = useCallback((taskId: string | null) => {
    setSelectedTaskId(taskId);
  }, []);

  useEffect(() => {
    const bootstrapUrl = `${window.location.origin}/_api/bootstrap`;

    const conn = createKernelConnection(
      { bootstrapUrl },
      {
        onStateChange: setConnectionState,
        onTasksUpdated: (updated) => setTasks(new Map(updated)),
        onError: setError,
      },
      { fetch: window.fetch.bind(window), WebSocket },
    );

    connRef.current = conn;
    conn.connect();

    return () => {
      conn.disconnect();
      connRef.current = null;
    };
  }, []);

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <span style={styles.title}>OpenHarness</span>
        <div style={styles.statusStrip}>
          <span
            style={{
              ...styles.statusDot,
              backgroundColor: STATUS_COLORS[connectionState],
            }}
          />
          <span style={styles.statusLabel}>
            {STATUS_LABELS[connectionState]}
          </span>
          {connectionState === "connected" && (
            <span style={styles.taskCount}>
              {tasks.size} {tasks.size === 1 ? "task" : "tasks"}
            </span>
          )}
        </div>
      </header>
      {error && (
        <div style={styles.errorBanner}>
          {error}
        </div>
      )}
      <div style={styles.mainArea}>
        <div style={selectedTaskId ? styles.summaryPaneWithDetail : styles.summaryPaneFull}>
          <SummaryGrid
            tasks={tasks}
            connectionState={connectionState}
            selectedTaskId={selectedTaskId}
            onSelectTask={handleSelectTask}
          />
        </div>
        {selectedTaskId && connRef.current && (
          <div style={styles.detailPane}>
            <TaskDetail
              selectedTaskId={selectedTaskId}
              tasks={tasks}
              connectionState={connectionState}
              connection={connRef.current}
            />
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    fontFamily: "'Geist Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    backgroundColor: "#0a0a0a",
    color: "#e5e5e5",
    height: "100vh",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 16px",
    borderBottom: "1px solid #262626",
    backgroundColor: "#0f0f0f",
  },
  title: {
    fontFamily: "'Geist Mono', 'SF Mono', 'Consolas', monospace",
    fontSize: "13px",
    fontWeight: 600,
    color: "#a3a3a3",
    letterSpacing: "0.05em",
    textTransform: "uppercase" as const,
  },
  statusStrip: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  statusDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    flexShrink: 0,
  },
  statusLabel: {
    fontFamily: "'Geist Mono', 'SF Mono', 'Consolas', monospace",
    fontSize: "11px",
    fontWeight: 500,
    letterSpacing: "0.05em",
  },
  taskCount: {
    fontFamily: "'Geist Mono', 'SF Mono', 'Consolas', monospace",
    fontSize: "11px",
    color: "#737373",
    marginLeft: "8px",
  },
  errorBanner: {
    padding: "6px 16px",
    backgroundColor: "#451a03",
    color: "#fbbf24",
    fontFamily: "'Geist Mono', 'SF Mono', 'Consolas', monospace",
    fontSize: "12px",
    borderBottom: "1px solid #78350f",
  },
  mainArea: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
    minHeight: 0,
  },
  summaryPaneFull: {
    flex: 1,
    overflow: "hidden",
  },
  summaryPaneWithDetail: {
    flex: "0 0 60%",
    overflow: "hidden",
  },
  detailPane: {
    flex: "0 0 40%",
    overflow: "hidden",
  },
};
