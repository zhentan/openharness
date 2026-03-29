import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { spawnAdapterProcess } from "../../src/adapters/process-adapter.js";
import { startKernelRuntime } from "../../src/runtime.js";
import { TaskStore } from "../../src/store/task-store.js";
import type { AgentAdapter, AgentProcess } from "../../src/types.js";
import { worktreeExists } from "../../src/worktree.js";

const GIT_TEST_TIMEOUT_MS = 15_000;

describe.sequential("Phase 6: deterministic dogfood regression", () => {
  let repoDir: string;
  let tasksDir: string;
  let outsideDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    repoDir = await mkdtemp(join(tmpdir(), "oh-dogfood-runtime-"));
    outsideDir = await mkdtemp(join(tmpdir(), "oh-dogfood-outside-"));
    tasksDir = join(repoDir, "tasks");

    await mkdir(tasksDir, { recursive: true });
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoDir });

    await writeFile(
      join(tasksDir, "t_dogfood.yaml"),
      [
        "id: t_dogfood",
        "title: Deterministic dogfood",
        "priority: high",
        "depends_on: []",
        "agent_prompt: \"write completion signal\"",
        "exploration_budget:",
        "  max_attempts: 1",
        "  timeout_per_attempt: 1",
        "  total_timeout: 1",
        "escalation_rules: []",
        "",
      ].join("\n"),
      "utf8",
    );

    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "add dogfood task"], { cwd: repoDir });
    process.chdir(outsideDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(repoDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it("merges after a valid completion signal and then removes the terminal task worktree", async () => {
    const store = new TaskStore({
      tasksDir,
      dbPath: ":memory:",
    });

    const runtime = await startKernelRuntime({
      repoDir,
      tasksDir,
      dbPath: ":memory:",
      configOverrides: {
        port: 0,
        tickIntervalMs: 1000,
        maxConcurrency: 1,
        defaultAdapter: "deterministic-dogfood",
        evaluatorAdapter: "deterministic-dogfood",
        adapters: { "deterministic-dogfood": "test" },
      },
      adapterRegistry: new AdapterRegistry([createDeterministicAdapter()]),
    }, {
      createStore: () => store,
    });

    try {
      let finalTask = null;
      const maxPolls = 120;
      for (let poll = 0; poll < maxPolls; poll += 1) {
        finalTask = await store.get("t_dogfood");
        if (finalTask && finalTask.status === "merged") {
          break;
        }
        await sleep(50);
      }

      if (!finalTask || finalTask.status !== "merged") {
        throw new Error(
          `Timed out waiting for deterministic dogfood task to merge after ${maxPolls} polls; ` +
            `last status was ${finalTask?.status ?? "missing task"}`,
        );
      }

      expect(finalTask).toEqual(expect.objectContaining({
        id: "t_dogfood",
        status: "merged",
        assigned_at: expect.any(String),
        completed_at: expect.any(String),
      }));

      await expect(access(join(repoDir, ".openharness", "completion.json"))).rejects.toThrow();

      const outputLogPath = join(repoDir, "runs", "t_dogfood", `${finalTask?.assigned_at}.log`);
      await expect(readFile(outputLogPath, "utf8")).resolves.toContain("deterministic dogfood complete");
      await expect(readFile(join(repoDir, "merged.txt"), "utf8")).resolves.toContain("merged from t_dogfood");

      const commitCount = Number.parseInt(
        execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim(),
        10,
      );
      expect(commitCount).toBe(3);

      // Once the task is terminal, GC removes the worktree.
      const worktreeGonePolls = 40;
      let worktreeStillExists = true;
      for (let poll = 0; poll < worktreeGonePolls; poll += 1) {
        worktreeStillExists = await worktreeExists(repoDir, "t_dogfood");
        if (!worktreeStillExists) {
          break;
        }
        await sleep(50);
      }
      expect(worktreeStillExists).toBe(false);
    } finally {
      await runtime.stop();
      store.close();
    }
  }, GIT_TEST_TIMEOUT_MS);

  it("escalates when a completed agent writes into main instead of its worktree", async () => {
    const store = new TaskStore({
      tasksDir,
      dbPath: ":memory:",
    });

    const runtime = await startKernelRuntime({
      repoDir,
      tasksDir,
      dbPath: ":memory:",
      configOverrides: {
        port: 0,
        tickIntervalMs: 1000,
        maxConcurrency: 1,
        defaultAdapter: "main-contamination-dogfood",
        evaluatorAdapter: "main-contamination-dogfood",
        adapters: { "main-contamination-dogfood": "test" },
      },
      adapterRegistry: new AdapterRegistry([createMainContaminationAdapter()]),
    }, {
      createStore: () => store,
    });

    try {
      let finalTask = null;
      const maxPolls = 120;
      for (let poll = 0; poll < maxPolls; poll += 1) {
        finalTask = await store.get("t_dogfood");
        if (finalTask && finalTask.status === "escalated") {
          break;
        }
        await sleep(50);
      }

      if (!finalTask || finalTask.status !== "escalated") {
        throw new Error(
          `Timed out waiting for contamination dogfood task to escalate after ${maxPolls} polls; ` +
            `last status was ${finalTask?.status ?? "missing task"}`,
        );
      }

      expect(finalTask).toEqual(expect.objectContaining({
        id: "t_dogfood",
        status: "escalated",
      }));
      await expect(readFile(join(repoDir, "main-leak.txt"), "utf8")).resolves.toContain("leaked to main");
    } finally {
      await runtime.stop();
      await rm(join(repoDir, "main-leak.txt"), { force: true });
      store.close();
    }
  }, GIT_TEST_TIMEOUT_MS);
});

function createDeterministicAdapter(): AgentAdapter {
  return {
    name: "deterministic-dogfood",
    command: process.execPath,
    availabilityArgs: ["--version"],
    spawn(config): AgentProcess {
      return spawnAdapterProcess({
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "const signalDir = path.join(process.cwd(), '.openharness');",
            "fs.mkdirSync(signalDir, { recursive: true });",
            "fs.writeFileSync(path.join(process.cwd(), 'merged.txt'), `merged from ${process.env.OPENHARNESS_TASK_ID}\\n`);",
            "fs.writeFileSync(path.join(signalDir, 'completion.json'), JSON.stringify({",
            "  status: 'completed',",
            "  summary: 'deterministic dogfood',",
            "  task_id: process.env.OPENHARNESS_TASK_ID,",
            "  run_id: process.env.OPENHARNESS_RUN_ID,",
            "}));",
            "console.log('deterministic dogfood complete');",
          ].join(" "),
        ],
        adapterName: "deterministic-dogfood",
        config,
      });
    },
  };
}

function createMainContaminationAdapter(): AgentAdapter {
  return {
    name: "main-contamination-dogfood",
    command: process.execPath,
    availabilityArgs: ["--version"],
    spawn(config): AgentProcess {
      return spawnAdapterProcess({
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "fs.writeFileSync(path.resolve(process.cwd(), '..', '..', 'main-leak.txt'), 'leaked to main\\n');",
            "const signalDir = path.join(process.cwd(), '.openharness');",
            "fs.mkdirSync(signalDir, { recursive: true });",
            "fs.writeFileSync(path.join(signalDir, 'completion.json'), JSON.stringify({",
            "  status: 'completed',",
            "  summary: 'contaminated main worktree',",
            "  task_id: process.env.OPENHARNESS_TASK_ID,",
            "  run_id: process.env.OPENHARNESS_RUN_ID,",
            "}));",
            "console.log('wrote to main and completed');",
          ].join(" "),
        ],
        adapterName: "main-contamination-dogfood",
        config,
      });
    },
  };
}
