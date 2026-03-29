/**
 * P16: Pre-commit/pre-push hooks block bad context
 *
 * v1 proof: hooks/pre-commit, hooks/pre-push
 * Phase gate: 3
 *
 * The pre-commit hook must actually block commits from detached HEAD,
 * non-main branches, and any linked worktree (.git is a file there).
 * Commits from the main branch in the primary repo are allowed.
 *
 * The pre-push hook must run the same safety gates v1 relied on:
 * `tsc --noEmit` and `vitest run`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { mkdtemp, stat } from "node:fs/promises";

describe("P16: Git hooks block bad context", () => {
  let tempDirs: string[];

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("pre-commit blocks commits from detached HEAD", async () => {
    const repoDir = await createRepoWithHooks(tempDirs);

    git(repoDir, ["checkout", "--detach", "HEAD"]);

    const output = attemptEmptyCommit(repoDir, "detached head commit");
    expect(output).toMatch(/detached head/i);
  });

  it("pre-commit blocks commits from non-main branches", async () => {
    const repoDir = await createRepoWithHooks(tempDirs);

    git(repoDir, ["checkout", "-b", "feature/test-hooks"]);

    const output = attemptEmptyCommit(repoDir, "feature branch commit");
    expect(output).toMatch(/main branch|on main/i);
  });

  it("pre-commit blocks commits from linked worktrees", async () => {
    const repoDir = await createRepoWithHooks(tempDirs);
    const worktreeDir = await mkdtemp(join(tmpdir(), "oh-hook-worktree-"));
    tempDirs.push(worktreeDir);

    git(repoDir, ["worktree", "add", "--force", worktreeDir, "main"]);

    const gitMetadata = await stat(join(worktreeDir, ".git"));
    expect(gitMetadata.isFile()).toBe(true);

    const output = attemptEmptyCommit(worktreeDir, "worktree commit");
    expect(output).toMatch(/worktree/i);
  });

  it("pre-commit allows commits on main in the primary repo", async () => {
    const repoDir = await createRepoWithHooks(tempDirs);

    git(repoDir, ["commit", "--allow-empty", "-m", "main branch commit"]);

    const commitCount = Number.parseInt(git(repoDir, ["rev-list", "--count", "HEAD"]).trim(), 10);
    expect(commitCount).toBe(2);
  });

  it("pre-push runs the required typecheck and test commands", async () => {
    const hookContent = await readFile(join(process.cwd(), "hooks", "pre-push"), "utf8");

    expect(hookContent).toMatch(/\btsc\s+--noEmit\b/);
    expect(hookContent).toMatch(/\bvitest\s+run\b/);
  });

  it("pre-push blocks pushes from detached HEAD", async () => {
    const repoDir = await createRepoWithHooks(tempDirs);
    git(repoDir, ["checkout", "--detach", "HEAD"]);

    const result = await attemptPrePush(repoDir, tempDirs);
    expect(result.output).toMatch(/detached head/i);
    expect(result.npxLog).toBe("");
  });

  it("pre-push blocks pushes from non-main branches", async () => {
    const repoDir = await createRepoWithHooks(tempDirs);
    git(repoDir, ["checkout", "-b", "feature/pre-push-check"]);

    const result = await attemptPrePush(repoDir, tempDirs);
    expect(result.output).toMatch(/main branch|on main/i);
    expect(result.npxLog).toBe("");
  });

  it("pre-push blocks pushes from linked worktrees", async () => {
    const repoDir = await createRepoWithHooks(tempDirs);
    const worktreeDir = await mkdtemp(join(tmpdir(), "oh-pre-push-worktree-"));
    tempDirs.push(worktreeDir);

    git(repoDir, ["worktree", "add", "--force", worktreeDir, "main"]);

    const result = await attemptPrePush(worktreeDir, tempDirs);
    expect(result.output).toMatch(/worktree/i);
    expect(result.npxLog).toBe("");
  });
});

function git(cwd: string, args: string[], options: Partial<ExecFileSyncOptionsWithStringEncoding> = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    ...options,
  });
}

async function createRepoWithHooks(tempDirs: string[]): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "oh-hook-repo-"));
  tempDirs.push(repoDir);

  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.name", "OpenHarness Test"]);
  git(repoDir, ["config", "user.email", "openharness-tests@example.com"]);
  git(repoDir, ["commit", "--allow-empty", "-m", "init"]);

  await installHook(repoDir, "pre-commit");
  await installHook(repoDir, "pre-push");

  return repoDir;
}

async function installHook(repoDir: string, hookName: "pre-commit" | "pre-push"): Promise<void> {
  const sourcePath = join(process.cwd(), "hooks", hookName);
  const targetPath = join(repoDir, ".git", "hooks", hookName);

  await copyFile(sourcePath, targetPath);
  await chmod(targetPath, 0o755);
}

function attemptEmptyCommit(cwd: string, message: string): string {
  try {
    git(cwd, ["commit", "--allow-empty", "-m", message], { stdio: "pipe" });
  } catch (error) {
    return extractCommandOutput(error);
  }

  throw new Error("expected commit to be blocked by pre-commit hook");
}

async function attemptPrePush(cwd: string, tempDirs: string[]): Promise<{ output: string; npxLog: string }> {
  const binDir = await mkdtemp(join(tmpdir(), "oh-pre-push-bin-"));
  tempDirs.push(binDir);

  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(binDir, "npx"),
    "#!/bin/sh\necho \"npx $*\" >> \"$OH_PRE_PUSH_LOG\"\nexit 0\n",
    "utf8",
  );
  await chmod(join(binDir, "npx"), 0o755);

  const logPath = join(binDir, "pre-push.log");

  const hookPath = git(cwd, ["rev-parse", "--git-path", "hooks/pre-push"]).trim();
  const executablePath = isAbsolute(hookPath) ? hookPath : join(cwd, hookPath);

  try {
    execFileSync(executablePath, [], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        OH_PRE_PUSH_LOG: logPath,
      },
    });
  } catch (error) {
    return {
      output: extractCommandOutput(error),
      npxLog: await readOptionalFile(logPath),
    };
  }

  return {
    output: await readOptionalFile(logPath),
    npxLog: await readOptionalFile(logPath),
  };
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function extractCommandOutput(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const failure = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
  const stdout = bufferToString(failure.stdout);
  const stderr = bufferToString(failure.stderr);
  return `${stdout}\n${stderr}`.trim();
}

function bufferToString(value: string | Buffer | undefined): string {
  if (typeof value === "string") {
    return value;
  }

  return value?.toString("utf8") ?? "";
}
