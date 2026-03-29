import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Phase 8: push-public script", () => {
  let tempDirs: string[];

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("pushes a filtered snapshot without mutating the caller branch or tripping hooks", async () => {
    const { repoDir, publicRemoteDir } = await createSourceRepo(tempDirs);

    git(repoDir, ["checkout", "-b", "feature/public-sync"]);
    await writeFile(join(repoDir, "feature-only.txt"), "feature branch content\n", "utf8");
    git(repoDir, ["add", "feature-only.txt"]);
    git(repoDir, ["commit", "--no-verify", "-m", "add feature-only file"]);

    const originalBranch = git(repoDir, ["branch", "--show-current"]).trim();

    sh(repoDir, [join(repoDir, "scripts", "push-public.sh")]);

    expect(git(repoDir, ["branch", "--show-current"]).trim()).toBe(originalBranch);
    expect(git(repoDir, ["branch", "--list", "public-push-*"]).trim()).toBe("");

    const publicCloneDir = await mkdtemp(join(tmpdir(), "oh-public-clone-"));
    tempDirs.push(publicCloneDir);
    git(process.cwd(), ["clone", publicRemoteDir, publicCloneDir]);

    expect(await readFile(join(publicCloneDir, "README.md"), "utf8")).toContain("public readme");
    expect(await readFile(join(publicCloneDir, "feature-only.txt"), "utf8")).toContain("feature branch content");
    await expect(readFile(join(publicCloneDir, "docs", "private.md"), "utf8")).rejects.toThrow();
    await expect(readFile(join(publicCloneDir, "scripts", "push-public.sh"), "utf8")).rejects.toThrow();
  });

  it("fails without changing branches or creating temp branches when the public remote push fails", async () => {
    const { repoDir } = await createSourceRepo(tempDirs, { brokenPublicRemote: true });

    git(repoDir, ["checkout", "-b", "feature/public-failure"]);
    const originalBranch = git(repoDir, ["branch", "--show-current"]).trim();

    const output = attemptScript(repoDir, [join(repoDir, "scripts", "push-public.sh")]);

    expect(output).toMatch(/public|push|remote/i);
    expect(git(repoDir, ["branch", "--show-current"]).trim()).toBe(originalBranch);
    expect(git(repoDir, ["branch", "--list", "public-push-*"]).trim()).toBe("");
  });
});

async function createSourceRepo(
  tempDirs: string[],
  options: { brokenPublicRemote?: boolean } = {},
): Promise<{ repoDir: string; publicRemoteDir: string }> {
  const repoDir = await mkdtemp(join(tmpdir(), "oh-push-public-source-"));
  const publicRemoteDir = await mkdtemp(join(tmpdir(), "oh-push-public-remote-"));
  tempDirs.push(repoDir, publicRemoteDir);

  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.name", "OpenHarness Test"]);
  git(repoDir, ["config", "user.email", "openharness-tests@example.com"]);

  await mkdir(join(repoDir, "docs"), { recursive: true });
  await mkdir(join(repoDir, "scripts"), { recursive: true });
  await writeFile(join(repoDir, "README.md"), "public readme\n", "utf8");
  await writeFile(join(repoDir, "docs", "private.md"), "private docs\n", "utf8");
  await writeFile(join(repoDir, ".gitignore"), "node_modules\n", "utf8");
  await copyFile(
    join(process.cwd(), "scripts", "push-public.sh"),
    join(repoDir, "scripts", "push-public.sh"),
  );
  await chmod(join(repoDir, "scripts", "push-public.sh"), 0o755);

  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "init public sync repo"]);

  await installHook(repoDir, "pre-commit");
  await installHook(repoDir, "pre-push");

  git(publicRemoteDir, ["init", "--bare", "-b", "main"]);
  git(repoDir, [
    "remote",
    "add",
    "public",
    options.brokenPublicRemote ? join(publicRemoteDir, "missing", "repo.git") : publicRemoteDir,
  ]);

  return { repoDir, publicRemoteDir };
}

async function installHook(repoDir: string, hookName: "pre-commit" | "pre-push"): Promise<void> {
  const sourcePath = join(process.cwd(), "hooks", hookName);
  const targetPath = join(repoDir, ".git", "hooks", hookName);

  await copyFile(sourcePath, targetPath);
  await chmod(targetPath, 0o755);
}

function git(cwd: string, args: string[], options: Partial<ExecFileSyncOptionsWithStringEncoding> = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    ...options,
  });
}

function sh(cwd: string, args: string[], options: Partial<ExecFileSyncOptionsWithStringEncoding> = {}): string {
  return execFileSync("sh", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
}

function attemptScript(cwd: string, args: string[]): string {
  try {
    sh(cwd, args);
  } catch (error) {
    return extractCommandOutput(error);
  }

  throw new Error("expected script to fail");
}

function extractCommandOutput(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const failure = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
  return `${bufferToString(failure.stdout)}\n${bufferToString(failure.stderr)}`.trim();
}

function bufferToString(value: string | Buffer | undefined): string {
  if (typeof value === "string") {
    return value;
  }

  return value?.toString("utf8") ?? "";
}
