import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskControls } from "./TaskControls.js";
import type { ConnectionState, KernelConnection } from "../lib/connection.js";
import type { TaskSummary } from "../types.js";

function createMockConnection(): KernelConnection {
  return {
    state: "connected",
    tasks: new Map<string, TaskSummary>(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    getTask: vi.fn().mockResolvedValue({ task: null }),
    getLogs: vi.fn().mockResolvedValue({ runLogs: [], output: "" }),
    subscribeOutput: vi.fn(() => vi.fn()),
    pauseTask: vi.fn().mockResolvedValue({ ok: true }),
    resumeTask: vi.fn().mockResolvedValue({ ok: true }),
    killTask: vi.fn().mockResolvedValue({ ok: true }),
  };
}

describe("TaskControls", () => {
  it("clears pending state when task status changes after an acknowledged control", async () => {
    const connection = createMockConnection();

    const { rerender } = render(
      <TaskControls
        taskId="task_1"
        taskStatus="generator_running"
        connectionState={"connected" satisfies ConnectionState}
        connection={connection}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("control-pause"));
    });

    expect(await screen.findByTestId("control-pending")).toHaveTextContent(
      "Received",
    );

    rerender(
      <TaskControls
        taskId="task_1"
        taskStatus="paused"
        connectionState={"connected" satisfies ConnectionState}
        connection={connection}
      />,
    );

    expect(screen.queryByTestId("control-pending")).toBeNull();
  });
});
