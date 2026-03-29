/**
 * P1: Detached HEAD worktrees (no branches created)
 *
 * v1 proof: src/worktree.ts:41 — git worktree add --detach
 * v1 bug: #6 — agent branches switched main repo HEAD
 * Phase gate: 3
 *
 * Each agent runs in a detached HEAD worktree. No branches are created.
 * This eliminates branch contamination, stale branch errors, and HEAD switching.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

describe("P1: Detached HEAD worktrees", () => {
  let repoDir: string;

  beforeEach(async () => {
    // Create a real git repo for worktree tests
    repoDir = await mkdtemp(join(tmpdir(), "oh-wt-test-"));
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "OpenHarness Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoDir });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("creates a worktree in detached HEAD state", async () => {
    const { createWorktree } = await import("../../src/worktree.js");
    const wtPath = await createWorktree(repoDir, "t_test001");

    // Verify the worktree is in detached HEAD (no branch)
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: wtPath, encoding: "utf-8" }).trim();
    expect(branch).toBe(""); // detached HEAD has no current branch
  });

  it("does not create any new branches in the main repo", async () => {
    const { createWorktree } = await import("../../src/worktree.js");

    const branchesBefore = execFileSync("git", ["branch", "--list"], { cwd: repoDir, encoding: "utf-8" }).trim();
    await createWorktree(repoDir, "t_test002");
    const branchesAfter = execFileSync("git", ["branch", "--list"], { cwd: repoDir, encoding: "utf-8" }).trim();

    expect(branchesAfter).toBe(branchesBefore);
  });
});
