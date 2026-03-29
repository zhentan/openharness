import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockChild } from "./helpers/mock-child.js";

describe("Phase 4: process adapter", () => {
  let worktreeDir: string;

  beforeEach(async () => {
    worktreeDir = await mkdtemp(join(tmpdir(), "oh-process-adapter-"));
    await mkdir(join(worktreeDir, ".openharness"), { recursive: true });
  });

  afterEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
    await rm(worktreeDir, { recursive: true, force: true });
  });

  it("returns scoped completion signal data in the agent result", async () => {
    const spawnMock = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const child = createMockChild(4444);
    spawnMock.mockReturnValue(child);

    await writeFile(
      join(worktreeDir, ".openharness", "completion.json"),
      JSON.stringify({
        status: "completed",
        summary: "done",
        task_id: "t_signal",
        run_id: "run_signal",
      }),
      "utf8",
    );

    const { spawnAdapterProcess } = await import("../../src/adapters/process-adapter.js");
    const processHandle = spawnAdapterProcess({
      command: "claude",
      args: ["--print", "hello"],
      adapterName: "claude-code",
      config: {
        prompt: "hello",
        workingDirectory: worktreeDir,
        timeoutMinutes: 1,
        env: {
          OPENHARNESS_TASK_ID: "t_signal",
          OPENHARNESS_RUN_ID: "run_signal",
        },
      },
    });

    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);

    const result = await processHandle.wait();

    expect(result.completionSignal).toEqual({
      status: "completed",
      summary: "done",
      task_id: "t_signal",
      run_id: "run_signal",
    });
    expect(result.classification).toBeUndefined();
  });

  it("classifies exit 0 without scoped signals as missing_signal", async () => {
    const spawnMock = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const child = createMockChild(5555);
    spawnMock.mockReturnValue(child);

    const { spawnAdapterProcess } = await import("../../src/adapters/process-adapter.js");
    const processHandle = spawnAdapterProcess({
      command: "claude",
      args: ["--print", "hello"],
      adapterName: "claude-code",
      config: {
        prompt: "hello",
        workingDirectory: worktreeDir,
        timeoutMinutes: 1,
        env: {
          OPENHARNESS_TASK_ID: "t_missing",
          OPENHARNESS_RUN_ID: "run_missing",
        },
      },
    });

    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);

    const result = await processHandle.wait();

    expect(result.classification).toEqual(
      expect.objectContaining({ severity: "TRANSIENT", reason: "missing_signal" }),
    );
  });

  it("writes stdin input when provided in the spawn config", async () => {
    const spawnMock = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const child = createMockChild(6666);
    spawnMock.mockReturnValue(child);
    const stdinChunks: string[] = [];
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk) => {
      stdinChunks.push(chunk);
    });

    const { spawnAdapterProcess } = await import("../../src/adapters/process-adapter.js");
    const processHandle = spawnAdapterProcess({
      command: "claude",
      args: ["--print"],
      adapterName: "claude-code",
      config: {
        prompt: "ignored for argv",
        stdinInput: "prompt through stdin",
        workingDirectory: worktreeDir,
        timeoutMinutes: 1,
      },
    });

    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);

    await processHandle.wait();

    expect(spawnMock).toHaveBeenCalledWith(
      "claude",
      ["--print"],
      expect.objectContaining({
        cwd: worktreeDir,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(stdinChunks.join("")).toBe("prompt through stdin");
  });

  it("records pid and pgid in the task signal directory", async () => {
    const spawnMock = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const child = createMockChild(7777);
    spawnMock.mockReturnValue(child);

    const { spawnAdapterProcess } = await import("../../src/adapters/process-adapter.js");
    const processHandle = spawnAdapterProcess({
      command: "claude",
      args: ["--print"],
      adapterName: "claude-code",
      config: {
        prompt: "record process ids",
        workingDirectory: worktreeDir,
        timeoutMinutes: 1,
      },
    });

    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);

    await processHandle.wait();

    await expect(readFile(join(worktreeDir, ".openharness", "pid"), "utf8")).resolves.toBe("7777\n");
    await expect(readFile(join(worktreeDir, ".openharness", "pgid"), "utf8")).resolves.toBe("7777\n");
  });

  it("applies output normalization before returning the agent result", async () => {
    const spawnMock = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const child = createMockChild(8888);
    spawnMock.mockReturnValue(child);

    const { spawnAdapterProcess } = await import("../../src/adapters/process-adapter.js");
    const processHandle = spawnAdapterProcess({
      command: "claude",
      args: ["--print"],
      adapterName: "claude-code",
      config: {
        prompt: "normalize output",
        workingDirectory: worktreeDir,
        timeoutMinutes: 1,
      },
      normalizeOutput: ({ stdout, stderr }) => ({
        stdout: stdout.replace("raw", "normalized"),
        stderr,
        output: "normalized output",
      }),
    });

    child.stdout.write("raw stdout");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 1, null);

    const result = await processHandle.wait();

    expect(result.output).toBe("normalized output");
    expect(result.classification).toEqual(
      expect.objectContaining({
        severity: "TRANSIENT",
        reason: "transient_unknown",
        detail: "normalized stdout",
      }),
    );
  });

  it("classifies a run as fatal when the assigned worktree disappears during execution", async () => {
    const { spawnAdapterProcess } = await import("../../src/adapters/process-adapter.js");
    await writeFile(
      join(worktreeDir, ".openharness", "worktree-meta.json"),
      JSON.stringify({ taskId: "t_lost", repoRoot: "/tmp/repo" }),
      "utf8",
    );

    const processHandle = spawnAdapterProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      adapterName: "claude-code",
      config: {
        prompt: "long running",
        workingDirectory: worktreeDir,
        timeoutMinutes: 1,
        workingDirectoryCheckIntervalMs: 10,
      },
    });

    await rm(worktreeDir, { recursive: true, force: true });

    const result = await processHandle.wait();

    expect(result.classification).toEqual(
      expect.objectContaining({
        severity: "FATAL",
        reason: "worktree_lost",
      }),
    );
  });
});
