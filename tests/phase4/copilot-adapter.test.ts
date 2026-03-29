import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockChild } from "./helpers/mock-child.js";

describe("Phase 4: copilot adapter", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
  });

  it("spawns gh copilot with --allow-all-tools and exposes output plus exit result", async () => {
    const spawnMock = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const child = createMockChild(9753);
    spawnMock.mockReturnValue(child);

    const { copilotAdapter } = await import("../../src/adapters/copilot.js");
    const agentProcess = copilotAdapter.spawn({
      prompt: "Review the current diff",
      workingDirectory: "/tmp/openharness-task",
      timeoutMinutes: 10,
      env: { OPENHARNESS_TASK_ID: "t_eval" },
    });

    const streamedChunks: string[] = [];
    const outputDrain = (async () => {
      for await (const chunk of agentProcess.output) {
        streamedChunks.push(chunk);
      }
    })();

    child.stdout.write("eval ok\n");
    child.stderr.write("warnings\n");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);

    const result = await agentProcess.wait();
    await outputDrain;

    expect(spawnMock).toHaveBeenCalledWith(
      "gh",
      ["copilot", "-p", "Review the current diff", "--allow-all-tools"],
      expect.objectContaining({
        cwd: "/tmp/openharness-task",
        detached: true,
        env: expect.objectContaining({ OPENHARNESS_TASK_ID: "t_eval" }),
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    expect(agentProcess.pid).toBe(9753);
    expect(agentProcess.pgid).toBe(9753);
    expect(streamedChunks).toEqual(["eval ok\n", "warnings\n"]);
    expect(result).toMatchObject({
      exitCode: 0,
      output: "eval ok\nwarnings\n",
      pgid: 9753,
    });
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("passes --model flag when adapter is created with a model override", async () => {
    const spawnMock = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const child = createMockChild(7531);
    spawnMock.mockReturnValue(child);

    const { createCopilotAdapter } = await import("../../src/adapters/copilot.js");
    const adapter = createCopilotAdapter({ model: "gpt-5.4" });
    adapter.spawn({
      prompt: "Evaluate this",
      workingDirectory: "/tmp/openharness-task",
      timeoutMinutes: 10,
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "gh",
      ["copilot", "-p", "Evaluate this", "--allow-all-tools", "--model", "gpt-5.4"],
      expect.anything(),
    );

    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
  });

  it("kills the process group when the adapter timeout elapses", async () => {
    vi.useFakeTimers();
    const spawnMock = vi.fn();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const child = createMockChild(8642);
    spawnMock.mockReturnValue(child);

    const { copilotAdapter } = await import("../../src/adapters/copilot.js");
    copilotAdapter.spawn({
      prompt: "Wait",
      workingDirectory: "/tmp/openharness-task",
      timeoutMinutes: 0.01,
    });

    await vi.advanceTimersByTimeAsync(600);

    expect(killSpy).toHaveBeenCalledWith(-8642, "SIGTERM");
    vi.useRealTimers();
  });
});
