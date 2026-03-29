/**
 * P3: GC preserves completed/running worktrees
 *
 * v1 proof: src/kernel.ts:209 — skip if runningIds/completedIds has taskId
 * v1 bug: #2 — GC deleted worktrees needed for merge retry
 * Phase gate: 3
 *
 * The garbage collector must ONLY remove worktrees for tasks in terminal
 * states (merged, escalated) or unknown tasks. It must preserve worktrees
 * for pending, running, completed (awaiting merge), and reserved tasks.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

describe("P3: GC preserves needed worktrees", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "oh-gc-test-"));
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "OpenHarness Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoDir });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("removes worktrees for merged tasks", async () => {
    const { createWorktree, gcWorktrees, worktreeExists } = await import("../../src/worktree.js");

    await createWorktree(repoDir, "t_merged");
    expect(await worktreeExists(repoDir, "t_merged")).toBe(true);

    const tasks = [{ id: "t_merged", status: "merged" as const }];
    await gcWorktrees(repoDir, tasks, []);

    expect(await worktreeExists(repoDir, "t_merged")).toBe(false);
  });

  it("removes worktrees for escalated tasks", async () => {
    const { createWorktree, gcWorktrees, worktreeExists } = await import("../../src/worktree.js");

    await createWorktree(repoDir, "t_escalated");

    const tasks = [{ id: "t_escalated", status: "escalated" as const }];
    await gcWorktrees(repoDir, tasks, []);

    expect(await worktreeExists(repoDir, "t_escalated")).toBe(false);
  });

  it("preserves worktrees for completed tasks (awaiting merge)", async () => {
    const { createWorktree, gcWorktrees, worktreeExists } = await import("../../src/worktree.js");

    await createWorktree(repoDir, "t_completed");

    const tasks = [{ id: "t_completed", status: "completed" as const }];
    await gcWorktrees(repoDir, tasks, []);

    expect(await worktreeExists(repoDir, "t_completed")).toBe(true);
  });

  it("preserves worktrees for running tasks", async () => {
    const { createWorktree, gcWorktrees, worktreeExists } = await import("../../src/worktree.js");

    await createWorktree(repoDir, "t_running");

    const tasks = [{ id: "t_running", status: "generator_running" as const }];
    await gcWorktrees(repoDir, tasks, []);

    expect(await worktreeExists(repoDir, "t_running")).toBe(true);
  });

  it("preserves worktrees for retry_pending tasks (may need worktree for next attempt)", async () => {
    const { createWorktree, gcWorktrees, worktreeExists } = await import("../../src/worktree.js");

    await createWorktree(repoDir, "t_retry");

    const tasks = [{ id: "t_retry", status: "retry_pending" as const }];
    await gcWorktrees(repoDir, tasks, []);

    expect(await worktreeExists(repoDir, "t_retry")).toBe(true);
  });

  it("preserves worktrees that are queued for merge even if their task is terminal", async () => {
    const { createWorktree, gcWorktrees, worktreeExists } = await import("../../src/worktree.js");

    await createWorktree(repoDir, "t_merge_queued");

    const tasks = [{ id: "t_merge_queued", status: "merged" as const }];
    await gcWorktrees(repoDir, tasks, ["t_merge_queued"]);

    expect(await worktreeExists(repoDir, "t_merge_queued")).toBe(true);
  });

  it("preserves worktrees for paused tasks (human may inspect)", async () => {
    const { createWorktree, gcWorktrees, worktreeExists } = await import("../../src/worktree.js");

    await createWorktree(repoDir, "t_paused");

    const tasks = [{ id: "t_paused", status: "paused" as const }];
    await gcWorktrees(repoDir, tasks, []);

    expect(await worktreeExists(repoDir, "t_paused")).toBe(true);
  });
});
