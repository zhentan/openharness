/**
 * P17: Pause flow (drain and pause)
 * P18: Resume flow
 *
 * v1 proof: src/supervisor/supervisor.ts:161-176 (pause),
 *           src/server/ws-server.ts + bin/openharness.ts:161-169 (resume)
 * Phase gate: 5 (pause), 7+8 (resume)
 *
 * Pause: set a flag, let the agent finish naturally, intercept the next
 * state transition and move to 'paused' instead. NO process killing.
 *
 * Resume: clean up paused worktree, set task back to pending for re-dispatch.
 */
import { describe, it, expect, vi } from "vitest";

describe("P17: Drain-and-pause", () => {
  it("pause sets intent without terminating the running process", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const terminateProcessGroup = vi.fn();
    const updateStatus = vi.fn().mockResolvedValue(undefined);

    const supervisor = new Supervisor({
      store: { updateStatus },
      terminateProcessGroup,
    });

    supervisor.attachProcess?.("t_pause", { pid: 123, pgid: 123 });
    await supervisor.requestPause("t_pause");

    expect(terminateProcessGroup).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalledWith("t_pause", "paused", expect.anything());
  });

  it("intercepts natural completion and stores paused instead of completed", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn().mockResolvedValue(undefined);
    const supervisor = new Supervisor({
      store: { updateStatus },
      terminateProcessGroup: vi.fn(),
    });

    supervisor.attachProcess?.("t_pause_done", { pid: 123, pgid: 123 });
    await supervisor.requestPause("t_pause_done");
    await supervisor.handleAgentExit("t_pause_done", { type: "completion" });

    expect(updateStatus).toHaveBeenCalledWith("t_pause_done", "paused", expect.anything());
  });
});

describe("P18: Resume flow", () => {
  it("resume cleans up paused state and sets task back to pending", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn().mockResolvedValue(undefined);
    const cleanupPausedWorktree = vi.fn().mockResolvedValue(undefined);

    const supervisor = new Supervisor({
      store: { updateStatus },
      cleanupPausedWorktree,
      terminateProcessGroup: vi.fn(),
    });

    await supervisor.resumeTask("t_paused");

    expect(cleanupPausedWorktree).toHaveBeenCalledWith("t_paused");
    expect(updateStatus).toHaveBeenCalledWith("t_paused", "pending", expect.anything());
  });
});
