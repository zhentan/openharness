import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render, screen, within, fireEvent, act } from "@testing-library/react";
import { TaskDetail } from "./TaskDetail.js";
import type { TaskSummary, TaskStatus, Task } from "../types.js";
import type { ConnectionState, KernelConnection, TaskDetailResult, LogsResult, OutputListener } from "../lib/connection.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSummary(overrides: Partial<TaskSummary> & { taskId: string }): TaskSummary {
  return {
    title: `Task ${overrides.taskId}`,
    status: "pending" as TaskStatus,
    updatedAt: "2026-03-28T12:00:00.000Z",
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    status: "pending" as TaskStatus,
    priority: "medium",
    depends_on: [],
    agent_prompt: "do the thing",
    exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 60 },
    escalation_rules: [],
    ...overrides,
  };
}

function makeTaskMap(summaries: TaskSummary[]): ReadonlyMap<string, TaskSummary> {
  return new Map(summaries.map((s) => [s.taskId, s]));
}

/**
 * Creates a mock KernelConnection with controllable getTask, getLogs, and
 * subscribeOutput behaviors.
 */
function createMockConnection(overrides?: {
  state?: ConnectionState;
  getTaskResult?: TaskDetailResult;
  getLogsResult?: LogsResult;
}): KernelConnection & {
  getTask: Mock;
  getLogs: Mock;
  subscribeOutput: Mock;
  _capturedOutputListener: OutputListener | null;
  _unsubscribeFn: Mock;
} {
  let capturedListener: OutputListener | null = null;
  const unsubscribeFn = vi.fn();

  const conn = {
    state: overrides?.state ?? ("connected" as ConnectionState),
    tasks: new Map<string, TaskSummary>(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    getTask: vi.fn().mockResolvedValue(
      overrides?.getTaskResult ?? { task: null },
    ),
    getLogs: vi.fn().mockResolvedValue(
      overrides?.getLogsResult ?? { runLogs: [], output: "" },
    ),
    subscribeOutput: vi.fn((taskId: string, listener: OutputListener) => {
      capturedListener = listener;
      return unsubscribeFn;
    }),
    pauseTask: vi.fn().mockResolvedValue({ ok: true }),
    resumeTask: vi.fn().mockResolvedValue({ ok: true }),
    killTask: vi.fn().mockResolvedValue({ ok: true }),
    get _capturedOutputListener() { return capturedListener; },
    _unsubscribeFn: unsubscribeFn,
  };
  return conn;
}

const CONNECTED: ConnectionState = "connected";
const DISCONNECTED: ConnectionState = "disconnected";
const RECONNECTING: ConnectionState = "reconnecting";

// ── T1: Selecting a task populates detail pane ──────────────────────────────

describe("T1: Selecting a task populates detail pane", () => {
  it("renders task id, title, status, and transition reason from full task", async () => {
    const task = makeTask({
      id: "alpha",
      title: "Alpha Task",
      status: "escalated",
      current_attempt: 3,
      crash_count: 1,
    });
    const conn = createMockConnection({ getTaskResult: { task } });
    const summary = makeSummary({
      taskId: "alpha",
      title: "Alpha Task",
      status: "escalated",
      transitionReason: "timed_out",
    });
    const tasks = makeTaskMap([summary]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    expect(screen.getByTestId("detail-task-id")).toHaveTextContent("alpha");
    expect(screen.getByTestId("detail-task-title")).toHaveTextContent("Alpha Task");
    expect(screen.getByTestId("detail-task-status")).toHaveTextContent("escalated");
    expect(conn.getTask).toHaveBeenCalledWith("alpha");
  });
});

// ── T2: Selection persists across delta updates ─────────────────────────────

describe("T2: Selection persists across delta updates", () => {
  it("updates content but keeps selectedTaskId when delta changes selected task status", async () => {
    const task = makeTask({ id: "alpha", status: "generator_running" });
    const updatedTask = makeTask({ id: "alpha", status: "completed" });
    const conn = createMockConnection({ getTaskResult: { task } });

    const summary = makeSummary({ taskId: "alpha", status: "generator_running" });
    const tasks = makeTaskMap([summary]);

    const { rerender } = await act(async () =>
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      ),
    );

    // Delta arrives — status changes
    conn.getTask.mockResolvedValue({ task: updatedTask });
    const updatedTasks = makeTaskMap([
      makeSummary({ taskId: "alpha", status: "completed" }),
    ]);

    await act(async () => {
      rerender(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={updatedTasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    // Selection still shows alpha
    expect(screen.getByTestId("detail-task-id")).toHaveTextContent("alpha");
    // Re-fetched on status change
    expect(conn.getTask).toHaveBeenCalledTimes(2);
  });
});

// ── T3: Selection persists across snapshot replacement ──────────────────────

describe("T3: Selection persists across snapshot replacement", () => {
  it("preserves selection when fresh snapshot includes the selected task", async () => {
    const task = makeTask({ id: "alpha", status: "pending" });
    const conn = createMockConnection({ getTaskResult: { task } });

    const tasks = makeTaskMap([
      makeSummary({ taskId: "alpha", status: "pending" }),
      makeSummary({ taskId: "bravo" }),
    ]);

    const { rerender } = await act(async () =>
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      ),
    );

    // Fresh snapshot (e.g., after reconnect) — alpha is still there
    const snapshotTasks = makeTaskMap([
      makeSummary({ taskId: "alpha", status: "completed" }),
      makeSummary({ taskId: "charlie" }),
    ]);

    conn.getTask.mockResolvedValue({ task: makeTask({ id: "alpha", status: "completed" }) });

    await act(async () => {
      rerender(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={snapshotTasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    expect(screen.getByTestId("detail-task-id")).toHaveTextContent("alpha");
  });
});

// ── T4: Selecting a different task replaces detail content ──────────────────

describe("T4: Selecting a different task replaces detail content", () => {
  it("shows task B data when switching from task A to task B", async () => {
    const taskA = makeTask({ id: "alpha", title: "Alpha" });
    const taskB = makeTask({ id: "bravo", title: "Bravo" });
    const conn = createMockConnection({ getTaskResult: { task: taskA } });

    const tasks = makeTaskMap([
      makeSummary({ taskId: "alpha", title: "Alpha" }),
      makeSummary({ taskId: "bravo", title: "Bravo" }),
    ]);

    const { rerender } = await act(async () =>
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      ),
    );

    expect(screen.getByTestId("detail-task-title")).toHaveTextContent("Alpha");

    conn.getTask.mockResolvedValue({ task: taskB });

    await act(async () => {
      rerender(
        <TaskDetail
          selectedTaskId="bravo"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    expect(screen.getByTestId("detail-task-title")).toHaveTextContent("Bravo");
  });
});

// ── T5: Deselection clears detail pane ──────────────────────────────────────

describe("T5: Deselection clears detail pane", () => {
  it("shows empty state when selectedTaskId becomes null", async () => {
    const task = makeTask({ id: "alpha" });
    const conn = createMockConnection({ getTaskResult: { task } });
    const tasks = makeTaskMap([makeSummary({ taskId: "alpha" })]);

    const { rerender } = await act(async () =>
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      ),
    );

    await act(async () => {
      rerender(
        <TaskDetail
          selectedTaskId={null}
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    expect(screen.queryByTestId("detail-task-id")).not.toBeInTheDocument();
    expect(screen.getByTestId("detail-empty")).toBeInTheDocument();
  });
});

// ── T6: Selected task disappears from snapshot ──────────────────────────────

describe("T6: Selected task disappears from snapshot", () => {
  it("shows tombstone when selected task is no longer in tasks map", async () => {
    const task = makeTask({ id: "alpha" });
    const conn = createMockConnection({ getTaskResult: { task } });
    const tasks = makeTaskMap([makeSummary({ taskId: "alpha" })]);

    const { rerender } = await act(async () =>
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      ),
    );

    // Task disappears from snapshot
    const emptyTasks = makeTaskMap([]);
    conn.getTask.mockResolvedValue({ task: null });

    await act(async () => {
      rerender(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={emptyTasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    expect(screen.getByTestId("detail-tombstone")).toBeInTheDocument();
    expect(screen.getByTestId("detail-tombstone")).toHaveTextContent("alpha");
  });
});

// ── T7: get-task returns null ───────────────────────────────────────────────

describe("T7: get-task returns null for selected task", () => {
  it("shows task-not-found state", async () => {
    const conn = createMockConnection({ getTaskResult: { task: null } });
    const tasks = makeTaskMap([makeSummary({ taskId: "alpha" })]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    expect(screen.getByTestId("detail-tombstone")).toBeInTheDocument();
  });
});

// ── T8: Missing task does not trigger polling ───────────────────────────────

describe("T8: Missing task does not trigger polling", () => {
  it("does not re-fetch get-task after receiving null", async () => {
    const conn = createMockConnection({ getTaskResult: { task: null } });
    const tasks = makeTaskMap([makeSummary({ taskId: "alpha" })]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    // Wait a tick to ensure no additional calls
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(conn.getTask).toHaveBeenCalledTimes(1);
  });
});

// ── T9: Running task shows live output ──────────────────────────────────────

describe("T9: Running task shows live output", () => {
  it("subscribes to output and displays incoming chunks", async () => {
    const task = makeTask({ id: "alpha", status: "generator_running" });
    const conn = createMockConnection({ getTaskResult: { task } });
    const tasks = makeTaskMap([
      makeSummary({ taskId: "alpha", status: "generator_running", runHealth: "active" }),
    ]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    expect(conn.subscribeOutput).toHaveBeenCalledWith("alpha", expect.any(Object));

    // Deliver a chunk
    await act(async () => {
      conn._capturedOutputListener?.onChunk("Hello world\n");
    });

    expect(screen.getByTestId("output-panel")).toHaveTextContent("Hello world");

    // Verify live indicator
    expect(screen.getByTestId("output-mode-indicator")).toHaveTextContent(/live/i);
  });
});

// ── T10: Non-running task shows historical output ───────────────────────────

describe("T10: Non-running task shows historical output", () => {
  it("calls get-logs and displays the latest run output", async () => {
    const task = makeTask({ id: "alpha", status: "completed" });
    const conn = createMockConnection({
      getTaskResult: { task },
      getLogsResult: { runLogs: [{ runId: "run1", path: "/logs/run1" }], output: "Final output\n" },
    });
    const tasks = makeTaskMap([
      makeSummary({ taskId: "alpha", status: "completed" }),
    ]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    expect(conn.getLogs).toHaveBeenCalledWith("alpha");
    expect(conn.subscribeOutput).not.toHaveBeenCalled();
    expect(screen.getByTestId("output-panel")).toHaveTextContent("Final output");
    expect(screen.getByTestId("output-mode-indicator")).toHaveTextContent(/historical|latest run/i);
  });
});

// ── T11: Live-to-historical transition on output-ended ──────────────────────

describe("T11: Live-to-historical transition on output-ended", () => {
  it("fetches get-logs and replaces live view with historical on output-ended", async () => {
    const task = makeTask({ id: "alpha", status: "generator_running" });
    const conn = createMockConnection({ getTaskResult: { task } });
    conn.getLogs.mockResolvedValue({ runLogs: [{ runId: "run1", path: "/p" }], output: "Complete log\n" });

    const tasks = makeTaskMap([
      makeSummary({ taskId: "alpha", status: "generator_running", runHealth: "active" }),
    ]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    // Deliver some live output
    await act(async () => {
      conn._capturedOutputListener?.onChunk("partial output");
    });

    expect(screen.getByTestId("output-mode-indicator")).toHaveTextContent(/live/i);

    // output-ended arrives
    await act(async () => {
      conn._capturedOutputListener?.onEnded("completed");
    });

    // Should have fetched logs
    expect(conn.getLogs).toHaveBeenCalledWith("alpha");
    // Should now show historical
    expect(screen.getByTestId("output-mode-indicator")).toHaveTextContent(/historical|latest run/i);
    expect(screen.getByTestId("output-panel")).toHaveTextContent("Complete log");
  });
});

// ── T12: Live and historical output are visually distinct ───────────────────

describe("T12: Live and historical output are visually distinct", () => {
  it("shows 'live' indicator for running task and 'historical' for completed", async () => {
    // Running task — live
    const runningTask = makeTask({ id: "alpha", status: "generator_running" });
    const conn = createMockConnection({ getTaskResult: { task: runningTask } });
    const tasks = makeTaskMap([
      makeSummary({ taskId: "alpha", status: "generator_running", runHealth: "active" }),
    ]);

    const { rerender, unmount } = await act(async () =>
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      ),
    );

    expect(screen.getByTestId("output-mode-indicator")).toHaveTextContent(/live/i);

    unmount();

    // Completed task — historical
    const completedTask = makeTask({ id: "beta", status: "completed" });
    const conn2 = createMockConnection({
      getTaskResult: { task: completedTask },
      getLogsResult: { runLogs: [], output: "done" },
    });
    const tasks2 = makeTaskMap([
      makeSummary({ taskId: "beta", status: "completed" }),
    ]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="beta"
          tasks={tasks2}
          connectionState={CONNECTED}
          connection={conn2}
        />,
      );
    });

    expect(screen.getByTestId("output-mode-indicator")).toHaveTextContent(/historical|latest run/i);
  });
});

// ── T13: Empty output states render distinct messages ───────────────────────

describe("T13: Empty output states render distinct messages", () => {
  it("shows 'has not run yet' for pending task", async () => {
    const task = makeTask({ id: "alpha", status: "pending" });
    const conn = createMockConnection({ getTaskResult: { task } });
    const tasks = makeTaskMap([makeSummary({ taskId: "alpha", status: "pending" })]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    expect(screen.getByTestId("output-empty-state")).toHaveTextContent(/has not run/i);
  });

  it("shows 'no output recorded' for completed task with empty output", async () => {
    const task = makeTask({ id: "alpha", status: "completed" });
    const conn = createMockConnection({
      getTaskResult: { task },
      getLogsResult: { runLogs: [{ runId: "r1", path: "/p" }], output: "" },
    });
    const tasks = makeTaskMap([makeSummary({ taskId: "alpha", status: "completed" })]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    expect(screen.getByTestId("output-empty-state")).toHaveTextContent(/no output recorded/i);
  });

  it("shows 'waiting for output' for running task with no chunks yet", async () => {
    const task = makeTask({ id: "alpha", status: "generator_running" });
    const conn = createMockConnection({ getTaskResult: { task } });
    const tasks = makeTaskMap([
      makeSummary({ taskId: "alpha", status: "generator_running", runHealth: "active" }),
    ]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    expect(screen.getByTestId("output-empty-state")).toHaveTextContent(/waiting for output/i);
  });

  it("shows 'output unavailable' when get-logs returns empty for a task that ran", async () => {
    const task = makeTask({ id: "alpha", status: "completed", current_attempt: 1 });
    const conn = createMockConnection({
      getTaskResult: { task },
      getLogsResult: { runLogs: [], output: "" },
    });
    const tasks = makeTaskMap([makeSummary({ taskId: "alpha", status: "completed" })]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    expect(screen.getByTestId("output-empty-state")).toHaveTextContent(/output unavailable/i);
  });
});

// ── T14: Historical output exceeding cap is truncated ───────────────────────

describe("T14: Historical output exceeding cap is truncated with indicator", () => {
  it("truncates large output and shows truncation indicator", async () => {
    const largeOutput = "X".repeat(300 * 1024); // 300 KB > 256 KB cap
    const task = makeTask({ id: "alpha", status: "completed" });
    const conn = createMockConnection({
      getTaskResult: { task },
      getLogsResult: { runLogs: [{ runId: "r1", path: "/p" }], output: largeOutput },
    });
    const tasks = makeTaskMap([makeSummary({ taskId: "alpha", status: "completed" })]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    expect(screen.getByTestId("truncation-indicator")).toBeInTheDocument();
    // The displayed text should be shorter than the original
    const panel = screen.getByTestId("output-panel");
    expect(panel.textContent!.length).toBeLessThan(largeOutput.length);
  });
});

// ── T15: Live output exceeding cap drops oldest ─────────────────────────────

describe("T15: Live output exceeding cap drops oldest content with indicator", () => {
  it("shows truncation indicator when live buffer overflows", async () => {
    const task = makeTask({ id: "alpha", status: "generator_running" });
    const conn = createMockConnection({ getTaskResult: { task } });
    const tasks = makeTaskMap([
      makeSummary({ taskId: "alpha", status: "generator_running", runHealth: "active" }),
    ]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    // Deliver chunks that exceed 256 KB
    const chunk = "Y".repeat(64 * 1024);
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        conn._capturedOutputListener?.onChunk(chunk);
      });
    }

    expect(screen.getByTestId("truncation-indicator")).toBeInTheDocument();
  });
});

// ── T16: Silent clipping does not occur ─────────────────────────────────────

describe("T16: Silent clipping does not occur", () => {
  it("always shows truncation indicator when output exceeds cap", async () => {
    // Same setup as T14 but verifies the indicator specifically
    const largeOutput = "Z".repeat(300 * 1024);
    const task = makeTask({ id: "alpha", status: "completed" });
    const conn = createMockConnection({
      getTaskResult: { task },
      getLogsResult: { runLogs: [{ runId: "r1", path: "/p" }], output: largeOutput },
    });
    const tasks = makeTaskMap([makeSummary({ taskId: "alpha", status: "completed" })]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    // Must have visible truncation indicator — not silently clipped
    const indicator = screen.getByTestId("truncation-indicator");
    expect(indicator).toBeInTheDocument();
    expect(indicator.textContent).toMatch(/truncated|showing/i);
  });
});

// ── T17: Running task with runHealth "active" ───────────────────────────────

describe("T17: Running task with runHealth active shows active indicator", () => {
  it("shows active run-health indicator in detail pane", async () => {
    const task = makeTask({ id: "alpha", status: "generator_running" });
    const conn = createMockConnection({ getTaskResult: { task } });
    const tasks = makeTaskMap([
      makeSummary({ taskId: "alpha", status: "generator_running", runHealth: "active" }),
    ]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    const indicator = screen.getByTestId("detail-run-health");
    expect(indicator).toHaveTextContent(/active/i);
  });
});

// ── T18: Running task with runHealth "quiet" ────────────────────────────────

describe("T18: Running task with runHealth quiet shows quiet indicator", () => {
  it("shows quiet run-health indicator that is visually distinct from active", async () => {
    const task = makeTask({ id: "alpha", status: "generator_running" });
    const conn = createMockConnection({ getTaskResult: { task } });
    const tasks = makeTaskMap([
      makeSummary({ taskId: "alpha", status: "generator_running", runHealth: "quiet" }),
    ]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    const indicator = screen.getByTestId("detail-run-health");
    expect(indicator).toHaveTextContent(/quiet/i);
  });
});

// ── T19: Non-running task does not show run-health ──────────────────────────

describe("T19: Non-running task does not show run-health", () => {
  it("does not display run-health indicator for completed task", async () => {
    const task = makeTask({ id: "alpha", status: "completed" });
    const conn = createMockConnection({
      getTaskResult: { task },
      getLogsResult: { runLogs: [], output: "" },
    });
    const tasks = makeTaskMap([
      makeSummary({ taskId: "alpha", status: "completed" }),
    ]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    expect(screen.queryByTestId("detail-run-health")).not.toBeInTheDocument();
  });
});

// ── T20: Disconnected state marks output as potentially incomplete ──────────

describe("T20: Disconnected state marks output as potentially incomplete", () => {
  it("shows stale/incomplete indicator when connection drops during live output", async () => {
    const task = makeTask({ id: "alpha", status: "generator_running" });
    const conn = createMockConnection({ getTaskResult: { task } });
    const tasks = makeTaskMap([
      makeSummary({ taskId: "alpha", status: "generator_running", runHealth: "active" }),
    ]);

    const { rerender } = await act(async () =>
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      ),
    );

    // Deliver some output
    await act(async () => {
      conn._capturedOutputListener?.onChunk("partial data");
    });

    // Connection drops
    await act(async () => {
      rerender(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={DISCONNECTED}
          connection={conn}
        />,
      );
    });

    expect(screen.getByTestId("output-stale-indicator")).toBeInTheDocument();
  });
});

// ── T21: Reconnect refreshes detail ─────────────────────────────────────────

describe("T21: Reconnect refreshes detail", () => {
  it("re-fetches get-task after reconnect and snapshot delivery", async () => {
    const task = makeTask({ id: "alpha", status: "generator_running" });
    const conn = createMockConnection({ getTaskResult: { task } });
    const tasks = makeTaskMap([
      makeSummary({ taskId: "alpha", status: "generator_running", runHealth: "active" }),
    ]);

    const { rerender } = await act(async () =>
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      ),
    );

    // Initial fetch
    expect(conn.getTask).toHaveBeenCalledTimes(1);

    // Disconnect
    await act(async () => {
      rerender(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={RECONNECTING}
          connection={conn}
        />,
      );
    });

    // Reconnect with fresh snapshot
    conn.getTask.mockResolvedValue({ task: makeTask({ id: "alpha", status: "completed" }) });
    const freshTasks = makeTaskMap([
      makeSummary({ taskId: "alpha", status: "completed" }),
    ]);

    await act(async () => {
      rerender(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={freshTasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    // Should have re-fetched
    expect(conn.getTask).toHaveBeenCalledTimes(2);
  });
});

// ── T22: Summary grid remains visible (layout test) ─────────────────────────
// This test belongs at the App level, but we verify detail pane structure here.

describe("T22: Detail pane does not replace the summary grid", () => {
  it("renders as a panel component, not a full-page view", async () => {
    const task = makeTask({ id: "alpha" });
    const conn = createMockConnection({ getTaskResult: { task } });
    const tasks = makeTaskMap([makeSummary({ taskId: "alpha" })]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    const panel = screen.getByTestId("task-detail-panel");
    expect(panel).toBeInTheDocument();
    // The panel should not have full-page indicators
    expect(panel.style.position).not.toBe("fixed");
  });
});

// ── T23: Empty selection does not show large blank area ─────────────────────

describe("T23: Empty selection does not show large blank area", () => {
  it("shows a minimal placeholder when no task is selected", async () => {
    const conn = createMockConnection();
    const tasks = makeTaskMap([makeSummary({ taskId: "alpha" })]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId={null}
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    const empty = screen.getByTestId("detail-empty");
    expect(empty).toBeInTheDocument();
    expect(empty.textContent).toMatch(/select a task/i);
  });
});

// ── S4: Re-fetch on selection (invariant check) ────────────────────────────

describe("S4: Re-fetch on selection", () => {
  it("calls get-task when a task is selected", async () => {
    const task = makeTask({ id: "alpha" });
    const conn = createMockConnection({ getTaskResult: { task } });
    const tasks = makeTaskMap([makeSummary({ taskId: "alpha" })]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    expect(conn.getTask).toHaveBeenCalledWith("alpha");
  });
});

// ── S5: Re-fetch on meaningful delta (status change) ───────────────────────

describe("S5: Re-fetch on meaningful delta", () => {
  it("re-fetches when status changes but not on minor updates", async () => {
    const task = makeTask({ id: "alpha", status: "generator_running" });
    const conn = createMockConnection({ getTaskResult: { task } });
    const tasks = makeTaskMap([
      makeSummary({ taskId: "alpha", status: "generator_running", runHealth: "active" }),
    ]);

    const { rerender } = await act(async () =>
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      ),
    );

    expect(conn.getTask).toHaveBeenCalledTimes(1);

    // Minor update (only lastOutputAt changes, status same)
    const minorUpdate = makeTaskMap([
      makeSummary({
        taskId: "alpha",
        status: "generator_running",
        runHealth: "active",
        lastOutputAt: new Date().toISOString(),
      }),
    ]);

    await act(async () => {
      rerender(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={minorUpdate}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    // Should NOT re-fetch for minor update
    expect(conn.getTask).toHaveBeenCalledTimes(1);

    // Status change
    conn.getTask.mockResolvedValue({ task: makeTask({ id: "alpha", status: "completed" }) });
    const statusChange = makeTaskMap([
      makeSummary({ taskId: "alpha", status: "completed" }),
    ]);

    await act(async () => {
      rerender(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={statusChange}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    // Should re-fetch on status change
    expect(conn.getTask).toHaveBeenCalledTimes(2);
  });
});

// ── O6: Monospace rendering ─────────────────────────────────────────────────

describe("O6: Output uses monospace rendering", () => {
  it("output panel uses monospace font family", async () => {
    const task = makeTask({ id: "alpha", status: "completed" });
    const conn = createMockConnection({
      getTaskResult: { task },
      getLogsResult: { runLogs: [{ runId: "r1", path: "/p" }], output: "some output" },
    });
    const tasks = makeTaskMap([makeSummary({ taskId: "alpha", status: "completed" })]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    const panel = screen.getByTestId("output-panel");
    expect(panel.style.fontFamily).toMatch(/mono/i);
  });
});

// ── Invariant 10: Detail pane does not poll ─────────────────────────────────

describe("Invariant 10: Detail pane does not poll", () => {
  it("does not send additional get-task requests on a timer", async () => {
    const task = makeTask({ id: "alpha" });
    const conn = createMockConnection({ getTaskResult: { task } });
    const tasks = makeTaskMap([makeSummary({ taskId: "alpha" })]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    const initialCalls = conn.getTask.mock.calls.length;

    // Wait 200ms — if polling, more calls would appear
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    expect(conn.getTask).toHaveBeenCalledTimes(initialCalls);
  });
});

// ── Detail metadata fields (crash_count, current_attempt, etc.) ─────────────

describe("Task metadata display", () => {
  it("shows current_attempt and crash_count from full task object", async () => {
    const task = makeTask({
      id: "alpha",
      status: "escalated",
      current_attempt: 3,
      crash_count: 2,
      assigned_at: "2026-03-28T10:00:00.000Z",
    });
    const conn = createMockConnection({ getTaskResult: { task } });
    const tasks = makeTaskMap([
      makeSummary({ taskId: "alpha", status: "escalated", transitionReason: "max_attempts_exhausted" }),
    ]);

    await act(async () => {
      render(
        <TaskDetail
          selectedTaskId="alpha"
          tasks={tasks}
          connectionState={CONNECTED}
          connection={conn}
        />,
      );
    });

    expect(screen.getByTestId("detail-attempt")).toHaveTextContent("3");
    expect(screen.getByTestId("detail-crash-count")).toHaveTextContent("2");
  });
});
