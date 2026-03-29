/**
 * H25: Adapter selection uses config defaults consistently
 *
 * Phase gate: 4
 */
import { describe, expect, it, vi } from "vitest";

describe("Phase 4: adapter registry", () => {
  it("returns a registered adapter by name", async () => {
    const { AdapterRegistry } = await import("../../src/adapters/registry.js");

    const adapter = { name: "test-adapter", spawn: vi.fn() };
    const registry = new AdapterRegistry([adapter]);

    expect(registry.get("test-adapter")).toBe(adapter);
  });

  it("resolves task-level overrides ahead of config defaults", async () => {
    const { AdapterRegistry } = await import("../../src/adapters/registry.js");

    const registry = new AdapterRegistry([
      { name: "default-gen", spawn: vi.fn() },
      { name: "default-eval", spawn: vi.fn() },
      { name: "task-gen", spawn: vi.fn() },
      { name: "task-eval", spawn: vi.fn() },
    ]);

    const resolved = registry.resolveTaskAdapters(
      {
        id: "t1",
        title: "Task",
        status: "pending",
        priority: "high",
        depends_on: [],
        agent_prompt: "test",
        exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
        escalation_rules: [],
        agent: "task-gen",
        evaluator_agent: "task-eval",
      },
      { defaultAdapter: "default-gen", evaluatorAdapter: "default-eval" },
    );

    expect(resolved.generator.name).toBe("task-gen");
    expect(resolved.evaluator.name).toBe("task-eval");
  });

  it("throws when an adapter name is unknown", async () => {
    const { AdapterRegistry } = await import("../../src/adapters/registry.js");

    const registry = new AdapterRegistry([]);
    expect(() => registry.get("missing-adapter")).toThrow(/missing-adapter/i);
  });

  it("registers the built-in codex adapter by default", async () => {
    const { AdapterRegistry } = await import("../../src/adapters/registry.js");

    const registry = new AdapterRegistry();

    expect(registry.has("codex")).toBe(true);
  });
});
