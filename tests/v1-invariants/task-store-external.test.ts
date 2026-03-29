/**
 * P10: External runtime state (YAML read-only)
 *
 * v1 proof: src/store/task-store.ts:14-20 — RuntimeState in ~/.openharness/state/
 * Phase gate: 1
 *
 * Task YAML files in the repo are read-only definitions. Runtime state
 * (status, attempts, timestamps) lives externally so the repo working tree
 * never gets dirtied by kernel operations.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("P10: External runtime state", () => {
  let tasksDir: string;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "oh-test-"));
    tasksDir = join(tempDir, "tasks");
    await mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reads task definitions from YAML without modifying them", async () => {
    const yamlContent = `id: t_test001
title: Test task
priority: high
depends_on: []
agent_prompt: "Do the thing"
exploration_budget:
  max_attempts: 3
  timeout_per_attempt: 15
  total_timeout: 45
`;
    await writeFile(join(tasksDir, "t_test001.yaml"), yamlContent);
    const originalContent = await readFile(join(tasksDir, "t_test001.yaml"), "utf-8");

    const { TaskStore } = await import("../../src/store/task-store.js");
    const store = new TaskStore({ tasksDir, dbPath: join(tempDir, "state.db") });

    // Read the task
    const task = await store.get("t_test001");
    expect(task).not.toBeNull();
    expect(task?.title).toBe("Test task");

    // Update status (should go to SQLite, not YAML)
    await store.updateStatus("t_test001", "generator_running");

    // YAML file must be unchanged
    const afterContent = await readFile(join(tasksDir, "t_test001.yaml"), "utf-8");
    expect(afterContent).toBe(originalContent);
  });

  it("persists runtime state across store instances", async () => {
    const yamlContent = `id: t_persist
title: Persistence test
priority: medium
depends_on: []
agent_prompt: "Test persistence"
exploration_budget:
  max_attempts: 3
  timeout_per_attempt: 15
  total_timeout: 45
`;
    await writeFile(join(tasksDir, "t_persist.yaml"), yamlContent);
    const dbPath = join(tempDir, "state.db");

    const { TaskStore } = await import("../../src/store/task-store.js");

    // First instance: update status
    const store1 = new TaskStore({ tasksDir, dbPath });
    await store1.updateStatus("t_persist", "generator_running");

    // Second instance: should see the updated status
    const store2 = new TaskStore({ tasksDir, dbPath });
    const task = await store2.get("t_persist");
    expect(task).not.toBeNull();
    expect(task?.status).toBe("generator_running");
  });
});
