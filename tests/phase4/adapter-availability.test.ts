/**
 * H16: Adapter availability check at startup
 * H25: Startup validates all referenced adapters exist in registry
 *
 * Phase gate: 4
 */
import { describe, expect, it, vi } from "vitest";

describe("Phase 4: startup adapter validation", () => {
  it("uses adapter-specific availability probes instead of only checking the base binary", async () => {
    const { getAvailabilityProbe } = await import("../../src/startup.js");

    expect(getAvailabilityProbe({ name: "claude-code", command: "claude", spawn: vi.fn() })).toEqual({
      command: "which",
      args: ["claude"],
    });

    expect(
      getAvailabilityProbe({
        name: "copilot",
        command: "gh",
        availabilityArgs: ["copilot", "--help"],
        spawn: vi.fn(),
      }),
    ).toEqual({
      command: "gh",
      args: ["copilot", "--help"],
    });

    expect(
      getAvailabilityProbe({
        name: "codex",
        command: "codex",
        availabilityArgs: ["exec", "--help"],
        spawn: vi.fn(),
      }),
    ).toEqual({
      command: "codex",
      args: ["exec", "--help"],
    });
  });

  it("fails when default or evaluator adapters are missing from the registry", async () => {
    const { AdapterRegistry } = await import("../../src/adapters/registry.js");
    const { validateAdapterAvailability } = await import("../../src/startup.js");

    const registry = new AdapterRegistry([{ name: "claude-code", spawn: vi.fn() }]);

    await expect(
      validateAdapterAvailability(
        {
          defaultAdapter: "claude-code",
          evaluatorAdapter: "copilot",
        },
        [],
        registry,
        async () => true,
      ),
    ).rejects.toThrow(/copilot/i);
  });

  it("fails when a task-level adapter override is unknown", async () => {
    const { AdapterRegistry } = await import("../../src/adapters/registry.js");
    const { validateAdapterAvailability } = await import("../../src/startup.js");

    const registry = new AdapterRegistry([
      { name: "claude-code", spawn: vi.fn() },
      { name: "copilot", spawn: vi.fn() },
    ]);

    await expect(
      validateAdapterAvailability(
        {
          defaultAdapter: "claude-code",
          evaluatorAdapter: "copilot",
        },
        [
          {
            id: "t1",
            title: "Task",
            status: "pending",
            priority: "high",
            depends_on: [],
            agent_prompt: "test",
            exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
            escalation_rules: [],
            agent: "missing-adapter",
          },
        ],
        registry,
        async () => true,
      ),
    ).rejects.toThrow(/missing-adapter/i);
  });

  it("fails when a referenced adapter is unavailable on the host", async () => {
    const { AdapterRegistry } = await import("../../src/adapters/registry.js");
    const { validateAdapterAvailability } = await import("../../src/startup.js");

    const registry = new AdapterRegistry([
      { name: "claude-code", command: "claude", spawn: vi.fn() },
      { name: "copilot", command: "gh", spawn: vi.fn() },
    ]);

    await expect(
      validateAdapterAvailability(
        {
          defaultAdapter: "claude-code",
          evaluatorAdapter: "copilot",
        },
        [],
        registry,
        async (adapter) => !(adapter.name === "copilot" && adapter.command === "gh"),
      ),
    ).rejects.toThrow(/copilot|available/i);
  });
});
