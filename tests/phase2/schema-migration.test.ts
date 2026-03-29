/**
 * Regression test: schema migration backfills enqueued_at for existing rows.
 *
 * This bug regressed across two commits — the column was added without
 * backfilling existing rows, leaving starvation scoring silently broken
 * for migrated databases. This test creates a pre-migration schema and
 * verifies the migration path end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

describe("Schema migration: enqueued_at backfill", () => {
  let tempDir: string;
  let tasksDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "oh-migration-"));
    tasksDir = join(tempDir, "tasks");
    dbPath = join(tempDir, "state.db");
    await mkdir(tasksDir, { recursive: true });

    // Write a valid task YAML
    await writeFile(
      join(tasksDir, "t_existing.yaml"),
      `id: t_existing\ntitle: Existing task\npriority: high\ndepends_on: []\nagent_prompt: "test"\nexploration_budget:\n  max_attempts: 3\n  timeout_per_attempt: 15\n  total_timeout: 45\n`,
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("migrates a pre-enqueued_at database and backfills existing rows", async () => {
    // Create a database with the OLD schema (no enqueued_at column)
    const oldDb = new Database(dbPath);
    oldDb.exec(`
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
    // Insert a row with the old schema (no enqueued_at)
    oldDb.prepare(
      "INSERT INTO task_state (id, status, current_attempt) VALUES (?, ?, ?)",
    ).run("t_existing", "pending", 2);
    oldDb.close();

    // Now open with the new TaskStore — should migrate and backfill
    const { TaskStore } = await import("../../src/store/task-store.js");
    const store = new TaskStore({ tasksDir, dbPath });

    const task = await store.get("t_existing");
    expect(task).not.toBeNull();
    expect(task?.enqueued_at).toBeTruthy();
    expect(task?.status).toBe("pending");
    expect(task?.current_attempt).toBe(2);
    store.close();
  });

  it("does not overwrite enqueued_at for rows that already have it", async () => {
    // Create a database WITH enqueued_at (current schema)
    const { TaskStore } = await import("../../src/store/task-store.js");
    const store1 = new TaskStore({ tasksDir, dbPath });

    // First list populates enqueued_at via initializeState
    await store1.list();
    const task1 = await store1.get("t_existing");
    const originalEnqueuedAt = task1?.enqueued_at;
    expect(originalEnqueuedAt).toBeTruthy();
    store1.close();

    // Wait briefly so timestamps would differ if overwritten
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Reopen — migration should NOT overwrite the existing enqueued_at
    const store2 = new TaskStore({ tasksDir, dbPath });
    const task2 = await store2.get("t_existing");
    expect(task2?.enqueued_at).toBe(originalEnqueuedAt);
    store2.close();
  });
});
