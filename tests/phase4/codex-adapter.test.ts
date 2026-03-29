import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockChild, createPartialMockChild } from "./helpers/mock-child.js";

describe("Phase 4: codex adapter", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
  });

  it("spawns codex exec with gpt-5.4 and exposes output plus exit result", async () => {
    const spawnMock = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const child = createMockChild(6420);
    spawnMock.mockReturnValue(child);

    const { codexAdapter } = await import("../../src/adapters/codex.js");
    const agentProcess = codexAdapter.spawn({
      prompt: "Refactor the scheduler safely",
      workingDirectory: "/tmp/openharness-task",
      timeoutMinutes: 20,
      env: { OPENHARNESS_TASK_ID: "t_codex" },
    });

    const streamedChunks: string[] = [];
    const outputDrain = (async () => {
      for await (const chunk of agentProcess.output) {
        streamedChunks.push(chunk);
      }
    })();

    child.stdout.write("done\n");
    child.stderr.write("warning\n");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);

    const result = await agentProcess.wait();
    await outputDrain;

    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      [
        "exec",
        "--model",
        "gpt-5.4",
        "--dangerously-bypass-approvals-and-sandbox",
        "--cd",
        "/tmp/openharness-task",
        "--color",
        "never",
        "Refactor the scheduler safely",
      ],
      expect.objectContaining({
        cwd: "/tmp/openharness-task",
        detached: true,
        env: expect.objectContaining({ OPENHARNESS_TASK_ID: "t_codex" }),
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    expect(agentProcess.pid).toBe(6420);
    expect(agentProcess.pgid).toBe(6420);
    expect(streamedChunks).toEqual(["done\n", "warning\n"]);
    expect(result).toMatchObject({
      exitCode: 0,
      output: "done\nwarning\n",
      pgid: 6420,
    });
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("passes a model override when adapter is created with one", async () => {
    const spawnMock = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const child = createMockChild(6421);
    spawnMock.mockReturnValue(child);

    const { createCodexAdapter } = await import("../../src/adapters/codex.js");
    const adapter = createCodexAdapter({ model: "gpt-5.4-mini" });
    adapter.spawn({
      prompt: "Evaluate this diff",
      workingDirectory: "/tmp/openharness-task",
      timeoutMinutes: 10,
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      [
        "exec",
        "--model",
        "gpt-5.4-mini",
        "--dangerously-bypass-approvals-and-sandbox",
        "--cd",
        "/tmp/openharness-task",
        "--color",
        "never",
        "Evaluate this diff",
      ],
      expect.anything(),
    );

    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
  });

  it("tears down a partially started child before throwing", async () => {
    const spawnMock = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const child = createPartialMockChild(6422);
    spawnMock.mockReturnValue(child);

    const { codexAdapter } = await import("../../src/adapters/codex.js");

    expect(() =>
      codexAdapter.spawn({
        prompt: "Fail fast",
        workingDirectory: "/tmp/openharness-task",
        timeoutMinutes: 15,
      }),
    ).toThrow(/failed to start child process/i);

    expect(child.kill).toHaveBeenCalledOnce();
  });
});
