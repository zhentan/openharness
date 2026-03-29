/**
 * H10: Signals scoped to task/run-id
 * H26: Signal files are mutually exclusive
 *
 * Phase gate: 4
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Phase 4: scoped signals", () => {
  let worktreeDir: string;
  let signalDir: string;

  beforeEach(async () => {
    worktreeDir = await mkdtemp(join(tmpdir(), "oh-signal-"));
    signalDir = join(worktreeDir, ".openharness");
    await mkdir(signalDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(worktreeDir, { recursive: true, force: true });
  });

  it("reads a completion signal only when task_id and run_id match", async () => {
    const { readScopedSignals } = await import("../../src/evaluator/signal.js");

    await writeFile(
      join(signalDir, "completion.json"),
      JSON.stringify({ status: "completed", summary: "done", task_id: "t_ok", run_id: "run_ok" }),
      "utf8",
    );

    const result = await readScopedSignals(worktreeDir, { taskId: "t_ok", runId: "run_ok" });
    expect(result.completionSignal?.summary).toBe("done");
    expect(result.escalationSignal).toBeUndefined();
  });

  it("ignores stale or foreign signals when scope does not match", async () => {
    const { readScopedSignals } = await import("../../src/evaluator/signal.js");

    await writeFile(
      join(signalDir, "completion.json"),
      JSON.stringify({ status: "completed", summary: "stale", task_id: "t_other", run_id: "run_other" }),
      "utf8",
    );

    const result = await readScopedSignals(worktreeDir, { taskId: "t_ok", runId: "run_ok" });
    expect(result.completionSignal).toBeUndefined();
    expect(result.escalationSignal).toBeUndefined();
  });

  it("rejects mutually exclusive completion and escalation signals for the same scope", async () => {
    const { readScopedSignals } = await import("../../src/evaluator/signal.js");

    await writeFile(
      join(signalDir, "completion.json"),
      JSON.stringify({ status: "completed", summary: "done", task_id: "t_ok", run_id: "run_ok" }),
      "utf8",
    );
    await writeFile(
      join(signalDir, "escalation.json"),
      JSON.stringify({ reason: "blocked", rule: "needs_human", task_id: "t_ok", run_id: "run_ok" }),
      "utf8",
    );

    await expect(readScopedSignals(worktreeDir, { taskId: "t_ok", runId: "run_ok" })).rejects.toThrow(/conflicting_signals/i);
  });
});