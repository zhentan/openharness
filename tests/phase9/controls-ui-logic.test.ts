// Phase 9, Slice 8: Control UI logic tests (UT1-UT15)
// Written BEFORE implementation per reviewer acceptance criteria in
// docs/phase9/reviews/controls.md Section 8.
//
// Tests the pure control-state logic extracted from React components:
// - Button availability matrix (which controls show for which states)
// - Pending state management (non-optimistic flow)
// - Error feedback
// - Kill confirmation requirement

import { describe, expect, it } from "vitest";
import {
  getControlAvailability,
  createControlState,
  type ControlAvailability,
  type ControlPendingState,
} from "../../dashboard/src/lib/control-state.js";
import type { TaskStatus } from "../../dashboard/src/types.js";

// ── UT1-UT5: Control availability matrix ──────────────────────────────────

describe("Phase 9, Slice 8: control availability matrix", () => {
  // UT1: Pause enabled on running states only
  it("UT1: pause enabled on generator_running and evaluator_running", () => {
    const genRunning = getControlAvailability("generator_running", "connected");
    expect(genRunning.pause).toBe(true);

    const evalRunning = getControlAvailability("evaluator_running", "connected");
    expect(evalRunning.pause).toBe(true);
  });

  it("UT1b: pause disabled on non-running states", () => {
    const states: TaskStatus[] = [
      "pending", "reserved", "paused", "completed", "merged",
      "escalated", "retry_pending", "pre_eval", "revisions_requested", "merge_pending",
    ];
    for (const status of states) {
      const avail = getControlAvailability(status, "connected");
      expect(avail.pause, `pause should be disabled for ${status}`).toBe(false);
    }
  });

  // UT2: Resume enabled only on paused
  it("UT2: resume enabled only on paused", () => {
    const paused = getControlAvailability("paused", "connected");
    expect(paused.resume).toBe(true);

    const running = getControlAvailability("generator_running", "connected");
    expect(running.resume).toBe(false);

    const pending = getControlAvailability("pending", "connected");
    expect(pending.resume).toBe(false);
  });

  // UT3: Kill enabled on running states only
  it("UT3: kill enabled on generator_running and evaluator_running", () => {
    const genRunning = getControlAvailability("generator_running", "connected");
    expect(genRunning.kill).toBe(true);

    const evalRunning = getControlAvailability("evaluator_running", "connected");
    expect(evalRunning.kill).toBe(true);
  });

  it("UT3b: kill disabled on non-running states", () => {
    const states: TaskStatus[] = [
      "pending", "reserved", "paused", "completed", "merged",
      "escalated", "retry_pending",
    ];
    for (const status of states) {
      const avail = getControlAvailability(status, "connected");
      expect(avail.kill, `kill should be disabled for ${status}`).toBe(false);
    }
  });

  // UT4: All controls disabled when disconnected (C5)
  it("UT4: all controls disabled when disconnected", () => {
    const disconnected = getControlAvailability("generator_running", "disconnected");
    expect(disconnected.pause).toBe(false);
    expect(disconnected.resume).toBe(false);
    expect(disconnected.kill).toBe(false);
  });

  it("UT4b: all controls disabled when reconnecting", () => {
    const reconnecting = getControlAvailability("generator_running", "reconnecting");
    expect(reconnecting.pause).toBe(false);
    expect(reconnecting.resume).toBe(false);
    expect(reconnecting.kill).toBe(false);
  });

  it("UT4c: all controls disabled when connecting", () => {
    const connecting = getControlAvailability("generator_running", "connecting");
    expect(connecting.pause).toBe(false);
    expect(connecting.resume).toBe(false);
    expect(connecting.kill).toBe(false);
  });

  // UT5: No retry button ever (C6, FC2)
  it("UT5: no retry in availability", () => {
    const avail = getControlAvailability("retry_pending", "connected");
    expect(avail).not.toHaveProperty("retry");
  });

  // UT5b: Availability returns all false for null task (no task selected → controls not shown)
  it("UT5b: null status returns all disabled", () => {
    const avail = getControlAvailability(null, "connected");
    expect(avail.pause).toBe(false);
    expect(avail.resume).toBe(false);
    expect(avail.kill).toBe(false);
  });
});

// ── UT6-UT15: Control pending state management ───────────────────────────

describe("Phase 9, Slice 8: control pending state", () => {
  // UT6: Initial state has no pending controls
  it("UT6: initial state has no pending controls", () => {
    const state = createControlState();
    expect(state.getPending("task_1")).toBeNull();
  });

  // UT7: markPending sets pending state for a task+command
  it("UT7: markPending sets pending state", () => {
    const state = createControlState();
    state.markPending("task_1", "pause");
    const pending = state.getPending("task_1");
    expect(pending).not.toBeNull();
    expect(pending!.command).toBe("pause");
    expect(pending!.status).toBe("sending");
  });

  // UT8: markAcked transitions from sending to received
  it("UT8: markAcked transitions to received", () => {
    const state = createControlState();
    state.markPending("task_1", "pause");
    state.markAcked("task_1");
    const pending = state.getPending("task_1");
    expect(pending).not.toBeNull();
    expect(pending!.status).toBe("received");
  });

  // UT9: clearPending removes pending state (after delta arrives)
  it("UT9: clearPending removes pending state", () => {
    const state = createControlState();
    state.markPending("task_1", "pause");
    state.clearPending("task_1");
    expect(state.getPending("task_1")).toBeNull();
  });

  // UT10: markError sets error state with message
  it("UT10: markError sets error state", () => {
    const state = createControlState();
    state.markPending("task_1", "pause");
    state.markError("task_1", "Cannot pause: no running process");
    const pending = state.getPending("task_1");
    expect(pending).not.toBeNull();
    expect(pending!.status).toBe("error");
    expect(pending!.errorMessage).toBe("Cannot pause: no running process");
  });

  // UT11: Error state can be dismissed
  it("UT11: error can be dismissed via clearPending", () => {
    const state = createControlState();
    state.markPending("task_1", "pause");
    state.markError("task_1", "fail");
    state.clearPending("task_1");
    expect(state.getPending("task_1")).toBeNull();
  });

  // UT12: Pending state disables the relevant control (non-optimistic, C1)
  it("UT12: hasPending returns true while pending", () => {
    const state = createControlState();
    state.markPending("task_1", "pause");
    expect(state.hasPending("task_1")).toBe(true);
  });

  // UT13: Different tasks have independent pending state
  it("UT13: different tasks have independent pending state", () => {
    const state = createControlState();
    state.markPending("task_1", "pause");
    state.markPending("task_2", "kill");
    expect(state.getPending("task_1")!.command).toBe("pause");
    expect(state.getPending("task_2")!.command).toBe("kill");
    state.clearPending("task_1");
    expect(state.getPending("task_1")).toBeNull();
    expect(state.getPending("task_2")!.command).toBe("kill");
  });

  // UT14: clearAll clears all pending states (used on disconnect)
  it("UT14: clearAll clears all pending states", () => {
    const state = createControlState();
    state.markPending("task_1", "pause");
    state.markPending("task_2", "kill");
    state.clearAll();
    expect(state.getPending("task_1")).toBeNull();
    expect(state.getPending("task_2")).toBeNull();
  });

  // UT15: markPending on already-pending task replaces (deduplication)
  it("UT15: markPending on already-pending replaces previous", () => {
    const state = createControlState();
    state.markPending("task_1", "pause");
    state.markPending("task_1", "kill");
    expect(state.getPending("task_1")!.command).toBe("kill");
  });
});
