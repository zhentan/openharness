/**
 * H6: Dependency cycle detection
 * H7: Missing dependency detection
 *
 * Phase gate: 1 (startup) / 2 (scheduler)
 *
 * At startup, the kernel validates the dependency graph.
 * Cycles cause silent starvation. Missing deps cause infinite waits.
 * Both must be detected before any scheduling begins.
 */
import { describe, it, expect } from "vitest";

describe("H6: Dependency cycle detection", () => {
  it("detects direct circular dependency (A depends on B, B depends on A)", async () => {
    const { validateDependencyGraph } = await import("../../src/dep-graph.js");

    const tasks = [
      { id: "t_a", depends_on: ["t_b"] },
      { id: "t_b", depends_on: ["t_a"] },
    ];

    const result = validateDependencyGraph(tasks);
    expect(result.valid).toBe(false);
    expect(result.cycles).toBeDefined();
    expect(result.cycles?.length).toBeGreaterThan(0);
  });

  it("detects transitive cycle (A→B→C→A)", async () => {
    const { validateDependencyGraph } = await import("../../src/dep-graph.js");

    const tasks = [
      { id: "t_a", depends_on: ["t_b"] },
      { id: "t_b", depends_on: ["t_c"] },
      { id: "t_c", depends_on: ["t_a"] },
    ];

    const result = validateDependencyGraph(tasks);
    expect(result.valid).toBe(false);
    expect(result.cycles?.length).toBeGreaterThan(0);
  });

  it("passes valid DAG with no cycles", async () => {
    const { validateDependencyGraph } = await import("../../src/dep-graph.js");

    const tasks = [
      { id: "t_a", depends_on: [] },
      { id: "t_b", depends_on: ["t_a"] },
      { id: "t_c", depends_on: ["t_a", "t_b"] },
    ];

    const result = validateDependencyGraph(tasks);
    expect(result.valid).toBe(true);
  });
});

describe("H7: Missing dependency detection", () => {
  it("detects references to non-existent task IDs", async () => {
    const { validateDependencyGraph } = await import("../../src/dep-graph.js");

    const tasks = [
      { id: "t_a", depends_on: ["t_nonexistent"] },
      { id: "t_b", depends_on: [] },
    ];

    const result = validateDependencyGraph(tasks);
    expect(result.valid).toBe(false);
    expect(result.missingDeps).toBeDefined();
    expect(result.missingDeps ?? []).toContain("t_nonexistent");
  });

  it("passes when all dependencies exist", async () => {
    const { validateDependencyGraph } = await import("../../src/dep-graph.js");

    const tasks = [
      { id: "t_a", depends_on: [] },
      { id: "t_b", depends_on: ["t_a"] },
    ];

    const result = validateDependencyGraph(tasks);
    expect(result.valid).toBe(true);
    expect(result.missingDeps ?? []).toHaveLength(0);
  });
});
