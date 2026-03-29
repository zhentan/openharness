import { execFile as execFileCb } from "node:child_process";
import { open, readFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { TaskStore } from "./store/task-store.js";
import { validateDependencyGraph } from "./dep-graph.js";
import { loadConfig } from "./config.js";
import { AdapterRegistry } from "./adapters/registry.js";
import type { Task, KernelConfig } from "./types.js";

const execFile = promisify(execFileCb);

// ─── Preflight orchestrator ───

export interface PreflightOptions {
  repoDir: string;
  tasksDir: string;
  dbPath: string;
  lockDir?: string;
  configOverrides?: Partial<import("./types.js").KernelConfig>;
  adapterRegistry?: AdapterRegistry;
  adapterAvailabilityChecker?: AdapterAvailabilityChecker;
}

export interface PreflightResult {
  config: KernelConfig;
  tasks: Task[];
  lock: KernelLock;
}

export type AdapterAvailabilityChecker = (adapter: import("./types.js").AgentAdapter) => Promise<boolean>;

export interface AdapterAvailabilityProbe {
  command: string;
  args: string[];
}

/**
 * Run all startup checks as a single fail-closed path.
 * Order: repo safety → PID lock → load+validate tasks → dep graph.
 * Any failure aborts startup before scheduling begins.
 */
export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  // 1. Config validation (H5 — fail on invalid config before anything else)
  const config = loadConfig(options.configOverrides);

  // 2. Repo safety (H3, H4)
  await validateRepo(options.repoDir);

  // 3. Single-instance lock (H8)
  const lockDir = options.lockDir ?? join(options.repoDir, ".openharness");
  const lock = await acquireKernelLock(lockDir);

  try {
    // 4. Load and validate all tasks (H5 — fail-closed on malformed YAML)
    const store = new TaskStore({ tasksDir: options.tasksDir, dbPath: options.dbPath });
    const tasks = await store.list();

    // 5. Validate dependency graph (H6, H7)
    const depResult = validateDependencyGraph(tasks);
    if (!depResult.valid) {
      const reasons: string[] = [];
      if (depResult.cycles && depResult.cycles.length > 0) {
        reasons.push(`dependency cycles detected: ${depResult.cycles.map((c) => c.join("→")).join("; ")}`);
      }
      if (depResult.missingDeps && depResult.missingDeps.length > 0) {
        reasons.push(`missing dependencies not found: ${depResult.missingDeps.join(", ")}`);
      }
      throw new Error(`Startup failed: invalid dependency graph — ${reasons.join("; ")}`);
    }

    await validateAdapterAvailability(
      config,
      tasks,
      options.adapterRegistry ?? new AdapterRegistry(),
      options.adapterAvailabilityChecker ?? isAdapterAvailable,
    );

    return { config, tasks, lock };
  } catch (err) {
    // Release lock if any downstream check fails
    await releaseKernelLock(lock);
    throw err;
  }
}

export async function validateAdapterAvailability(
  config: Pick<KernelConfig, "defaultAdapter" | "evaluatorAdapter">,
  tasks: Array<Pick<Task, "id" | "title" | "agent" | "evaluator_agent"> & Partial<Task>>,
  registry: AdapterRegistry,
  isAvailable: AdapterAvailabilityChecker = isAdapterAvailable,
): Promise<void> {
  const requiredNames = new Set<string>([config.defaultAdapter, config.evaluatorAdapter]);

  for (const task of tasks) {
    if (task.agent) {
      requiredNames.add(task.agent);
    }
    if (task.evaluator_agent) {
      requiredNames.add(task.evaluator_agent);
    }
  }

  for (const name of requiredNames) {
    const adapter = registry.get(name);
    const available = await isAvailable(adapter);
    if (!available) {
      throw new Error(`Startup failed: adapter '${name}' is not available on this host.`);
    }
  }
}

export function getAvailabilityProbe(adapter: import("./types.js").AgentAdapter): AdapterAvailabilityProbe | undefined {
  if (!adapter.command) {
    return undefined;
  }

  if (adapter.availabilityArgs && adapter.availabilityArgs.length > 0) {
    return {
      command: adapter.command,
      args: adapter.availabilityArgs,
    };
  }

  return {
    command: "which",
    args: [adapter.command],
  };
}

/**
 * Validate that the repo is on main with a clean working tree.
 * Throws on non-main branch or dirty state. Never auto-checkouts.
 */
export async function validateRepo(repoDir: string): Promise<void> {
  const { stdout: branch } = await execFile("git", ["branch", "--show-current"], { cwd: repoDir });
  const currentBranch = branch.trim();

  if (currentBranch !== "main") {
    throw new Error(
      `Startup failed: not on main (currently on '${currentBranch}'). ` +
        `Switch to main before starting the kernel.`,
    );
  }

  const { stdout: status } = await execFile("git", ["status", "--porcelain"], { cwd: repoDir });
  if (status.trim().length > 0) {
    throw new Error(
      `Startup failed: dirty working tree on main. ` +
        `Commit or stash changes before starting the kernel.`,
    );
  }
}

/**
 * Acquire a single-instance PID lock using O_EXCL for atomic creation.
 * If the lock file exists, checks whether the owning process is alive.
 * Returns a lock handle that must be released on shutdown.
 */
export async function acquireKernelLock(lockDir: string): Promise<KernelLock> {
  await mkdir(lockDir, { recursive: true });
  const lockPath = join(lockDir, "kernel.pid");

  // Attempt atomic create — O_EXCL fails if file already exists
  try {
    const fd = await open(lockPath, "wx"); // O_WRONLY | O_CREAT | O_EXCL
    await fd.writeFile(String(process.pid));
    await fd.close();
    return { lockPath, pid: process.pid };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
    // Lock file exists — check if owner is still alive
  }

  // Lock file exists: read PID and check liveness
  let existingPid: number;
  try {
    existingPid = parseInt(await readFile(lockPath, "utf-8"), 10);
  } catch {
    // File disappeared between our O_EXCL attempt and read — retry
    return acquireKernelLock(lockDir);
  }

  if (!Number.isNaN(existingPid) && isProcessAlive(existingPid)) {
    throw new Error(
      `Kernel already running (PID ${existingPid}). ` +
        `Stop the existing instance or remove ${lockPath} if stale.`,
    );
  }

  // Stale lock — remove and retry atomically
  try {
    await unlink(lockPath);
  } catch {
    // Another process may have already cleaned it up
  }
  return acquireKernelLock(lockDir);
}

/**
 * Release the PID lock on shutdown.
 * Only deletes the lock file if it still belongs to this process,
 * preventing a stale cleanup from removing a newer owner's lock.
 */
export async function releaseKernelLock(lock: KernelLock): Promise<void> {
  try {
    const currentPid = parseInt(await readFile(lock.lockPath, "utf-8"), 10);
    if (currentPid !== lock.pid) {
      // Lock was taken over by another process — don't delete it
      return;
    }
    await unlink(lock.lockPath);
  } catch {
    // File already removed or unreadable — nothing to clean up
  }
}

export interface KernelLock {
  lockPath: string;
  pid: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isAdapterAvailable(adapter: import("./types.js").AgentAdapter): Promise<boolean> {
  const probe = getAvailabilityProbe(adapter);
  if (!probe) {
    return true;
  }

  try {
    await execFile(probe.command, probe.args);
    return true;
  } catch {
    return false;
  }
}
