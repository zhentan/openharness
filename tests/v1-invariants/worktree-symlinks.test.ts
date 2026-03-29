/**
 * P2: Symlinked dependency cache in worktrees
 *
 * v1 proof: src/worktree.ts:74-114 — symlinkIgnoredDirs()
 * Phase gate: 3
 *
 * After creating a worktree, the dependency cache from the main repo
 * is symlinked into the worktree to avoid slow reinstalls.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

describe("P2: Symlinked dependency cache", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "oh-sym-test-"));
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "OpenHarness Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoDir });

    await writeFile(join(repoDir, ".gitignore"), "node_modules/\ncoverage/\n");
    await mkdir(join(repoDir, "node_modules"), { recursive: true });
    await mkdir(join(repoDir, "coverage"), { recursive: true });
    await writeFile(join(repoDir, "node_modules", "placeholder"), "test");
    await writeFile(join(repoDir, "coverage", "placeholder"), "test");
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("symlinks node_modules from the main repo into the worktree", async () => {
    const { createWorktree } = await import("../../src/worktree.js");
    const wtPath = await createWorktree(repoDir, "t_symtest");

    const nodeModulesStat = await lstat(join(wtPath, "node_modules"));

    expect(nodeModulesStat.isSymbolicLink()).toBe(true);
  });

  it("symlinks dashboard/node_modules into the worktree when the dashboard package exists", async () => {
    const { createWorktree } = await import("../../src/worktree.js");
    await mkdir(join(repoDir, "dashboard", "node_modules"), { recursive: true });
    await writeFile(join(repoDir, "dashboard", "node_modules", "placeholder"), "test");

    const wtPath = await createWorktree(repoDir, "t_dashboard_symtest");

    const dashboardNodeModulesStat = await lstat(join(wtPath, "dashboard", "node_modules"));

    expect(dashboardNodeModulesStat.isSymbolicLink()).toBe(true);
  });
});
