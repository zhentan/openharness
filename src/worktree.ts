import { execFile as execFileCb } from "node:child_process";
import { access, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { shouldPreserveWorktree, type TaskStatus } from "./types.js";

const execFile = promisify(execFileCb);
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

interface GcTaskLike {
  id: string;
  status: TaskStatus;
}

interface WorktreeMetadata {
  taskId: string;
  repoRoot: string;
}

export async function createWorktree(repoDir: string, taskId: string): Promise<string> {
  validateTaskId(taskId);

  const worktreesRoot = join(repoDir, ".worktrees");
  const worktreePath = join(worktreesRoot, taskId);

  await mkdir(worktreesRoot, { recursive: true });
  await cleanupExistingWorktree(repoDir, worktreePath);

  await execFile("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], { cwd: repoDir });

  await setupDependencyCacheSymlink(repoDir, worktreePath, "node_modules");
  await setupDependencyCacheSymlink(repoDir, worktreePath, join("dashboard", "node_modules"));
  await resetSignalDirectory(worktreePath);
  await writeWorktreeMetadata(worktreePath, { taskId, repoRoot: repoDir });

  return worktreePath;
}

export async function verifyWorktreeMetadata(
  worktreePath: string,
  expected: WorktreeMetadata,
): Promise<void> {
  const metadataPath = join(worktreePath, ".openharness", "worktree-meta.json");
  const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as Partial<WorktreeMetadata>;

  if (parsed.taskId !== expected.taskId || parsed.repoRoot !== expected.repoRoot) {
    throw new Error(
      `Invalid worktree metadata for ${worktreePath}: expected ${expected.taskId} @ ${expected.repoRoot}`,
    );
  }
}

export async function removeWorktree(repoDir: string, taskId: string): Promise<void> {
  const worktreePath = getWorktreePath(repoDir, taskId);
  try {
    await execFile("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoDir });
  } catch {
    await rm(worktreePath, { recursive: true, force: true });
  }
}

export async function worktreeExists(repoDir: string, taskId: string): Promise<boolean> {
  try {
    await access(getWorktreePath(repoDir, taskId));
    return true;
  } catch {
    return false;
  }
}

export async function getWorktreeHead(repoDir: string, taskId: string): Promise<string> {
  const worktreePath = getWorktreePath(repoDir, taskId);
  const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
  return stdout.trim();
}

export async function gcWorktrees(repoDir: string, tasks: GcTaskLike[], mergeQueuedTaskIds: string[] = []): Promise<void> {
  const worktreesRoot = join(repoDir, ".worktrees");
  let entries: string[];
  try {
    entries = await readdir(worktreesRoot);
  } catch {
    return;
  }

  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const mergeQueued = new Set(mergeQueuedTaskIds);

  for (const entry of entries) {
    const task = taskMap.get(entry);
    const worktreePath = join(worktreesRoot, entry);

    if (mergeQueued.has(entry)) {
      continue;
    }

    if (task && shouldPreserveWorktree(task.status)) {
      continue;
    }

    if (await hasLiveRecordedProcess(worktreePath)) {
      continue;
    }

    await removeWorktree(repoDir, entry);
  }
}

async function cleanupExistingWorktree(repoDir: string, worktreePath: string): Promise<void> {
  try {
    await execFile("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoDir });
  } catch {
    // Ignore missing registrations; prune stale metadata and remove any leftover directory.
  }

  try {
    await execFile("git", ["worktree", "prune"], { cwd: repoDir });
  } catch {
    // Ignore prune failures and fall back to removing the directory.
  }

  await rm(worktreePath, { recursive: true, force: true });
}

function getWorktreePath(repoDir: string, taskId: string): string {
  return join(repoDir, ".worktrees", taskId);
}

function validateTaskId(taskId: string): void {
  if (!SAFE_ID.test(taskId)) {
    throw new Error(`Invalid task ID: ${taskId}`);
  }
}

async function setupDependencyCacheSymlink(repoDir: string, worktreePath: string, dirName: string): Promise<void> {
  const source = join(repoDir, dirName);
  try {
    const stat = await lstat(source);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) {
      return;
    }
  } catch {
    return;
  }

  const target = join(worktreePath, dirName);
  await mkdir(join(target, ".."), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await symlink(source, target, "dir");
}

async function resetSignalDirectory(worktreePath: string): Promise<void> {
  const signalDir = join(worktreePath, ".openharness");
  await rm(signalDir, { recursive: true, force: true });
  await mkdir(signalDir, { recursive: true });
}

async function writeWorktreeMetadata(worktreePath: string, metadata: WorktreeMetadata): Promise<void> {
  await writeFile(
    join(worktreePath, ".openharness", "worktree-meta.json"),
    JSON.stringify(metadata, null, 2),
    "utf8",
  );
}

async function hasLiveRecordedProcess(worktreePath: string): Promise<boolean> {
  const signalDir = join(worktreePath, ".openharness");
  for (const fileName of ["pgid", "pid"]) {
    try {
      const raw = await readFile(join(signalDir, fileName), "utf8");
      const pid = Number.parseInt(raw.trim(), 10);
      const isAlive = fileName === "pgid" ? isProcessGroupAlive(pid) : isProcessAlive(pid);
      if (!Number.isNaN(pid) && isAlive) {
        return true;
      }
    } catch {
      // No recorded process for this file name.
    }
  }
  return false;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}
