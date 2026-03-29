// Operator controls for the selected task in the detail pane.
// Non-optimistic: task status only changes via delta stream (C1, C2).
// Kill requires confirmation (C3). All disabled when disconnected (C5).
// No retry button (C6).

import { useState, useCallback, useEffect, useRef } from "react";
import type { TaskStatus } from "../types.js";
import type { ConnectionState, KernelConnection, ControlResult } from "../lib/connection.js";
import {
  getControlAvailability,
  type ControlCommand,
  type ControlPendingState,
} from "../lib/control-state.js";

const MONO = "'Geist Mono', 'SF Mono', 'Consolas', monospace";

export interface TaskControlsProps {
  taskId: string;
  taskStatus: TaskStatus;
  connectionState: ConnectionState;
  connection: KernelConnection;
}

interface PendingMap {
  [taskId: string]: ControlPendingState | undefined;
}

export function TaskControls({
  taskId,
  taskStatus,
  connectionState,
  connection,
}: TaskControlsProps) {
  const [pendingMap, setPendingMap] = useState<PendingMap>({});
  const [killConfirm, setKillConfirm] = useState<string | null>(null);
  const previousStatusRef = useRef<TaskStatus>(taskStatus);

  const pending = pendingMap[taskId] ?? null;
  const availability = getControlAvailability(taskStatus, connectionState);

  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = taskStatus;

    if (previousStatus === taskStatus) {
      return;
    }

    setPendingMap((prev: PendingMap) => {
      const currentPending = prev[taskId];
      if (!currentPending || currentPending.status === "error") {
        return prev;
      }
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  }, [taskId, taskStatus]);

  const sendControl = useCallback(
    async (command: ControlCommand) => {
      // Mark as sending
      setPendingMap((prev: PendingMap) => ({
        ...prev,
        [taskId]: { command, status: "sending" as const },
      }));

      let result: ControlResult;
      try {
        if (command === "pause") {
          result = await connection.pauseTask(taskId);
        } else if (command === "resume") {
          result = await connection.resumeTask(taskId);
        } else {
          result = await connection.killTask(taskId);
        }
      } catch {
        result = { ok: false, error: "Unexpected error" };
      }

      if (result.ok) {
        // Mark as received — will be cleared when delta arrives (status changes)
        setPendingMap((prev: PendingMap) => ({
          ...prev,
          [taskId]: { command, status: "received" as const },
        }));
      } else {
        // Show error
        setPendingMap((prev: PendingMap) => ({
          ...prev,
          [taskId]: {
            command,
            status: "error" as const,
            errorMessage: result.error,
          },
        }));
      }
    },
    [taskId, connection],
  );

  const handlePause = useCallback(() => {
    void sendControl("pause");
  }, [sendControl]);

  const handleResume = useCallback(() => {
    void sendControl("resume");
  }, [sendControl]);

  const handleKillClick = useCallback(() => {
    setKillConfirm(taskId);
  }, [taskId]);

  const handleKillConfirm = useCallback(() => {
    setKillConfirm(null);
    void sendControl("kill");
  }, [sendControl]);

  const handleKillCancel = useCallback(() => {
    setKillConfirm(null);
  }, []);

  const dismissError = useCallback(() => {
    setPendingMap((prev: PendingMap) => {
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  }, [taskId]);

  const isPending = pending !== null && (pending.status === "sending" || pending.status === "received");
  const isError = pending !== null && pending.status === "error";
  const showKillConfirm = killConfirm === taskId;

  return (
    <div data-testid="task-controls" style={styles.controlRow}>
      {/* Control buttons */}
      <div style={styles.buttonGroup}>
        {/* Pause button */}
        <button
          data-testid="control-pause"
          onClick={handlePause}
          disabled={!availability.pause || isPending}
          style={{
            ...styles.controlButton,
            ...(availability.pause && !isPending ? styles.controlButtonEnabled : styles.controlButtonDisabled),
          }}
          title={
            connectionState !== "connected" ? "Disconnected"
              : !availability.pause ? `Cannot pause in ${taskStatus} state`
                : isPending ? `${pending!.command} pending...`
                  : "Pause this task"
          }
        >
          ⏸ Pause
        </button>

        {/* Resume button */}
        <button
          data-testid="control-resume"
          onClick={handleResume}
          disabled={!availability.resume || isPending}
          style={{
            ...styles.controlButton,
            ...(availability.resume && !isPending ? styles.controlButtonEnabled : styles.controlButtonDisabled),
          }}
          title={
            connectionState !== "connected" ? "Disconnected"
              : !availability.resume ? `Cannot resume in ${taskStatus} state`
                : isPending ? `${pending!.command} pending...`
                  : "Resume this task"
          }
        >
          ▶ Resume
        </button>

        {/* Kill button — visually distinct (V2) */}
        {!showKillConfirm ? (
          <button
            data-testid="control-kill"
            onClick={handleKillClick}
            disabled={!availability.kill || isPending}
            style={{
              ...styles.controlButton,
              ...(availability.kill && !isPending ? styles.killButtonEnabled : styles.killButtonDisabled),
            }}
            title={
              connectionState !== "connected" ? "Disconnected"
                : !availability.kill ? `Cannot kill in ${taskStatus} state`
                  : isPending ? `${pending!.command} pending...`
                    : "Kill this task"
            }
          >
            ✕ Kill
          </button>
        ) : (
          /* Kill confirmation (C3) */
          <span data-testid="kill-confirm" style={styles.killConfirmGroup}>
            <span style={styles.killConfirmLabel}>Kill?</span>
            <button
              data-testid="kill-confirm-yes"
              onClick={handleKillConfirm}
              style={styles.killConfirmYes}
            >
              Yes
            </button>
            <button
              data-testid="kill-confirm-no"
              onClick={handleKillCancel}
              style={styles.killConfirmNo}
            >
              No
            </button>
          </span>
        )}
      </div>

      {/* Pending indicator (non-optimistic: shows request state, NOT task state) */}
      {isPending && (
        <span data-testid="control-pending" style={styles.pendingIndicator}>
          {pending!.status === "sending" ? "Sending..." : "Received — waiting for status change"}
        </span>
      )}

      {/* Error feedback (local, specific — C8) */}
      {isError && (
        <span data-testid="control-error" style={styles.errorIndicator}>
          <span>{pending!.errorMessage}</span>
          <button
            data-testid="control-error-dismiss"
            onClick={dismissError}
            style={styles.dismissButton}
          >
            ✕
          </button>
        </span>
      )}
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  controlRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 16px",
    borderBottom: "1px solid #1a1a1a",
    flexWrap: "wrap" as const,
    minHeight: "32px",
  },
  buttonGroup: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
  controlButton: {
    fontFamily: MONO,
    fontSize: "11px",
    fontWeight: 600,
    padding: "3px 8px",
    borderRadius: "3px",
    border: "1px solid",
    cursor: "pointer",
    lineHeight: "1.4",
    letterSpacing: "0.02em",
    transition: "none",
  },
  controlButtonEnabled: {
    color: "#d4d4d4",
    backgroundColor: "#1a1a1a",
    borderColor: "#404040",
  },
  controlButtonDisabled: {
    color: "#525252",
    backgroundColor: "#0f0f0f",
    borderColor: "#262626",
    cursor: "default",
  },
  killButtonEnabled: {
    color: "#fca5a5",
    backgroundColor: "#1c0a0a",
    borderColor: "#7f1d1d",
  },
  killButtonDisabled: {
    color: "#525252",
    backgroundColor: "#0f0f0f",
    borderColor: "#262626",
    cursor: "default",
  },
  killConfirmGroup: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
  killConfirmLabel: {
    fontFamily: MONO,
    fontSize: "11px",
    fontWeight: 600,
    color: "#fca5a5",
  },
  killConfirmYes: {
    fontFamily: MONO,
    fontSize: "11px",
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: "3px",
    border: "1px solid #7f1d1d",
    backgroundColor: "#450a0a",
    color: "#fca5a5",
    cursor: "pointer",
  },
  killConfirmNo: {
    fontFamily: MONO,
    fontSize: "11px",
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: "3px",
    border: "1px solid #404040",
    backgroundColor: "#1a1a1a",
    color: "#d4d4d4",
    cursor: "pointer",
  },
  pendingIndicator: {
    fontFamily: MONO,
    fontSize: "10px",
    color: "#a78bfa",
    letterSpacing: "0.02em",
  },
  errorIndicator: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontFamily: MONO,
    fontSize: "10px",
    color: "#fca5a5",
    letterSpacing: "0.02em",
  },
  dismissButton: {
    fontFamily: MONO,
    fontSize: "10px",
    color: "#737373",
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "0 2px",
  },
};
