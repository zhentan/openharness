/**
 * H3: Startup fails on non-main branch
 * H4: Startup fails on dirty working tree (any branch)
 * H5: Config/task schema validation at startup
 * H8: Single-instance kernel lock
 *
 * Phase gate: 1
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const GIT_TEST_TIMEOUT_MS = 15_000;

describe("H3+H4: Startup git safety", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "oh-startup-"));
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "OpenHarness Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoDir });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("fails startup on non-main branch", async () => {
    const { validateRepo } = await import("../../src/startup.js");

    execFileSync("git", ["checkout", "-b", "feature/test"], { cwd: repoDir });

    await expect(validateRepo(repoDir)).rejects.toThrow(/not on main/i);
  }, GIT_TEST_TIMEOUT_MS);

  it("fails startup on dirty working tree (even on main)", async () => {
    const { validateRepo } = await import("../../src/startup.js");

    await writeFile(join(repoDir, "dirty.txt"), "uncommitted");

    await expect(validateRepo(repoDir)).rejects.toThrow(/dirty|uncommitted/i);
  }, GIT_TEST_TIMEOUT_MS);

  it("passes startup on clean main branch", async () => {
    const { validateRepo } = await import("../../src/startup.js");

    await expect(validateRepo(repoDir)).resolves.toBeUndefined();
  }, GIT_TEST_TIMEOUT_MS);
});

describe("H5: Config/task schema validation", () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "oh-schema-"));
    tasksDir = join(tempDir, "tasks");
    await mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fails on task YAML missing required fields", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");

    await writeFile(
      join(tasksDir, "bad.yaml"),
      `title: Missing ID and other fields\n`,
    );

    const store = new TaskStore({ tasksDir, dbPath: join(tempDir, "state.db") });

    try {
      // Malformed task definitions are the executable workload — fail-closed
      await expect(store.list()).rejects.toThrow(/invalid task/i);
    } finally {
      store.close();
    }
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on task YAML with invalid priority", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");

    await writeFile(
      join(tasksDir, "bad-priority.yaml"),
      `id: t_bad_priority
title: Bad priority
priority: urgent
depends_on: []
agent_prompt: "test"
exploration_budget:
  max_attempts: 3
  timeout_per_attempt: 15
  total_timeout: 45
`,
    );

    const store = new TaskStore({ tasksDir, dbPath: join(tempDir, "state.db") });

    try {
      await expect(store.list()).rejects.toThrow(/invalid task|invalid priority/i);
    } finally {
      store.close();
    }
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on task YAML with non-array depends_on", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");

    await writeFile(
      join(tasksDir, "bad-deps.yaml"),
      `id: t_bad_deps
title: Bad deps
priority: high
depends_on: t_other
agent_prompt: "test"
exploration_budget:
  max_attempts: 3
  timeout_per_attempt: 15
  total_timeout: 45
`,
    );

    const store = new TaskStore({ tasksDir, dbPath: join(tempDir, "state.db") });

    try {
      await expect(store.list()).rejects.toThrow(/invalid task|depends_on/i);
    } finally {
      store.close();
    }
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on task YAML with invalid task IDs inside depends_on", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");

    await writeFile(
      join(tasksDir, "bad-dep-id.yaml"),
      `id: t_bad_dep_id
title: Bad dep id
priority: high
depends_on:
  - ../oops
agent_prompt: "test"
exploration_budget:
  max_attempts: 3
  timeout_per_attempt: 15
  total_timeout: 45
`,
    );

    const store = new TaskStore({ tasksDir, dbPath: join(tempDir, "state.db") });

    try {
      await expect(store.list()).rejects.toThrow(/invalid task|depends_on/i);
    } finally {
      store.close();
    }
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on task YAML with non-positive exploration_budget.max_attempts", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");

    await writeFile(
      join(tasksDir, "bad-budget.yaml"),
      `id: t_bad_budget
title: Bad budget
priority: high
depends_on: []
agent_prompt: "test"
exploration_budget:
  max_attempts: 0
  timeout_per_attempt: 15
  total_timeout: 45
`,
    );

    const store = new TaskStore({ tasksDir, dbPath: join(tempDir, "state.db") });

    try {
      await expect(store.list()).rejects.toThrow(/invalid task|max_attempts/i);
    } finally {
      store.close();
    }
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on task YAML with non-positive exploration_budget timeouts", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");

    await writeFile(
      join(tasksDir, "bad-timeout-budget.yaml"),
      `id: t_bad_timeout_budget
title: Bad timeout budget
priority: high
depends_on: []
agent_prompt: "test"
exploration_budget:
  max_attempts: 3
  timeout_per_attempt: 0
  total_timeout: -1
`,
    );

    const store = new TaskStore({ tasksDir, dbPath: join(tempDir, "state.db") });

    try {
      await expect(store.list()).rejects.toThrow(/invalid task|timeout/i);
    } finally {
      store.close();
    }
  }, GIT_TEST_TIMEOUT_MS);

  it("fails when timeout_per_attempt exceeds total_timeout", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");

    await writeFile(
      join(tasksDir, "inconsistent-budget.yaml"),
      `id: t_inconsistent_budget
title: Inconsistent budget
priority: high
depends_on: []
agent_prompt: "test"
exploration_budget:
  max_attempts: 3
  timeout_per_attempt: 60
  total_timeout: 45
`,
    );

    const store = new TaskStore({ tasksDir, dbPath: join(tempDir, "state.db") });

    try {
      await expect(store.list()).rejects.toThrow(/invalid task|total_timeout|timeout_per_attempt/i);
    } finally {
      store.close();
    }
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on task YAML with non-string agent override", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");

    await writeFile(
      join(tasksDir, "bad-agent-type.yaml"),
      `id: t_bad_agent_type
title: Bad agent override
priority: high
depends_on: []
agent: 42
agent_prompt: "test"
exploration_budget:
  max_attempts: 3
  timeout_per_attempt: 15
  total_timeout: 45
`,
    );

    const store = new TaskStore({ tasksDir, dbPath: join(tempDir, "state.db") });

    try {
      await expect(store.list()).rejects.toThrow(/invalid task|agent/i);
    } finally {
      store.close();
    }
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on task YAML with non-string evaluator_agent override", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");

    await writeFile(
      join(tasksDir, "bad-evaluator-agent-type.yaml"),
      `id: t_bad_evaluator_agent_type
title: Bad evaluator override
priority: high
depends_on: []
evaluator_agent: 42
agent_prompt: "test"
exploration_budget:
  max_attempts: 3
  timeout_per_attempt: 15
  total_timeout: 45
`,
    );

    const store = new TaskStore({ tasksDir, dbPath: join(tempDir, "state.db") });

    try {
      await expect(store.list()).rejects.toThrow(/invalid task|evaluator_agent/i);
    } finally {
      store.close();
    }
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on task YAML with negative recurring_interval_hours", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");

    await writeFile(
      join(tasksDir, "bad-recurring-interval.yaml"),
      `id: t_bad_recurring_interval
title: Bad recurring interval
priority: high
depends_on: []
agent_prompt: "test"
recurring: true
recurring_interval_hours: -1
exploration_budget:
  max_attempts: 3
  timeout_per_attempt: 15
  total_timeout: 45
`,
    );

    const store = new TaskStore({ tasksDir, dbPath: join(tempDir, "state.db") });

    try {
      await expect(store.list()).rejects.toThrow(/invalid task|recurring_interval_hours/i);
    } finally {
      store.close();
    }
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on task YAML with non-boolean recurring flag", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");

    await writeFile(
      join(tasksDir, "bad-recurring-flag.yaml"),
      `id: t_bad_recurring_flag
title: Bad recurring flag
priority: high
depends_on: []
agent_prompt: "test"
recurring: yes
exploration_budget:
  max_attempts: 3
  timeout_per_attempt: 15
  total_timeout: 45
`,
    );

    const store = new TaskStore({ tasksDir, dbPath: join(tempDir, "state.db") });

    try {
      await expect(store.list()).rejects.toThrow(/invalid task|recurring/i);
    } finally {
      store.close();
    }
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on task YAML with non-boolean evaluate flag", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");

    await writeFile(
      join(tasksDir, "bad-evaluate-flag.yaml"),
      `id: t_bad_evaluate_flag
title: Bad evaluate flag
priority: high
depends_on: []
agent_prompt: "test"
evaluate: nope
exploration_budget:
  max_attempts: 3
  timeout_per_attempt: 15
  total_timeout: 45
`,
    );

    const store = new TaskStore({ tasksDir, dbPath: join(tempDir, "state.db") });

    try {
      await expect(store.list()).rejects.toThrow(/invalid task|evaluate/i);
    } finally {
      store.close();
    }
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on task YAML with invalid source_task_id", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");

    await writeFile(
      join(tasksDir, "bad-source-task.yaml"),
      `id: t_bad_source_task
source_task_id: ../root
title: Bad source task
priority: high
depends_on: []
agent_prompt: "test"
exploration_budget:
  max_attempts: 3
  timeout_per_attempt: 15
  total_timeout: 45
`,
    );

    const store = new TaskStore({ tasksDir, dbPath: join(tempDir, "state.db") });

    try {
      await expect(store.list()).rejects.toThrow(/invalid task|source_task_id/i);
    } finally {
      store.close();
    }
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on task YAML with invalid success_criteria shape", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");

    await writeFile(
      join(tasksDir, "bad-success-criteria.yaml"),
      `id: t_bad_success_criteria
title: Bad success criteria
priority: high
depends_on: []
agent_prompt: "test"
success_criteria: done
exploration_budget:
  max_attempts: 3
  timeout_per_attempt: 15
  total_timeout: 45
`,
    );

    const store = new TaskStore({ tasksDir, dbPath: join(tempDir, "state.db") });

    try {
      await expect(store.list()).rejects.toThrow(/invalid task|success_criteria/i);
    } finally {
      store.close();
    }
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on task YAML with invalid escalation_rules shape", async () => {
    const { TaskStore } = await import("../../src/store/task-store.js");

    await writeFile(
      join(tasksDir, "bad-escalation-rules.yaml"),
      `id: t_bad_escalation_rules
title: Bad escalation rules
priority: high
depends_on: []
agent_prompt: "test"
escalation_rules:
  - valid_rule
  - 42
exploration_budget:
  max_attempts: 3
  timeout_per_attempt: 15
  total_timeout: 45
`,
    );

    const store = new TaskStore({ tasksDir, dbPath: join(tempDir, "state.db") });

    try {
      await expect(store.list()).rejects.toThrow(/invalid task|escalation_rules/i);
    } finally {
      store.close();
    }
  }, GIT_TEST_TIMEOUT_MS);
});

describe("H8: Single-instance kernel lock", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "oh-lock-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("acquires a PID lock on startup", async () => {
    const { acquireKernelLock, releaseKernelLock } = await import("../../src/startup.js");

    const lock = await acquireKernelLock(tempDir);
    expect(lock).toBeTruthy();

    await releaseKernelLock(lock);
  }, GIT_TEST_TIMEOUT_MS);

  it("fails to acquire lock when another instance holds it", async () => {
    const { acquireKernelLock, releaseKernelLock } = await import("../../src/startup.js");

    const lock1 = await acquireKernelLock(tempDir);

    await expect(acquireKernelLock(tempDir)).rejects.toThrow(/already running|lock/i);

    await releaseKernelLock(lock1);
  }, GIT_TEST_TIMEOUT_MS);

  it("reclaims a stale lock file left by a dead process", async () => {
    const { readFile } = await import("node:fs/promises");
    const { acquireKernelLock, releaseKernelLock } = await import("../../src/startup.js");

    await writeFile(join(tempDir, "kernel.pid"), "999999999\n");

    const lock = await acquireKernelLock(tempDir);
    const lockContents = await readFile(join(tempDir, "kernel.pid"), "utf-8");

    expect(lock.pid).toBe(process.pid);
    expect(lockContents.trim()).toBe(String(process.pid));

    await releaseKernelLock(lock);
  }, GIT_TEST_TIMEOUT_MS);

  it("releases lock cleanly so next instance can start", async () => {
    const { acquireKernelLock, releaseKernelLock } = await import("../../src/startup.js");

    const lock1 = await acquireKernelLock(tempDir);
    await releaseKernelLock(lock1);

    const lock2 = await acquireKernelLock(tempDir);
    expect(lock2).toBeTruthy();
    await releaseKernelLock(lock2);
  }, GIT_TEST_TIMEOUT_MS);

  it("does not delete a lock file that now belongs to a newer owner", async () => {
    const { readFile } = await import("node:fs/promises");
    const { releaseKernelLock } = await import("../../src/startup.js");

    await writeFile(join(tempDir, "kernel.pid"), "424242\n");

    await releaseKernelLock({ lockPath: join(tempDir, "kernel.pid"), pid: process.pid });

    const remaining = await readFile(join(tempDir, "kernel.pid"), "utf-8");
    expect(remaining.trim()).toBe("424242");
  }, GIT_TEST_TIMEOUT_MS);
});
