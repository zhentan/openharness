/**
 * H9: total_timeout enforcement (cumulative across attempts)
 *
 * Phase gate: 5
 *
 * When the cumulative time across all attempts exceeds
 * exploration_budget.total_timeout, the supervisor must escalate
 * the task instead of allowing another retry.
 */
import { describe, it, expect, vi } from "vitest";

describe("H9: total_timeout enforcement", () => {
  it("escalates when cumulative attempt duration exceeds total_timeout", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      store: { updateStatus },
      terminateProcessGroup: vi.fn(async () => undefined),
    });

    // Task with 45-minute total timeout, previous attempts used 40 minutes
    const task = {
      id: "t_total_timeout",
      title: "Total timeout test",
      status: "generator_running" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "test",
      exploration_budget: { max_attempts: 10, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      previous_attempts: [
        { attempt: 1, reason: "timed_out" as const, duration_ms: 20 * 60_000 },
        { attempt: 2, reason: "timed_out" as const, duration_ms: 20 * 60_000 },
      ],
      current_attempt: 3,
    };

    // This attempt lasted 10 minutes — cumulative is now 50 min > 45 min total_timeout
    await supervisor.handleAgentExitWithTask(task, {
      type: "retry",
      reason: "timed_out",
      durationMs: 10 * 60_000,
    });

    // Should escalate due to total_timeout exhaustion, not retry
    expect(updateStatus).toHaveBeenCalledWith(
      "t_total_timeout",
      "escalated",
      expect.objectContaining({ reason: "total_timeout_exhausted" }),
    );
  });

  it("allows retry when cumulative duration is within total_timeout", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      store: { updateStatus },
      terminateProcessGroup: vi.fn(async () => undefined),
    });

    const task = {
      id: "t_within_budget",
      title: "Within budget",
      status: "generator_running" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "test",
      exploration_budget: { max_attempts: 10, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      previous_attempts: [
        { attempt: 1, reason: "timed_out" as const, duration_ms: 10 * 60_000 },
      ],
      current_attempt: 2,
    };

    // This attempt lasted 5 minutes — cumulative is 15 min < 45 min total_timeout
    await supervisor.handleAgentExitWithTask(task, {
      type: "retry",
      reason: "timed_out",
      durationMs: 5 * 60_000,
    });

    // Should retry, not escalate
    expect(updateStatus).toHaveBeenCalledWith(
      "t_within_budget",
      "retry_pending",
      expect.objectContaining({ reason: "timed_out" }),
    );
  });

  it("escalates fatal failures immediately regardless of total_timeout remaining", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      store: { updateStatus },
      terminateProcessGroup: vi.fn(async () => undefined),
    });

    const task = {
      id: "t_fatal_with_budget",
      title: "Fatal with budget remaining",
      status: "generator_running" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "test",
      exploration_budget: { max_attempts: 10, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      previous_attempts: [],
      current_attempt: 1,
    };

    // Fatal failure on first attempt — plenty of budget left but still escalates
    await supervisor.handleAgentExitWithTask(task, {
      type: "retry",
      reason: "fatal_disk_full",
      durationMs: 1 * 60_000,
    });

    expect(updateStatus).toHaveBeenCalledWith(
      "t_fatal_with_budget",
      "escalated",
      expect.objectContaining({ reason: "fatal_disk_full" }),
    );
  });

  it("escalates instead of requesting revisions when eval_failed has already exhausted total_timeout", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      store: { updateStatus },
      terminateProcessGroup: vi.fn(async () => undefined),
    });

    const task = {
      id: "t_eval_failed_budget_exhausted",
      title: "Eval failed after budget exhaustion",
      status: "evaluator_running" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "test",
      exploration_budget: { max_attempts: 10, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
      previous_attempts: [
        { attempt: 1, reason: "timed_out" as const, duration_ms: 30 * 60_000 },
        { attempt: 2, reason: "eval_timed_out" as const, duration_ms: 10 * 60_000 },
      ],
      current_attempt: 3,
    };

    await supervisor.handleAgentExitWithTask(task, {
      type: "retry",
      reason: "eval_failed",
      feedback: "Tests still fail",
      durationMs: 5 * 60_000,
    });

    expect(updateStatus).toHaveBeenCalledWith(
      "t_eval_failed_budget_exhausted",
      "escalated",
      expect.objectContaining({ reason: "total_timeout_exhausted" }),
    );
  });

  it("escalates with max_attempts_exhausted when a retryable failure happens on the last allowed attempt", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      store: { updateStatus },
      terminateProcessGroup: vi.fn(async () => undefined),
    });

    const task = {
      id: "t_max_attempts_exhausted",
      title: "Retry on last allowed attempt",
      status: "generator_running" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "test",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 120 },
      escalation_rules: [],
      previous_attempts: [
        { attempt: 1, reason: "timed_out" as const, duration_ms: 5 * 60_000 },
        { attempt: 2, reason: "rate_limited" as const, duration_ms: 5 * 60_000 },
      ],
      current_attempt: 3,
    };

    await supervisor.handleAgentExitWithTask(task, {
      type: "retry",
      reason: "timed_out",
      durationMs: 5 * 60_000,
    });

    expect(updateStatus).toHaveBeenCalledWith(
      "t_max_attempts_exhausted",
      "escalated",
      expect.objectContaining({ reason: "max_attempts_exhausted" }),
    );
  });
});
