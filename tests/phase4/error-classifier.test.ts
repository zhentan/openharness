/**
 * H11: Child exit without signal = fail closed
 * H22: Fatal environmental failures bypass retry budget
 * H19 (partial): classification precedence is deliberate
 *
 * Phase gate: 4
 */
import { describe, expect, it } from "vitest";

describe("Phase 4: error classifier", () => {
  it("treats completion signal as authoritative over stderr patterns", async () => {
    const { classifyError } = await import("../../src/adapters/error-classifier.js");

    const result = classifyError({
      exitCode: 1,
      stderr: "timeout while waiting",
      completionSignal: { status: "completed", summary: "done", task_id: "t1", run_id: "r1" },
    });

    expect(result).toBeUndefined();
  });

  it("maps escalation signal to agent_escalated", async () => {
    const { classifyError } = await import("../../src/adapters/error-classifier.js");

    const result = classifyError({
      exitCode: 1,
      stderr: "No space left on device",
      escalationSignal: { reason: "blocked", rule: "needs_human", task_id: "t1", run_id: "r1" },
    });

    expect(result).toEqual(expect.objectContaining({ severity: "AGENT", reason: "agent_escalated" }));
  });

  it("fails closed on exit 0 without a signal", async () => {
    const { classifyError } = await import("../../src/adapters/error-classifier.js");

    const result = classifyError({ exitCode: 0 });
    expect(result).toEqual(expect.objectContaining({ severity: "TRANSIENT", reason: "missing_signal" }));
  });

  it("classifies fatal disk errors from adapter patterns", async () => {
    const { classifyError } = await import("../../src/adapters/error-classifier.js");

    const result = classifyError({
      exitCode: 1,
      stderr: "ENOSPC: No space left on device",
      patterns: [{ pattern: /ENOSPC|No space left/i, severity: "FATAL", reason: "fatal_disk_full" }],
    });

    expect(result).toEqual(expect.objectContaining({ severity: "FATAL", reason: "fatal_disk_full" }));
  });

  it("treats exit 137 as sigkill_unknown by default", async () => {
    const { classifyError } = await import("../../src/adapters/error-classifier.js");

    const result = classifyError({ exitCode: 137 });
    expect(result).toEqual(expect.objectContaining({ severity: "TRANSIENT", reason: "sigkill_unknown" }));
  });
});