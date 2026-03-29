/**
 * P5: Fire-and-forget spawn (non-blocking tick)
 * P6: Task leaves schedulable states before async spawn
 *
 * v1 proof: src/kernel.ts:158 (no await), src/supervisor/supervisor.ts:82 (updateStatus first)
 * v1 bugs: #3 (spawn loop), #4 (blocking tick)
 * Phase gate: 5
 *
 * spawnAgent must:
 * 1. Move the task out of schedulable states IMMEDIATELY (before any async work)
 * 2. Return without blocking (fire-and-forget from the tick loop's perspective)
 *
 * If spawnAgent blocks, the tick loop stalls. If the task stays in a schedulable
 * state during pre-eval, the scheduler will re-dispatch it every tick (spawn loop).
 */
import { describe, it, expect, vi } from "vitest";

function createProcess() {
  return {
    pid: 123,
    pgid: 123,
    output: (async function* () {})(),
    wait: vi.fn(async () => ({ exitCode: 0, duration: 1, output: "" })),
    kill: vi.fn(async () => undefined),
  };
}

describe("P5+P6: Non-blocking spawn with immediate state transition", () => {
  it("spawnAgent awaits reserve then returns, with pre-eval running in background", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    let resolvePreEval: (() => void) | undefined;
    const preEvalPromise = new Promise<void>((resolve) => {
      resolvePreEval = resolve;
    });

    const updateStatus = vi.fn().mockResolvedValue(undefined);
    const runPreEval = vi.fn(async () => {
      await preEvalPromise;
    });

    const supervisor = new Supervisor({
      store: { updateStatus },
      preEvaluator: { run: runPreEval },
      generatorAdapter: {
        name: "dummy",
        spawn: vi.fn(() => ({
          pid: 123, pgid: 123,
          output: (async function* () {})(),
          wait: vi.fn(async () => ({ exitCode: 0, duration: 1, output: "" })),
          kill: vi.fn(async () => undefined),
        })),
      },
    });

    const task = {
      id: "t_spawn",
      title: "Spawn test",
      status: "pending" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "test",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    };

    // spawnAgent should await the reserve, then return (fire-and-forget background work)
    await supervisor.spawnAgent(task);

    // Reserve must have been called and completed
    expect(updateStatus).toHaveBeenCalledWith("t_spawn", "reserved", expect.anything());

    // Pre-eval runs in the background — it may or may not have been called yet,
    // but the important thing is spawnAgent returned without waiting for it

    // Let background work proceed
    resolvePreEval?.();
    // Flush microtasks so background promise chain completes
    await new Promise((r) => setTimeout(r, 10));

    expect(runPreEval).toHaveBeenCalled();
  });

  it("moves a task out of schedulable states before spawn side effects continue", async () => {
    const { Supervisor } = await import("../../src/supervisor/supervisor.js");

    const transitions: string[] = [];
    const updateStatus = vi.fn(async (_taskId: string, nextStatus: string) => {
      transitions.push(nextStatus);
    });

    const spawnBarrier = new Promise<void>(() => {
      // Intentionally never resolves in this test.
    });

    const supervisor = new Supervisor({
      store: { updateStatus },
      preEvaluator: { run: vi.fn(() => spawnBarrier) },
      generatorAdapter: { name: "dummy", spawn: vi.fn(() => createProcess()) },
    });

    void supervisor.spawnAgent({
      id: "t_reserved",
      title: "Reserve test",
      status: "retry_pending" as const,
      priority: "high" as const,
      depends_on: [],
      agent_prompt: "test",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    });
    // Flush the awaited updateStatus
    await Promise.resolve();
    await Promise.resolve();

    expect(transitions[0]).toBe("reserved");
  });
});
