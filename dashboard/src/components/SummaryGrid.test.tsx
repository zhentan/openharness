import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { SummaryGrid } from "./SummaryGrid.js";
import type { TaskSummary, TaskStatus } from "../types.js";
import type { ConnectionState } from "../lib/connection.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSummary(overrides: Partial<TaskSummary> & { taskId: string }): TaskSummary {
  return {
    title: `Task ${overrides.taskId}`,
    status: "pending" as TaskStatus,
    updatedAt: "2026-03-28T12:00:00.000Z",
    ...overrides,
  };
}

function makeTaskMap(summaries: TaskSummary[]): ReadonlyMap<string, TaskSummary> {
  return new Map(summaries.map((s) => [s.taskId, s]));
}

function makeManyTasks(count: number, statusCycle?: TaskStatus[]): ReadonlyMap<string, TaskSummary> {
  const statuses: TaskStatus[] = statusCycle ?? [
    "pending", "generator_running", "evaluator_running", "completed",
    "escalated", "paused", "merged", "retry_pending",
  ];
  const summaries: TaskSummary[] = [];
  for (let i = 0; i < count; i++) {
    summaries.push(makeSummary({
      taskId: `task_${String(i).padStart(3, "0")}`,
      title: `Task number ${i}`,
      status: statuses[i % statuses.length],
      updatedAt: new Date(Date.now() - (count - i) * 1000).toISOString(),
    }));
  }
  return makeTaskMap(summaries);
}

const CONNECTED: ConnectionState = "connected";
const DISCONNECTED: ConnectionState = "disconnected";
const RECONNECTING: ConnectionState = "reconnecting";

// ── T1: Snapshot renders all tasks ───────────────────────────────────────────

describe("T1: Snapshot renders all tasks", () => {
  it("renders 0 tasks with empty-state message", () => {
    render(<SummaryGrid tasks={new Map()} connectionState={CONNECTED} />);
    expect(screen.getByText(/no tasks/i)).toBeInTheDocument();
  });

  it("renders 1 task with correct fields", () => {
    const tasks = makeTaskMap([
      makeSummary({ taskId: "alpha", title: "Alpha Task", status: "pending", updatedAt: "2026-03-28T12:00:00.000Z" }),
    ]);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("Alpha Task")).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
  });

  it("renders 50 tasks — one row each", () => {
    const tasks = makeManyTasks(50);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    const rows = screen.getAllByTestId("task-row");
    expect(rows).toHaveLength(50);
  });
});

// ── T2: Delta updates specific rows without full replacement ─────────────────

describe("T2: Delta updates specific rows", () => {
  it("re-renders only the changed task when tasks map is updated", () => {
    const initial = makeTaskMap([
      makeSummary({ taskId: "a", status: "pending" }),
      makeSummary({ taskId: "b", status: "pending" }),
      makeSummary({ taskId: "c", status: "pending" }),
    ]);
    const { rerender } = render(<SummaryGrid tasks={initial} connectionState={CONNECTED} />);

    // Delta updates task B
    const updated = makeTaskMap([
      makeSummary({ taskId: "a", status: "pending" }),
      makeSummary({ taskId: "b", status: "completed" }),
      makeSummary({ taskId: "c", status: "pending" }),
    ]);
    rerender(<SummaryGrid tasks={updated} connectionState={CONNECTED} />);

    const rows = screen.getAllByTestId("task-row");
    expect(rows).toHaveLength(3);
    // Task B should now show completed
    const rowB = rows.find((row) => within(row).queryByText("b"));
    expect(rowB).toBeDefined();
    expect(within(rowB!).getByText("completed")).toBeInTheDocument();
    // Tasks A and C should still show pending
    const rowA = rows.find((row) => within(row).queryByText("a"));
    expect(within(rowA!).getByText("pending")).toBeInTheDocument();
  });
});

// ── T3: Delta adds a previously unknown task ─────────────────────────────────

describe("T3: Delta adds unknown task", () => {
  it("shows new task after map update adds it", () => {
    const initial = makeTaskMap([
      makeSummary({ taskId: "a" }),
      makeSummary({ taskId: "b" }),
    ]);
    const { rerender } = render(<SummaryGrid tasks={initial} connectionState={CONNECTED} />);
    expect(screen.getAllByTestId("task-row")).toHaveLength(2);

    const withNew = makeTaskMap([
      makeSummary({ taskId: "a" }),
      makeSummary({ taskId: "b" }),
      makeSummary({ taskId: "c", title: "New Task C" }),
    ]);
    rerender(<SummaryGrid tasks={withNew} connectionState={CONNECTED} />);
    expect(screen.getAllByTestId("task-row")).toHaveLength(3);
    expect(screen.getByText("New Task C")).toBeInTheDocument();
  });
});

// ── T4: Reconnect snapshot replaces entire task set ──────────────────────────

describe("T4: Reconnect snapshot replaces task set", () => {
  it("replaces tasks completely on new map", () => {
    const initial = makeTaskMap([
      makeSummary({ taskId: "a" }),
      makeSummary({ taskId: "b" }),
      makeSummary({ taskId: "c" }),
    ]);
    const { rerender } = render(<SummaryGrid tasks={initial} connectionState={CONNECTED} />);
    expect(screen.getAllByTestId("task-row")).toHaveLength(3);

    // Reconnect delivers only B and D
    const reconnected = makeTaskMap([
      makeSummary({ taskId: "b" }),
      makeSummary({ taskId: "d", title: "Task D" }),
    ]);
    rerender(<SummaryGrid tasks={reconnected} connectionState={CONNECTED} />);
    const rows = screen.getAllByTestId("task-row");
    expect(rows).toHaveLength(2);
    expect(screen.queryByText("a")).not.toBeInTheDocument();
    expect(screen.queryByText("c")).not.toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.getByText("Task D")).toBeInTheDocument();
  });
});

// ── T5: Empty snapshot renders empty state ───────────────────────────────────

describe("T5: Empty snapshot renders empty state", () => {
  it("shows empty message, no broken headers or undefined rows", () => {
    render(<SummaryGrid tasks={new Map()} connectionState={CONNECTED} />);
    expect(screen.getByText(/no tasks/i)).toBeInTheDocument();
    expect(screen.queryAllByTestId("task-row")).toHaveLength(0);
  });

  it("transitions from populated to empty cleanly", () => {
    const tasks = makeManyTasks(5);
    const { rerender } = render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    expect(screen.getAllByTestId("task-row")).toHaveLength(5);

    rerender(<SummaryGrid tasks={new Map()} connectionState={CONNECTED} />);
    expect(screen.queryAllByTestId("task-row")).toHaveLength(0);
    expect(screen.getByText(/no tasks/i)).toBeInTheDocument();
  });
});

// ── T6: Disconnected state is visually flagged ───────────────────────────────

describe("T6: Disconnected state is visually flagged", () => {
  it("shows stale indicator when disconnected", () => {
    const tasks = makeManyTasks(3);
    render(<SummaryGrid tasks={tasks} connectionState={DISCONNECTED} />);
    expect(screen.getByTestId("stale-indicator")).toBeInTheDocument();
  });

  it("shows stale indicator when reconnecting", () => {
    const tasks = makeManyTasks(3);
    render(<SummaryGrid tasks={tasks} connectionState={RECONNECTING} />);
    expect(screen.getByTestId("stale-indicator")).toBeInTheDocument();
  });

  it("does not show stale indicator when connected", () => {
    const tasks = makeManyTasks(3);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    expect(screen.queryByTestId("stale-indicator")).not.toBeInTheDocument();
  });
});

// ── T7: Status visual differentiation ────────────────────────────────────────

describe("T7: Status visual differentiation", () => {
  it("renders escalated with distinct data-status attribute", () => {
    const tasks = makeTaskMap([makeSummary({ taskId: "e", status: "escalated" })]);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    const row = screen.getByTestId("task-row");
    expect(row).toHaveAttribute("data-status", "escalated");
  });

  it("renders paused with distinct data-status attribute", () => {
    const tasks = makeTaskMap([makeSummary({ taskId: "p", status: "paused" })]);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    const row = screen.getByTestId("task-row");
    expect(row).toHaveAttribute("data-status", "paused");
  });

  it("renders quiet running task with data-run-health=quiet", () => {
    const tasks = makeTaskMap([
      makeSummary({ taskId: "q", status: "generator_running", runHealth: "quiet" }),
    ]);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    const row = screen.getByTestId("task-row");
    expect(row).toHaveAttribute("data-run-health", "quiet");
  });

  it("renders active running task with data-run-health=active", () => {
    const tasks = makeTaskMap([
      makeSummary({ taskId: "r", status: "generator_running", runHealth: "active" }),
    ]);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    const row = screen.getByTestId("task-row");
    expect(row).toHaveAttribute("data-run-health", "active");
  });

  it("all four status categories render distinct data-status values", () => {
    const tasks = makeTaskMap([
      makeSummary({ taskId: "1", status: "escalated" }),
      makeSummary({ taskId: "2", status: "paused" }),
      makeSummary({ taskId: "3", status: "generator_running", runHealth: "quiet" }),
      makeSummary({ taskId: "4", status: "completed" }),
    ]);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    const rows = screen.getAllByTestId("task-row");
    const statuses = rows.map((r) => r.getAttribute("data-status"));
    expect(new Set(statuses).size).toBe(4);
  });
});

// ── T8: Density at scale — 100 tasks ─────────────────────────────────────────

describe("T8: Density at scale — 100 tasks", () => {
  it("renders all 100 rows", () => {
    const tasks = makeManyTasks(100);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    expect(screen.getAllByTestId("task-row")).toHaveLength(100);
  });

  it("grid container has overflow scroll", () => {
    const tasks = makeManyTasks(100);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    const container = screen.getByTestId("summary-grid");
    const style = container.style;
    expect(
      style.overflow === "auto" || style.overflowY === "auto" ||
      style.overflow === "scroll" || style.overflowY === "scroll"
    ).toBe(true);
  });
});

// ── T9: Density at scale — 200 tasks ─────────────────────────────────────────

describe("T9: Density at scale — 200 tasks", () => {
  it("renders all 200 rows", () => {
    const tasks = makeManyTasks(200);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    expect(screen.getAllByTestId("task-row")).toHaveLength(200);
  });
});

// ── T10: Timestamp formatting is human-scannable ─────────────────────────────

describe("T10: Timestamp formatting", () => {
  it("does not render raw ISO string for recent timestamps", () => {
    const recentTime = new Date(Date.now() - 30_000).toISOString();
    const tasks = makeTaskMap([
      makeSummary({ taskId: "t", updatedAt: recentTime }),
    ]);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    // Should NOT find the full ISO string in the document
    expect(screen.queryByText(recentTime)).not.toBeInTheDocument();
  });

  it("renders a human-readable relative time", () => {
    const thirtySecsAgo = new Date(Date.now() - 30_000).toISOString();
    const tasks = makeTaskMap([
      makeSummary({ taskId: "t", updatedAt: thirtySecsAgo }),
    ]);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    const row = screen.getByTestId("task-row");
    // Should contain something like "30s ago" or "just now" or "<1m" — not ISO
    const timeCell = within(row).getByTestId("updated-at");
    expect(timeCell.textContent).toBeTruthy();
    expect(timeCell.textContent).not.toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── T11: Long title truncation ───────────────────────────────────────────────

describe("T11: Long title truncation", () => {
  it("title cell has overflow hidden and text-overflow ellipsis", () => {
    const longTitle = "A".repeat(200);
    const tasks = makeTaskMap([makeSummary({ taskId: "long", title: longTitle })]);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    const titleCell = screen.getByTestId("task-title");
    const style = titleCell.style;
    expect(style.overflow).toBe("hidden");
    expect(style.textOverflow).toBe("ellipsis");
    expect(style.whiteSpace).toBe("nowrap");
  });
});

// ── T12: runHealth "quiet" indicator on running tasks ────────────────────────

describe("T12: runHealth quiet indicator", () => {
  it("shows quiet indicator for generator_running + quiet", () => {
    const tasks = makeTaskMap([
      makeSummary({ taskId: "q", status: "generator_running", runHealth: "quiet" }),
    ]);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    expect(screen.getByTestId("run-health-indicator")).toBeInTheDocument();
    expect(screen.getByTestId("run-health-indicator").textContent).toMatch(/quiet/i);
  });

  it("shows active indicator for generator_running + active", () => {
    const tasks = makeTaskMap([
      makeSummary({ taskId: "a", status: "generator_running", runHealth: "active" }),
    ]);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    expect(screen.getByTestId("run-health-indicator")).toBeInTheDocument();
    expect(screen.getByTestId("run-health-indicator").textContent).not.toMatch(/quiet/i);
  });

  it("does not show runHealth indicator for non-running tasks", () => {
    const tasks = makeTaskMap([
      makeSummary({ taskId: "p", status: "pending" }),
    ]);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    expect(screen.queryByTestId("run-health-indicator")).not.toBeInTheDocument();
  });
});

// ── T13: transitionReason visibility ─────────────────────────────────────────

describe("T13: transitionReason visibility", () => {
  it("displays transitionReason when present", () => {
    const tasks = makeTaskMap([
      makeSummary({ taskId: "r", status: "escalated", transitionReason: "timed_out" }),
    ]);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    expect(screen.getByText("timed_out")).toBeInTheDocument();
  });

  it("does not display placeholder when transitionReason is absent", () => {
    const tasks = makeTaskMap([
      makeSummary({ taskId: "r", status: "pending" }),
    ]);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    // Should not contain "undefined", "null", or a dash placeholder in the reason column
    const row = screen.getByTestId("task-row");
    const reasonCell = within(row).getByTestId("transition-reason");
    expect(reasonCell.textContent).toBe("");
  });
});

// ── T14: Rapid sequential deltas converge ────────────────────────────────────

describe("T14: Rapid sequential deltas converge", () => {
  it("shows only the final status after 5 rapid updates", () => {
    const statuses: TaskStatus[] = [
      "pending", "generator_running", "evaluator_running", "completed", "merged",
    ];
    let currentTasks = makeTaskMap([makeSummary({ taskId: "rapid", status: "pending" })]);
    const { rerender } = render(<SummaryGrid tasks={currentTasks} connectionState={CONNECTED} />);

    for (const status of statuses) {
      currentTasks = makeTaskMap([makeSummary({ taskId: "rapid", status })]);
      rerender(<SummaryGrid tasks={currentTasks} connectionState={CONNECTED} />);
    }

    const row = screen.getByTestId("task-row");
    expect(within(row).getByText("merged")).toBeInTheDocument();
  });
});

// ── I-SORT: Stable sort order by taskId ──────────────────────────────────────

describe("I-SORT: Stable sort order", () => {
  it("renders tasks sorted by taskId", () => {
    // Insert out of order
    const tasks = makeTaskMap([
      makeSummary({ taskId: "charlie" }),
      makeSummary({ taskId: "alpha" }),
      makeSummary({ taskId: "bravo" }),
    ]);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    const rows = screen.getAllByTestId("task-row");
    const ids = rows.map((r) => within(r).getByTestId("task-id").textContent);
    expect(ids).toEqual(["alpha", "bravo", "charlie"]);
  });
});

// ── DC-5: Monospace for IDs and timestamps ───────────────────────────────────

describe("DC-5: Monospace for IDs and timestamps", () => {
  it("task ID uses monospace font", () => {
    const tasks = makeTaskMap([makeSummary({ taskId: "mono" })]);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    const idCell = screen.getByTestId("task-id");
    expect(idCell.style.fontFamily).toMatch(/mono/i);
  });

  it("timestamp uses monospace font", () => {
    const tasks = makeTaskMap([
      makeSummary({ taskId: "t", updatedAt: new Date().toISOString() }),
    ]);
    render(<SummaryGrid tasks={tasks} connectionState={CONNECTED} />);
    const timeCell = screen.getByTestId("updated-at");
    expect(timeCell.style.fontFamily).toMatch(/mono/i);
  });
});
