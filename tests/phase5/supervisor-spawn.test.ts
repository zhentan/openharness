/**
 * P5: Fire-and-forget spawn (non-blocking tick)
 * P6: Task leaves schedulable states before async spawn
 *
 * Phase gate: 5
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentProcess } from "../../src/types.js";

function createProcess(): AgentProcess {
  return {
    pid: 123,
    pgid: 123,
    output: (async function* () {})(),
    wait: vi.fn(async () => ({ exitCode: 0, duration: 1, output: "" })),
    kill: vi.fn(async () => undefined),
  };
}

describe("Phase 5: supervisor spawn", () => {
  it("moves the task to reserved before long-running pre-eval completes and returns immediately", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    let resolvePreEval: (() => void) | undefined;
    const preEvalBarrier = new Promise<void>((resolve) => {
      resolvePreEval = resolve;
    });

    const updateStatus = vi.fn(async () => undefined);
    const runPreEval = vi.fn(async () => {
      await preEvalBarrier;
      return { successCriteria: [] };
    });
    const spawn = vi.fn(() => createProcess());

    const supervisor = new Supervisor({
      store: { updateStatus },
      preEvaluator: { run: runPreEval },
      generatorAdapter: { name: "dummy", spawn },
    });

    const spawnPromise = supervisor.spawnAgent({
      id: "t_spawn",
      title: "Spawn",
      status: "pending",
      priority: "high",
      depends_on: [],
      agent_prompt: "implement",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    });

    expect(updateStatus).toHaveBeenCalledWith("t_spawn", "reserved", expect.anything());

    let returned = false;
    void Promise.resolve(spawnPromise).then(() => {
      returned = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(returned).toBe(true);
    expect(runPreEval).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();

    resolvePreEval?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(spawn).toHaveBeenCalledOnce();
  });

  it("rejects dispatch when the task is not schedulable", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      store: { updateStatus },
      preEvaluator: { run: vi.fn(async () => ({ successCriteria: [] })) },
      generatorAdapter: { name: "dummy", spawn: vi.fn(() => createProcess()) },
    });

    await expect(
      supervisor.spawnAgent({
        id: "t_running",
        title: "Running",
        status: "generator_running",
        priority: "high",
        depends_on: [],
        agent_prompt: "implement",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
      }),
    ).rejects.toThrow(/schedulable/i);

    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("fails fast when no generator adapter is configured", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      store: { updateStatus },
      preEvaluator: { run: vi.fn(async () => ({ successCriteria: [] })) },
    });

    await expect(
      supervisor.spawnAgent({
        id: "t_missing_adapter",
        title: "Missing Adapter",
        status: "pending",
        priority: "high",
        depends_on: [],
        agent_prompt: "implement",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
      }),
    ).rejects.toThrow(/generator adapter/i);

    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("moves the task to retry_pending when background spawn setup fails", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const supervisor = new Supervisor({
      store: { updateStatus },
      preEvaluator: { run: vi.fn(async () => ({ successCriteria: [] })) },
      generatorAdapter: {
        name: "dummy",
        spawn: vi.fn(() => {
          throw new Error("spawn exploded");
        }),
      },
    });

    await supervisor.spawnAgent({
      id: "t_spawn_fail",
      title: "Spawn Fail",
      status: "pending",
      priority: "high",
      depends_on: [],
      agent_prompt: "implement",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(updateStatus).toHaveBeenCalledWith("t_spawn_fail", "retry_pending", expect.anything());
  });

  it("passes stable task and run scope to the agent adapter", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const spawn = vi.fn(() => createProcess());
    const supervisor = new Supervisor({
      store: { updateStatus },
      preEvaluator: { run: vi.fn(async () => ({ successCriteria: [] })) },
      generatorAdapter: { name: "dummy", spawn },
    });

    await supervisor.spawnAgent({
      id: "t_scope",
      title: "Scoped run",
      status: "pending",
      priority: "high",
      depends_on: [],
      agent_prompt: "implement",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(updateStatus).toHaveBeenCalledWith(
      "t_scope",
      "reserved",
      expect.objectContaining({
        source: "supervisor.spawnAgent",
        assignedAt: expect.any(String),
      }),
    );
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          OPENHARNESS_TASK_ID: "t_scope",
          OPENHARNESS_RUN_ID: expect.any(String),
        }),
      }),
    );
  });

  it("wraps the agent prompt with completion and escalation signal protocol instructions", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const spawn = vi.fn(() => createProcess());
    const supervisor = new Supervisor({
      store: { updateStatus },
      preEvaluator: { run: vi.fn(async () => ({ successCriteria: [] })) },
      generatorAdapter: { name: "dummy", spawn },
    });

    await supervisor.spawnAgent({
      id: "t_protocol",
      title: "Signal protocol",
      status: "pending",
      priority: "high",
      depends_on: [],
      agent_prompt: "write the review artifact",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("write the review artifact"),
        env: expect.objectContaining({
          OPENHARNESS_TASK_ID: "t_protocol",
          OPENHARNESS_RUN_ID: expect.any(String),
        }),
      }),
    );

    const spawnedConfig = ((spawn.mock.calls as unknown) as Array<[{
      prompt: string;
      env?: Record<string, string>;
    }]>)[0]?.[0];
    expect(spawnedConfig).toBeDefined();
    const spawnedPrompt = spawnedConfig?.prompt ?? "";
    expect(spawnedPrompt).toContain(".openharness/completion.json");
    expect(spawnedPrompt).toContain(".openharness/escalation.json");
    expect(spawnedPrompt).toContain("OPENHARNESS_TASK_ID");
    expect(spawnedPrompt).toContain("OPENHARNESS_RUN_ID");
    expect(spawnedPrompt).toContain('task_id must be exactly "t_protocol"');
    expect(spawnedPrompt).toContain("run_id must be exactly");
    expect(spawnedPrompt).toContain("status");
    expect(spawnedPrompt).toContain("completed");
  });

  it("passes a resolved output log path to the agent adapter", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const spawn = vi.fn(() => createProcess());
    const resolveOutputFilePath = vi.fn((task, runId: string) => `/tmp/runs/${task.id}/${runId}.log`);
    const supervisor = new Supervisor({
      store: { updateStatus },
      preEvaluator: { run: vi.fn(async () => ({ successCriteria: [] })) },
      generatorAdapter: { name: "dummy", spawn },
      resolveOutputFilePath,
    });

    await supervisor.spawnAgent({
      id: "t_log",
      title: "Log path",
      status: "pending",
      priority: "high",
      depends_on: [],
      agent_prompt: "implement",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(resolveOutputFilePath).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t_log" }),
      expect.any(String),
    );
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        outputFilePath: expect.stringMatching(/^\/tmp\/runs\/t_log\/.*\.log$/),
      }),
    );
  });

  it("prepares the working directory before spawning the agent", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const updateStatus = vi.fn(async () => undefined);
    const spawn = vi.fn(() => createProcess());
    const prepareWorkingDirectory = vi.fn(async (task) => `/tmp/.worktrees/${task.id}`);
    const supervisor = new Supervisor({
      store: { updateStatus },
      preEvaluator: { run: vi.fn(async () => ({ successCriteria: [] })) },
      generatorAdapter: { name: "dummy", spawn },
      prepareWorkingDirectory,
    });

    await supervisor.spawnAgent({
      id: "t_worktree",
      title: "Prepared worktree",
      status: "pending",
      priority: "high",
      depends_on: [],
      agent_prompt: "implement",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(prepareWorkingDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t_worktree" }),
      expect.any(String),
    );
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/tmp/.worktrees/t_worktree",
      }),
    );
  });

  it("retains tracked processes when shutdown termination fails", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const terminateProcessGroup = vi.fn(async (pgid: number) => {
      if (pgid === 456) {
        throw new Error("kill failed");
      }
    });

    const supervisor = new Supervisor({
      store: { updateStatus: vi.fn(async () => undefined) },
      terminateProcessGroup,
    });

    supervisor.attachProcess("t_ok", { pid: 123, pgid: 123 });
    supervisor.attachProcess("t_fail", { pid: 456, pgid: 456 });

    await expect(supervisor.shutdown()).rejects.toThrow(/kill failed/);

    const trackedProcesses = (supervisor as unknown as {
      processes: Map<string, { pid: number; pgid: number }>;
    }).processes;

    expect(Array.from(trackedProcesses.entries())).toEqual([
      ["t_ok", { pid: 123, pgid: 123 }],
      ["t_fail", { pid: 456, pgid: 456 }],
    ]);
  });
});
