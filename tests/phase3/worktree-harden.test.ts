/**
 * H15: GC uses liveness probe, not teardown
 * H17: Signal file cleanup on worktree creation
 * H20: Symlinks restricted to approved dependency caches only
 *
 * Phase gate: 3
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";

describe("Phase 3 hardening: worktrees", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "oh-phase3-"));
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "OpenHarness Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoDir });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("symlinks approved dependency caches only, not other ignored directories", async () => {
    const { createWorktree } = await import("../../src/worktree.js");

    await writeFile(join(repoDir, ".gitignore"), "node_modules/\ncoverage/\n.openharness/\n");
    await mkdir(join(repoDir, "node_modules"), { recursive: true });
    await mkdir(join(repoDir, "dashboard", "node_modules"), { recursive: true });
    await mkdir(join(repoDir, "coverage"), { recursive: true });
    await mkdir(join(repoDir, ".openharness"), { recursive: true });

    const wtPath = await createWorktree(repoDir, "t_harden_symlink");

    expect((await lstat(join(wtPath, "node_modules"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(wtPath, "dashboard", "node_modules"))).isSymbolicLink()).toBe(true);
    await expect(lstat(join(wtPath, "coverage"))).rejects.toThrow();
  });

  it("creates an empty local .openharness directory instead of inheriting stale signal files", async () => {
    const { createWorktree } = await import("../../src/worktree.js");

    await writeFile(join(repoDir, ".gitignore"), "node_modules/\n.openharness/\n");
    await mkdir(join(repoDir, "node_modules"), { recursive: true });
    await mkdir(join(repoDir, ".openharness"), { recursive: true });
    await writeFile(join(repoDir, ".openharness", "completion.json"), '{"status":"completed"}');

    const wtPath = await createWorktree(repoDir, "t_signal_cleanup");

    const signalDirStat = await lstat(join(wtPath, ".openharness"));
    expect(signalDirStat.isDirectory()).toBe(true);
    expect(signalDirStat.isSymbolicLink()).toBe(false);
    expect(await readdir(join(wtPath, ".openharness"))).toEqual(["worktree-meta.json"]);
  });

  it("writes a worktree sentinel that binds the directory to the task and repo root", async () => {
    const { createWorktree } = await import("../../src/worktree.js");

    const wtPath = await createWorktree(repoDir, "t_sentinel");

    const sentinel = JSON.parse(
      await readFile(join(wtPath, ".openharness", "worktree-meta.json"), "utf8"),
    ) as { taskId: string; repoRoot: string };

    expect(sentinel).toEqual({
      taskId: "t_sentinel",
      repoRoot: repoDir,
    });
  });

  it("preserves a terminal-task worktree when its recorded process is still alive", async () => {
    const { createWorktree, gcWorktrees, worktreeExists } = await import("../../src/worktree.js");

    const wtPath = await createWorktree(repoDir, "t_live_terminal");
    const sleeper = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    sleeper.unref();
    try {
      await writeFile(join(wtPath, ".openharness", "pgid"), String(sleeper.pid));

      await gcWorktrees(repoDir, [{ id: "t_live_terminal", status: "merged" as const }], []);

      expect(await worktreeExists(repoDir, "t_live_terminal")).toBe(true);
    } finally {
      if (sleeper.pid !== undefined) {
        try {
          process.kill(-sleeper.pid, "SIGKILL");
        } catch {
          // Process group already exited.
        }
      }
    }
  });

  it("probes pgid liveness using a negative process-group signal", async () => {
    const { createWorktree, gcWorktrees, worktreeExists } = await import("../../src/worktree.js");

    const wtPath = await createWorktree(repoDir, "t_live_pgid");
    await writeFile(join(wtPath, ".openharness", "pgid"), "4321");

    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === -4321 && signal === 0) {
        return true;
      }
      throw new Error(`unexpected probe: ${String(pid)} ${String(signal)}`);
    }) as typeof process.kill);

    try {
      await gcWorktrees(repoDir, [{ id: "t_live_pgid", status: "merged" as const }], []);

      expect(await worktreeExists(repoDir, "t_live_pgid")).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(-4321, 0);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("replaces a stale worktree registration before recreating the worktree path", async () => {
    const { createWorktree, removeWorktree, worktreeExists } = await import("../../src/worktree.js");

    await createWorktree(repoDir, "t_stale_record");
    await removeWorktree(repoDir, "t_stale_record");
    await mkdir(join(repoDir, ".worktrees", "t_stale_record"), { recursive: true });
    await writeFile(join(repoDir, ".worktrees", "t_stale_record", "stale.txt"), "stale");

    const wtPath = await createWorktree(repoDir, "t_stale_record");

    expect(await worktreeExists(repoDir, "t_stale_record")).toBe(true);
    await expect(lstat(join(wtPath, "stale.txt"))).rejects.toThrow();
  });
});
