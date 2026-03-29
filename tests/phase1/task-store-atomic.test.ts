/**
 * H1: Runtime state in SQLite (WAL mode) — atomicity, concurrency, durability
 * H2: Concurrent state access safety
 *
 * Phase gate: 1
 *
 * SQLite in WAL mode provides atomic writes, concurrent read access,
 * and crash-safe durability without custom file locking.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("H1+H2: SQLite-backed runtime state", () => {
  let tempDir: string;
  let tasksDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "oh-h1-"));
    tasksDir = join(tempDir, "tasks");
    dbPath = join(tempDir, "state.db");
    await mkdir(tasksDir, { recursive: true });

    await writeFile(
      join(tasksDir, "t_atomic.yaml"),
      `id: t_atomic
title: Atomic test
priority: high
depends_on: []
agent_prompt: "test"
exploration_budget:
  max_attempts: 3
  timeout_per_attempt: 15
  total_timeout: 45
`,
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("uses SQLite for runtime state storage", async () => {
    const { default: Database } = await import("better-sqlite3");
    const { TaskStore } = await import("../../src/store/task-store.js");
    const store = new TaskStore({ tasksDir, dbPath });

    await store.updateStatus("t_atomic", "reserved");

    // The DB file should exist
    const { access } = await import("node:fs/promises");
    await expect(access(dbPath)).resolves.toBeUndefined();

    const db = new Database(dbPath, { readonly: true });
    const journalMode = db.pragma("journal_mode", { simple: true });

    expect(journalMode).toBe("wal");

    db.close();
    store.close();
  });

  it("survives concurrent reads from two store instances", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");

    const store1 = new TaskStore({ tasksDir, dbPath });
    const store2 = new TaskStore({ tasksDir, dbPath });

    await store1.updateStatus("t_atomic", "generator_running");

    // Both instances should see the same state
    const [task1, task2] = await Promise.all([
      store1.get("t_atomic"),
      store2.get("t_atomic"),
    ]);

    expect(task1?.status).toBe("generator_running");
    expect(task2?.status).toBe("generator_running");
  });

  it("state persists after store is closed and reopened", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");

    const store1 = new TaskStore({ tasksDir, dbPath });
    await store1.updateStatus("t_atomic", "completed");
    store1.close();

    const store2 = new TaskStore({ tasksDir, dbPath });
    const task = await store2.get("t_atomic");
    expect(task?.status).toBe("completed");
    store2.close();
  });

  it("preserves enqueued_at when runtime state is created before the first list call", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");

    const store = new TaskStore({ tasksDir, dbPath });

    await store.updateStatus("t_atomic", "reserved");

    const task = await store.get("t_atomic");
    const enqueuedAt = task?.enqueued_at;

    await store.updateStatus("t_atomic", "generator_running");

    const updatedTask = await store.get("t_atomic");

    expect(task?.status).toBe("reserved");
    expect(enqueuedAt).toEqual(expect.any(String));
    expect(updatedTask?.status).toBe("generator_running");
    expect(updatedTask?.enqueued_at).toBe(enqueuedAt);

    store.close();
  });

  it("migrates older task_state schemas that do not yet have enqueued_at", async () => {
    const { rm } = await import("node:fs/promises");
    const { default: Database } = await import("better-sqlite3");
    const { TaskStore } = await import("../../src/store/task-store.js");

    await rm(dbPath, { force: true });

    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE task_state (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        current_attempt INTEGER NOT NULL DEFAULT 1,
        previous_attempts TEXT NOT NULL DEFAULT '[]',
        assigned_at TEXT,
        completed_at TEXT,
        cooldown_until TEXT,
        crash_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    legacyDb.close();

    const store = new TaskStore({ tasksDir, dbPath });

    const tasks = await store.list();

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("t_atomic");
    expect(tasks[0]?.enqueued_at).toEqual(expect.any(String));

    store.close();
  });

  it("backfills enqueued_at for legacy rows where the column exists but the value is null", async () => {
    const { rm } = await import("node:fs/promises");
    const { default: Database } = await import("better-sqlite3");
    const { TaskStore } = await import("../../src/store/task-store.js");

    await rm(dbPath, { force: true });

    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE task_state (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        current_attempt INTEGER NOT NULL DEFAULT 1,
        previous_attempts TEXT NOT NULL DEFAULT '[]',
        enqueued_at TEXT,
        assigned_at TEXT,
        completed_at TEXT,
        cooldown_until TEXT,
        crash_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    legacyDb
      .prepare(
        `INSERT INTO task_state (id, status, current_attempt, previous_attempts, enqueued_at, crash_count)
         VALUES (?, 'pending', 1, '[]', NULL, 0)`,
      )
      .run("t_atomic");
    legacyDb.close();

    const store = new TaskStore({ tasksDir, dbPath });

    const task = await store.get("t_atomic");

    expect(task?.id).toBe("t_atomic");
    expect(task?.enqueued_at).toEqual(expect.any(String));

    store.close();

    const reopenedDb = new Database(dbPath, { readonly: true });
    const row = reopenedDb
      .prepare("SELECT enqueued_at FROM task_state WHERE id = ?")
      .get("t_atomic") as { enqueued_at: string | null } | undefined;

    expect(row?.enqueued_at).toEqual(expect.any(String));

    reopenedDb.close();
  });

  it("can persist a recurring follow-up task definition without mutating the source task file", async () => {
    const { readFile } = await import("node:fs/promises");
    const { TaskStore } = await import("../../src/store/task-store.js");

    const sourceTaskPath = join(tasksDir, "t_atomic.yaml");
    const originalSourceYaml = await readFile(sourceTaskPath, "utf-8");

    const store = new TaskStore({ tasksDir, dbPath });

    await store.createTask({
      id: "t_atomic_fix_1",
      source_task_id: "t_atomic",
      title: "Fix flaky eval",
      status: "pending",
      priority: "high",
      depends_on: [],
      agent_prompt: "Fix flaky eval",
      exploration_budget: { max_attempts: 3, timeout_per_attempt: 15, total_timeout: 45 },
      escalation_rules: [],
    });

    const created = await store.get("t_atomic_fix_1");
    expect(created).not.toBeNull();
    expect(created?.source_task_id).toBe("t_atomic");
    expect(created?.status).toBe("pending");

    const sourceYamlAfter = await readFile(sourceTaskPath, "utf-8");
    expect(sourceYamlAfter).toBe(originalSourceYaml);
  });

  it("persists crash_count updates passed via updateStatus metadata", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");

    const store = new TaskStore({ tasksDir, dbPath });

    await store.updateStatus("t_atomic", "retry_pending", {
      crashCount: 2,
    });

    const task = await store.get("t_atomic");

    expect(task?.status).toBe("retry_pending");
    expect(task?.crash_count).toBe(2);

    store.close();
  });

  it("omits undefined optional fields from persisted follow-up task YAML", async () => {
    const { readFile } = await import("node:fs/promises");
    const { TaskStore } = await import("../../src/store/task-store.js");

    const store = new TaskStore({ tasksDir, dbPath });

    await store.createTask({
      id: "t_atomic_fix_sparse",
      source_task_id: "t_atomic",
      title: "Sparse follow-up",
      status: "pending",
      priority: "medium",
      depends_on: [],
      agent_prompt: "Investigate sparse follow-up",
      exploration_budget: { max_attempts: 2, timeout_per_attempt: 10, total_timeout: 20 },
      escalation_rules: [],
    });

    const createdYaml = await readFile(join(tasksDir, "t_atomic_fix_sparse.yaml"), "utf-8");

    expect(createdYaml).toContain("source_task_id: t_atomic");
    expect(createdYaml).not.toContain("evaluate:");
    expect(createdYaml).not.toContain("agent:");
    expect(createdYaml).not.toContain("evaluator_agent:");
    expect(createdYaml).not.toContain("success_criteria:");
    expect(createdYaml).not.toContain("recurring:");
    expect(createdYaml).not.toContain("recurring_interval_hours:");
    expect(createdYaml).not.toContain(": null");
  });
});
