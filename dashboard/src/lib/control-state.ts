// Pure control-state logic for operator controls.
// No React imports — testable in Node.js directly.
//
// Two concerns:
// 1. Control availability matrix: which buttons are enabled for a given task status + connection state
// 2. Pending state management: tracks in-flight control requests (non-optimistic flow)

import type { TaskStatus } from "../types.js";
import type { ConnectionState } from "./connection.js";

// ── Control availability ──────────────────────────────────────────────────

export interface ControlAvailability {
  pause: boolean;
  resume: boolean;
  kill: boolean;
}

const RUNNING_STATUSES = new Set<TaskStatus>(["generator_running", "evaluator_running"]);

const ALL_DISABLED: ControlAvailability = { pause: false, resume: false, kill: false };

/**
 * Compute which controls are available for a task in a given status.
 * Returns all-disabled if disconnected or no task selected (null status).
 */
export function getControlAvailability(
  status: TaskStatus | null,
  connectionState: ConnectionState,
): ControlAvailability {
  if (connectionState !== "connected" || status === null) {
    return ALL_DISABLED;
  }

  return {
    pause: RUNNING_STATUSES.has(status),
    resume: status === "paused",
    kill: RUNNING_STATUSES.has(status),
  };
}

// ── Pending state management ──────────────────────────────────────────────

export type ControlCommand = "pause" | "resume" | "kill";

export type PendingStatus = "sending" | "received" | "error";

export interface ControlPendingState {
  command: ControlCommand;
  status: PendingStatus;
  errorMessage?: string;
}

export interface ControlStateManager {
  getPending(taskId: string): ControlPendingState | null;
  hasPending(taskId: string): boolean;
  markPending(taskId: string, command: ControlCommand): void;
  markAcked(taskId: string): void;
  markError(taskId: string, message: string): void;
  clearPending(taskId: string): void;
  clearAll(): void;
}

/**
 * Create a mutable pending-state container for control requests.
 * Used by the UI to track in-flight controls without optimistic updates.
 */
export function createControlState(): ControlStateManager {
  const pending = new Map<string, ControlPendingState>();

  return {
    getPending(taskId: string): ControlPendingState | null {
      return pending.get(taskId) ?? null;
    },

    hasPending(taskId: string): boolean {
      return pending.has(taskId);
    },

    markPending(taskId: string, command: ControlCommand): void {
      pending.set(taskId, { command, status: "sending" });
    },

    markAcked(taskId: string): void {
      const entry = pending.get(taskId);
      if (entry) {
        entry.status = "received";
      }
    },

    markError(taskId: string, message: string): void {
      const entry = pending.get(taskId);
      if (entry) {
        entry.status = "error";
        entry.errorMessage = message;
      }
    },

    clearPending(taskId: string): void {
      pending.delete(taskId);
    },

    clearAll(): void {
      pending.clear();
    },
  };
}
