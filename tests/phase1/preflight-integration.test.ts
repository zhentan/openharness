/**
 * Integration test: startup preflight runs all checks as a single path.
 *
 * H3-H8 are tested in isolation elsewhere. This test proves they are
 * orchestrated together — one function that fails on any violation.
 *
 * Phase gate: 1
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const GIT_TEST_TIMEOUT_MS = 15_000;

describe("Startup preflight integration", () => {
  let repoDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "oh-preflight-"));
    tasksDir = join(repoDir, "tasks");
    await mkdir(tasksDir, { recursive: true });
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoDir });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("passes when repo is clean, config valid, tasks valid, deps acyclic", async () => {
    const { runPreflight } = await import("../../src/startup.js");
    const { AdapterRegistry } = await import("../../src/adapters/registry.js");

    await writeFile(
      join(tasksDir, "t_good.yaml"),
      `id: t_good\ntitle: Good task\npriority: high\ndepends_on: []\nagent_prompt: "do it"\nexploration_budget:\n  max_attempts: 3\n  timeout_per_attempt: 15\n  total_timeout: 45\n`,
    );
    // Commit so the repo is clean
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "add task"], { cwd: repoDir });

    const result = await runPreflight({
      repoDir,
      tasksDir,
      dbPath: ":memory:",
      configOverrides: { defaultAdapter: "test-gen", evaluatorAdapter: "test-eval" },
      adapterRegistry: new AdapterRegistry([
        { name: "test-gen", spawn() { throw new Error("not used in preflight"); } },
        { name: "test-eval", spawn() { throw new Error("not used in preflight"); } },
      ]),
      adapterAvailabilityChecker: async () => true,
    });
    expect(result.config).toBeTruthy();
    expect(result.config.maxConcurrency).toBeGreaterThan(0);
    expect(result.tasks.length).toBe(1);
    expect(result.lock).toBeTruthy();

    // Clean up lock
    const { releaseKernelLock } = await import("../../src/startup.js");
    await releaseKernelLock(result.lock);
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on invalid config before checking repo or tasks", async () => {
    const { runPreflight } = await import("../../src/startup.js");

    await expect(
      runPreflight({
        repoDir,
        tasksDir,
        dbPath: ":memory:",
        configOverrides: { maxConcurrency: 0 },
      }),
    ).rejects.toThrow(/maxConcurrency/);
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on non-main branch before checking anything else", async () => {
    const { runPreflight } = await import("../../src/startup.js");

    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });

    await expect(runPreflight({ repoDir, tasksDir, dbPath: ":memory:" })).rejects.toThrow(/not on main/i);
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on dirty working tree", async () => {
    const { runPreflight } = await import("../../src/startup.js");

    await writeFile(join(repoDir, "dirty.txt"), "uncommitted");

    await expect(runPreflight({ repoDir, tasksDir, dbPath: ":memory:" })).rejects.toThrow(/dirty|uncommitted/i);
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on malformed task YAML", async () => {
    const { runPreflight } = await import("../../src/startup.js");

    await writeFile(join(tasksDir, "bad.yaml"), `title: no id\n`);
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "add bad task"], { cwd: repoDir });

    await expect(runPreflight({ repoDir, tasksDir, dbPath: ":memory:" })).rejects.toThrow(/invalid task/i);
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on duplicate task IDs across YAML files", async () => {
    const { runPreflight } = await import("../../src/startup.js");

    await writeFile(
      join(tasksDir, "t_duplicate_a.yaml"),
      `id: t_duplicate\ntitle: Duplicate A\npriority: high\ndepends_on: []\nagent_prompt: "a"\nexploration_budget:\n  max_attempts: 3\n  timeout_per_attempt: 15\n  total_timeout: 45\n`,
    );
    await writeFile(
      join(tasksDir, "t_duplicate_b.yaml"),
      `id: t_duplicate\ntitle: Duplicate B\npriority: medium\ndepends_on: []\nagent_prompt: "b"\nexploration_budget:\n  max_attempts: 3\n  timeout_per_attempt: 15\n  total_timeout: 45\n`,
    );
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "add duplicate tasks"], { cwd: repoDir });

    await expect(runPreflight({ repoDir, tasksDir, dbPath: ":memory:" })).rejects.toThrow(
      /(t_duplicate_a\.yaml.*duplicate task id "t_duplicate".*t_duplicate_b\.yaml|t_duplicate_b\.yaml.*duplicate task id "t_duplicate".*t_duplicate_a\.yaml)/i,
    );
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on dependency cycle", async () => {
    const { runPreflight } = await import("../../src/startup.js");

    await writeFile(
      join(tasksDir, "t_a.yaml"),
      `id: t_a\ntitle: A\npriority: high\ndepends_on: [t_b]\nagent_prompt: "a"\nexploration_budget:\n  max_attempts: 3\n  timeout_per_attempt: 15\n  total_timeout: 45\n`,
    );
    await writeFile(
      join(tasksDir, "t_b.yaml"),
      `id: t_b\ntitle: B\npriority: high\ndepends_on: [t_a]\nagent_prompt: "b"\nexploration_budget:\n  max_attempts: 3\n  timeout_per_attempt: 15\n  total_timeout: 45\n`,
    );
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "add cyclic tasks"], { cwd: repoDir });

    await expect(runPreflight({ repoDir, tasksDir, dbPath: ":memory:" })).rejects.toThrow(/cycle|circular/i);
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on missing dependency", async () => {
    const { runPreflight } = await import("../../src/startup.js");

    await writeFile(
      join(tasksDir, "t_orphan.yaml"),
      `id: t_orphan\ntitle: Orphan\npriority: high\ndepends_on: [t_nonexistent]\nagent_prompt: "x"\nexploration_budget:\n  max_attempts: 3\n  timeout_per_attempt: 15\n  total_timeout: 45\n`,
    );
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "add orphan task"], { cwd: repoDir });

    await expect(runPreflight({ repoDir, tasksDir, dbPath: ":memory:" })).rejects.toThrow(/missing dep|not found/i);
  }, GIT_TEST_TIMEOUT_MS);

  it("fails on unavailable adapter and releases the startup lock", async () => {
    const { runPreflight } = await import("../../src/startup.js");
    const { AdapterRegistry } = await import("../../src/adapters/registry.js");

    await writeFile(
      join(tasksDir, "t_adapter.yaml"),
      `id: t_adapter\ntitle: Needs adapter\npriority: high\ndepends_on: []\nagent: test-gen\nagent_prompt: "do it"\nexploration_budget:\n  max_attempts: 3\n  timeout_per_attempt: 15\n  total_timeout: 45\n`,
    );
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "add adapter task"], { cwd: repoDir });

    const registry = new AdapterRegistry([
      { name: "test-gen", command: "missing-gen", spawn() { throw new Error("not used in preflight"); } },
      { name: "test-eval", command: "missing-eval", spawn() { throw new Error("not used in preflight"); } },
    ]);

    await expect(
      runPreflight({
        repoDir,
        tasksDir,
        dbPath: ":memory:",
        configOverrides: { defaultAdapter: "test-gen", evaluatorAdapter: "test-eval" },
        adapterRegistry: registry,
        adapterAvailabilityChecker: async (adapter) => adapter.name !== "test-gen",
      }),
    ).rejects.toThrow(/adapter 'test-gen' is not available/i);

    const secondAttempt = await runPreflight({
      repoDir,
      tasksDir,
      dbPath: ":memory:",
      configOverrides: { defaultAdapter: "test-gen", evaluatorAdapter: "test-eval" },
      adapterRegistry: registry,
      adapterAvailabilityChecker: async () => true,
    });

    expect(secondAttempt.lock).toBeTruthy();

    const { releaseKernelLock } = await import("../../src/startup.js");
    await releaseKernelLock(secondAttempt.lock);
  }, GIT_TEST_TIMEOUT_MS);
});
