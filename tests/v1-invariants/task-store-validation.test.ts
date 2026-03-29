/**
 * P9: Task ID validation (SAFE_ID regex)
 *
 * v1 proof: src/store/task-store.ts:8 — /^[a-zA-Z0-9_\-]+$/
 * Phase gate: 1
 *
 * Task IDs end up in file paths, git branch names, and shell commands.
 * Unsafe characters enable path traversal, command injection, or git corruption.
 * The store must reject any task with an ID that doesn't match SAFE_ID.
 */
import { describe, it, expect } from "vitest";

describe("P9: Task ID validation", () => {
  it("accepts valid alphanumeric IDs", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");
    const store = new TaskStore({ tasksDir: "/tmp/test-tasks", dbPath: ":memory:" });

    // These should all be accepted
    const validIds = ["t_abc123", "task-001", "my_task", "A1B2C3"];
    for (const id of validIds) {
      expect(() => store.validateTaskId(id)).not.toThrow();
    }
  });

  it("rejects IDs with path traversal characters", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");
    const store = new TaskStore({ tasksDir: "/tmp/test-tasks", dbPath: ":memory:" });

    const maliciousIds = [
      "../etc/passwd",
      "task/../../secrets",
      "task;rm -rf /",
      "task$(whoami)",
      "task`id`",
      "task with spaces",
      "",
      "task\nnewline",
    ];
    for (const id of maliciousIds) {
      expect(() => store.validateTaskId(id), `should reject "${id}"`).toThrow();
    }
  });
});
