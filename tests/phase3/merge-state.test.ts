/**
 * H21: Post-merge-revert has explicit next state
 *
 * Phase gate: 3
 */
import { describe, it, expect, vi } from "vitest";

describe("H21: merge revert state", () => {
  it("fails closed when no merge implementation is configured", async () => {
    const { mergeWorktreeToMain } = await import("../../src/merge.js");

    const result = await mergeWorktreeToMain({
      taskId: "t_missing_merge",
    }).catch((error: Error & { nextStatus?: string }) => error.nextStatus);

    expect(result).toBe("escalated");
  });

  it("returns retry_pending when post-merge checks fail and attempts remain", async () => {
    const { mergeWorktreeToMain } = await import("../../src/merge.js");

    const result = await mergeWorktreeToMain({
      taskId: "t_retry",
      attemptsRemaining: true,
      performMerge: vi.fn().mockResolvedValue(undefined),
      runPostMergeChecks: vi.fn().mockRejectedValue(new Error("tests failed")),
      revertMerge: vi.fn().mockResolvedValue(undefined),
    }).catch((error: Error & { nextStatus?: string }) => error.nextStatus);

    expect(result).toBe("retry_pending");
  });

  it("returns escalated when post-merge checks fail and budget is exhausted", async () => {
    const { mergeWorktreeToMain } = await import("../../src/merge.js");

    const result = await mergeWorktreeToMain({
      taskId: "t_escalate",
      attemptsRemaining: false,
      performMerge: vi.fn().mockResolvedValue(undefined),
      runPostMergeChecks: vi.fn().mockRejectedValue(new Error("tests failed")),
      revertMerge: vi.fn().mockResolvedValue(undefined),
    }).catch((error: Error & { nextStatus?: string }) => error.nextStatus);

    expect(result).toBe("escalated");
  });
});
