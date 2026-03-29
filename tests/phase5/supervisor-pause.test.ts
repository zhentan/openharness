/**
 * P17: Drain-and-pause
 * P18: Resume flow
 *
 * Phase gate: 5
 */
import { describe, expect, it, vi } from "vitest";

describe("Phase 5: supervisor pause and resume", () => {
  it("records pause intent without terminating the running process", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const terminateProcessGroup = vi.fn(async () => undefined);

    const supervisor = new Supervisor({
      store: { updateStatus },
      terminateProcessGroup,
    });

    supervisor.attachProcess("t_pause", { pid: 123, pgid: 456 });
    await supervisor.requestPause("t_pause");

    expect(terminateProcessGroup).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalledWith("t_pause", "paused", expect.anything());
  });

  it("intercepts natural completion and stores paused instead of completed", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      store: { updateStatus },
      terminateProcessGroup: vi.fn(async () => undefined),
    });

    supervisor.attachProcess("t_pause_done", { pid: 123, pgid: 456 });
    await supervisor.requestPause("t_pause_done");
    await supervisor.handleAgentExit("t_pause_done", { type: "completion" });

    expect(updateStatus).toHaveBeenCalledWith("t_pause_done", "paused", expect.anything());
  });

  it("resume cleans paused worktree state and returns the task to pending", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const cleanupPausedWorktree = vi.fn(async () => undefined);

    const supervisor = new Supervisor({
      store: { updateStatus },
      cleanupPausedWorktree,
      terminateProcessGroup: vi.fn(async () => undefined),
    });

    await supervisor.resumeTask("t_paused");

    expect(cleanupPausedWorktree).toHaveBeenCalledWith("t_paused");
    expect(updateStatus).toHaveBeenCalledWith("t_paused", "pending", expect.anything());
  });

  it("routes evaluator rejection to revisions_requested with feedback metadata", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      store: { updateStatus },
      terminateProcessGroup: vi.fn(async () => undefined),
    });

    await supervisor.handleAgentExit("t_revision", {
      type: "retry",
      reason: "eval_failed",
      feedback: "Fix the failing tests before resubmitting.",
    });

    expect(updateStatus).toHaveBeenCalledWith("t_revision", "revisions_requested", {
      source: "supervisor.handleAgentExit",
      reason: "eval_failed",
      feedback: "Fix the failing tests before resubmitting.",
    });
  });

  it("routes evaluator timeout to retry_pending instead of revisions_requested", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      store: { updateStatus },
      terminateProcessGroup: vi.fn(async () => undefined),
    });

    await supervisor.handleAgentExit("t_eval_timeout", {
      type: "retry",
      reason: "eval_timed_out",
      feedback: "Evaluator did not finish in time.",
    });

    expect(updateStatus).toHaveBeenCalledWith("t_eval_timeout", "retry_pending", {
      source: "supervisor.handleAgentExit",
      reason: "eval_timed_out",
      feedback: "Evaluator did not finish in time.",
    });
  });

  it("routes fatal environmental failures to escalated, bypassing retry budget (H22)", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      store: { updateStatus },
      terminateProcessGroup: vi.fn(async () => undefined),
    });

    await supervisor.handleAgentExit("t_disk_full", {
      type: "retry",
      reason: "fatal_disk_full",
      feedback: "ENOSPC: No space left on device",
    });

    expect(updateStatus).toHaveBeenCalledWith("t_disk_full", "escalated", {
      source: "supervisor.handleAgentExit",
      reason: "fatal_disk_full",
      feedback: "ENOSPC: No space left on device",
    });
  });

  it("rejects escalation events without a reason", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      store: { updateStatus },
      terminateProcessGroup: vi.fn(async () => undefined),
    });

    await expect(
      supervisor.handleAgentExit("t_missing_escalation_reason", {
        type: "escalation",
        feedback: "disk full",
      } as never),
    ).rejects.toThrow(/reason/i);

    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("rejects retry events without a reason", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      store: { updateStatus },
      terminateProcessGroup: vi.fn(async () => undefined),
    });

    await expect(
      supervisor.handleAgentExit("t_missing_retry_reason", {
        type: "retry",
        feedback: "try again",
      } as never),
    ).rejects.toThrow(/reason/i);

    expect(updateStatus).not.toHaveBeenCalled();
  });
});