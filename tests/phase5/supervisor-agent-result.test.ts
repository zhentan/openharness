import { describe, expect, it, vi } from "vitest";
import type { AgentProcess } from "../../src/types.js";

function createProcess(result: Awaited<ReturnType<AgentProcess["wait"]>>): AgentProcess {
  return {
    pid: 321,
    pgid: 321,
    output: (async function* () {})(),
    wait: vi.fn(async () => result),
    kill: vi.fn(async () => undefined),
  };
}

describe("Phase 5: supervisor agent results", () => {
  it("marks a task completed when the adapter result carries a completion signal", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      store: { updateStatus },
      preEvaluator: { run: vi.fn(async () => ({ successCriteria: [] })) },
      generatorAdapter: {
        name: "dummy",
        spawn: vi.fn(() =>
          createProcess({
            exitCode: 0,
            duration: 25,
            output: "done",
            completionSignal: { status: "completed", summary: "done" },
          }),
        ),
      },
    });

    await supervisor.spawnAgent({
      id: "t_complete",
      title: "Complete",
      status: "pending",
      priority: "high",
      depends_on: [],
      agent_prompt: "implement",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(updateStatus).toHaveBeenCalledWith(
      "t_complete",
      "completed",
      expect.objectContaining({ source: "supervisor.handleAgentExitWithTask" }),
    );
  });

  it("routes classified missing_signal exits to retry_pending", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      store: { updateStatus },
      preEvaluator: { run: vi.fn(async () => ({ successCriteria: [] })) },
      generatorAdapter: {
        name: "dummy",
        spawn: vi.fn(() =>
          createProcess({
            exitCode: 0,
            duration: 25,
            output: "",
            classification: { severity: "TRANSIENT", reason: "missing_signal" },
          }),
        ),
      },
    });

    await supervisor.spawnAgent({
      id: "t_missing_signal",
      title: "Missing Signal",
      status: "pending",
      priority: "high",
      depends_on: [],
      agent_prompt: "implement",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(updateStatus).toHaveBeenCalledWith(
      "t_missing_signal",
      "retry_pending",
      expect.objectContaining({ source: "supervisor.handleAgentExitWithTask", reason: "missing_signal" }),
    );
  });

  it("escalates fatal worktree loss instead of retrying", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      store: { updateStatus },
      preEvaluator: { run: vi.fn(async () => ({ successCriteria: [] })) },
      generatorAdapter: {
        name: "dummy",
        spawn: vi.fn(() =>
          createProcess({
            exitCode: 1,
            duration: 25,
            output: "",
            classification: { severity: "FATAL", reason: "worktree_lost" },
          }),
        ),
      },
    });

    await supervisor.spawnAgent({
      id: "t_worktree_lost",
      title: "Worktree Lost",
      status: "pending",
      priority: "high",
      depends_on: [],
      agent_prompt: "implement",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(updateStatus).toHaveBeenCalledWith(
      "t_worktree_lost",
      "escalated",
      expect.objectContaining({ source: "supervisor.handleAgentExitWithTask", reason: "worktree_lost" }),
    );
  });

  it("escalates when main worktree contamination is detected after the agent exits", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const process: AgentProcess = {
      pid: 321,
      pgid: 321,
      output: (async function* () {})(),
      wait: vi.fn(async () => ({ exitCode: 0, duration: 25, output: "" })),
      kill: vi.fn(async () => undefined),
    };

    const updateStatus = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      store: { updateStatus },
      preEvaluator: { run: vi.fn(async () => ({ successCriteria: [] })) },
      generatorAdapter: { name: "dummy", spawn: vi.fn(() => process) },
      verifyMainWorktreeIntegrity: vi.fn(async () => "main worktree changed"),
    });

    await supervisor.spawnAgent({
      id: "t_contaminated",
      title: "Contaminated",
      status: "pending",
      priority: "high",
      depends_on: [],
      agent_prompt: "implement",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(updateStatus).toHaveBeenCalledWith(
      "t_contaminated",
      "escalated",
      expect.objectContaining({
        source: "supervisor.handleAgentExitWithTask",
        reason: "main_worktree_contaminated",
      }),
    );
  });
});
