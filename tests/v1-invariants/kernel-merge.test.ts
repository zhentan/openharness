/**
 * P7: Serial merge (one per tick)
 * P8: Test-after-merge with revert on failure
 *
 * v1 proof: src/kernel.ts:247 (serial), src/supervisor/supervisor.ts:327-335 (test+revert)
 * Phase gate: 6
 *
 * Only one task merges per tick to avoid concurrent merge conflicts.
 * Tests run after merge; if they fail, the merge is auto-reverted.
 */
import { describe, it, expect, vi } from "vitest";

describe("P7: Serial merge", () => {
  it("kernel tick merges at most one ready task even when multiple are eligible", async () => {
    const { Kernel } = await import("../../src/kernel.js");

    const mergeWorktreeToMain = vi.fn().mockResolvedValue(undefined);
    const tasks = [
      { id: "t_ready_1", status: "completed", depends_on: [] },
      { id: "t_ready_2", status: "completed", depends_on: [] },
    ];

    const kernel = new Kernel({
      store: { list: vi.fn().mockResolvedValue(tasks), updateStatus: vi.fn().mockResolvedValue(undefined) },
      mergeWorktreeToMain,
      scheduler: { findMergeReady: vi.fn().mockReturnValue(tasks) },
    });

    await kernel.tick();

    expect(mergeWorktreeToMain).toHaveBeenCalledTimes(1);
    expect(mergeWorktreeToMain).toHaveBeenCalledWith(expect.objectContaining({ id: "t_ready_1" }));
  });
});

describe("P8: Test-after-merge with revert", () => {
  it("merge helper performs the merge before running post-merge checks", async () => {
    const { mergeWorktreeToMain } = await import("../../src/merge.js");

    const callOrder: string[] = [];
    const performMerge = vi.fn().mockImplementation(async () => {
      callOrder.push("merge");
    });
    const runPostMergeChecks = vi.fn().mockImplementation(async () => {
      callOrder.push("checks");
    });

    const result = await mergeWorktreeToMain({
      taskId: "t_merge_success",
      performMerge,
      runPostMergeChecks,
    });

    expect(result).toEqual({ nextStatus: "merged" });
    expect(performMerge).toHaveBeenCalled();
    expect(runPostMergeChecks).toHaveBeenCalled();
    expect(callOrder).toEqual(["merge", "checks"]);
  });

  it("merge helper runs post-merge checks and reverts before surfacing failure", async () => {
    const { mergeWorktreeToMain } = await import("../../src/merge.js");

    const runPostMergeChecks = vi.fn().mockRejectedValue(new Error("tests failed"));
    const revertMerge = vi.fn().mockResolvedValue(undefined);

    await expect(
      mergeWorktreeToMain({
        taskId: "t_merge_fail",
        performMerge: vi.fn().mockResolvedValue(undefined),
        runPostMergeChecks,
        revertMerge,
      }),
    ).rejects.toThrow(/tests failed/i);

    expect(runPostMergeChecks).toHaveBeenCalled();
    expect(revertMerge).toHaveBeenCalled();
  });

  it("preserves the original post-merge failure when revert also fails", async () => {
    const { mergeWorktreeToMain } = await import("../../src/merge.js");

    const originalError = new Error("tests failed");
    const revertError = new Error("reset failed");

    await expect(
      mergeWorktreeToMain({
        taskId: "t_merge_double_fail",
        performMerge: vi.fn().mockResolvedValue(undefined),
        runPostMergeChecks: vi.fn().mockRejectedValue(originalError),
        revertMerge: vi.fn().mockRejectedValue(revertError),
      }),
    ).rejects.toMatchObject({
      message: "tests failed",
      cause: revertError,
    });
  });
});
