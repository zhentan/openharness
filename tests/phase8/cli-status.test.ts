import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../src/types.js";

describe("Phase 8: CLI status", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "oh-cli-status-"));
    await mkdir(join(repoDir, ".openharness"), { recursive: true });
    await mkdir(join(repoDir, "tasks"), { recursive: true });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("prints task counts and task lines without starting the kernel", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");
    const { runCli } = await import("../../src/cli.js");

    const store = new TaskStore({
      tasksDir: join(repoDir, "tasks"),
      dbPath: join(repoDir, ".openharness", "kernel.db"),
    });

    await writeTaskFile(repoDir, createTask({ id: "task_1", title: "First task", status: "pending" }));
    await writeTaskFile(repoDir, createTask({ id: "task_2", title: "Second task", status: "pending" }));

    await store.updateStatus("task_1", "generator_running", { assignedAt: "2026-03-28T03:00:00.000Z" });
    await store.updateStatus("task_2", "paused");

    const stdout: string[] = [];
    const stderr: string[] = [];
    const startKernelRuntime = vi.fn();

    const exitCode = await runCli(["status"], {
      cwd: () => repoDir,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      startKernelRuntime,
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(startKernelRuntime).not.toHaveBeenCalled();
    expect(stdout.join("\n")).toContain("Task counts:");
    expect(stdout.join("\n")).toContain("generator_running: 1");
    expect(stdout.join("\n")).toContain("paused: 1");
    expect(stdout.join("\n")).toContain("Active tasks:");
    expect(stdout.join("\n")).toContain("task_1  generator_running  First task");
    expect(stdout.join("\n")).toContain("task_1  generator_running  First task");
    expect(stdout.join("\n")).toContain("task_2  paused             Second task");
  });

  it("omits the active-task section when nothing is currently running", async () => {
    const { runCli } = await import("../../src/cli.js");

    await writeTaskFile(repoDir, createTask({ id: "task_1", title: "First task", status: "pending" }));
    await writeTaskFile(repoDir, createTask({ id: "task_2", title: "Second task", status: "pending" }));

    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(["status"], {
      cwd: () => repoDir,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).not.toContain("Active tasks:");
    expect(stdout.join("\n")).toContain("Tasks:");
  });

  it("prints a clear message when no tasks exist", async () => {
    const { runCli } = await import("../../src/cli.js");

    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(["status"], {
      cwd: () => repoDir,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual(["No tasks found."]);
  });

  it("does not initialize runtime state while reading status", async () => {
    const { runCli } = await import("../../src/cli.js");

    await writeTaskFile(repoDir, createTask({ id: "task_1", title: "First task", status: "pending" }));

    const exitCode = await runCli(["status"], {
      cwd: () => repoDir,
      stdout: () => {},
      stderr: () => {},
    });

    const db = new Database(join(repoDir, ".openharness", "kernel.db"));
    const row = db.prepare("SELECT COUNT(*) as count FROM task_state").get() as { count: number };
    db.close();

    expect(exitCode).toBe(0);
    expect(row.count).toBe(0);
  });

  it("prints usage and exits non-zero for unknown subcommands", async () => {
    const { runCli } = await import("../../src/cli.js");

    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(["wat"], {
      cwd: () => repoDir,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Unknown command: wat");
    expect(stderr.join("\n")).toContain("Usage: openharness [start|restart|status|watch|pause|resume|help|stop]");
  });
});

function createTask(overrides: Partial<Task> & Pick<Task, "id" | "title" | "status">): Task {
  return {
    id: overrides.id,
    title: overrides.title,
    status: overrides.status,
    priority: overrides.priority ?? "medium",
    depends_on: overrides.depends_on ?? [],
    agent_prompt: overrides.agent_prompt ?? "Do the thing",
    exploration_budget: overrides.exploration_budget ?? {
      max_attempts: 3,
      timeout_per_attempt: 15,
      total_timeout: 60,
    },
    escalation_rules: overrides.escalation_rules ?? [],
  };
}

async function writeTaskFile(repoDir: string, task: Task): Promise<void> {
  await writeFile(
    join(repoDir, "tasks", `${task.id}.yaml`),
    [
      `id: ${task.id}`,
      `title: ${task.title}`,
      `priority: ${task.priority}`,
      "depends_on: []",
      `agent_prompt: ${JSON.stringify(task.agent_prompt)}`,
      "exploration_budget:",
      `  max_attempts: ${task.exploration_budget.max_attempts}`,
      `  timeout_per_attempt: ${task.exploration_budget.timeout_per_attempt}`,
      `  total_timeout: ${task.exploration_budget.total_timeout}`,
      "escalation_rules: []",
    ].join("\n"),
    "utf8",
  );
}
