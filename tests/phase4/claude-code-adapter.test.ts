import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockChild, createPartialMockChild } from "./helpers/mock-child.js";

describe("Phase 4: claude-code adapter", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
  });

  it("spawns claude in non-interactive mode and exposes output plus exit result", async () => {
    const spawnMock = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const child = createMockChild(4321);
    spawnMock.mockReturnValue(child);
    const stdinChunks: string[] = [];
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk) => {
      stdinChunks.push(chunk);
    });

    const { claudeCodeAdapter } = await import("../../src/adapters/claude-code.js");
    const agentProcess = claudeCodeAdapter.spawn({
      prompt: "Fix the failing test",
      workingDirectory: "/tmp/openharness-task",
      timeoutMinutes: 15,
      env: { OPENHARNESS_TASK_ID: "t_adapter" },
    });

    const streamedChunks: string[] = [];
    const outputDrain = (async () => {
      for await (const chunk of agentProcess.output) {
        streamedChunks.push(chunk);
      }
    })();

    child.stdout.write("first chunk\n");
    child.stderr.write("second chunk\n");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);

    const result = await agentProcess.wait();
    await outputDrain;

    expect(spawnMock).toHaveBeenCalledWith(
      "claude",
      [
        "--print",
        "--verbose",
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
      ],
      expect.objectContaining({
        cwd: "/tmp/openharness-task",
        detached: true,
        env: expect.objectContaining({ OPENHARNESS_TASK_ID: "t_adapter" }),
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );

    expect(agentProcess.pid).toBe(4321);
    expect(agentProcess.pgid).toBe(4321);
    expect(stdinChunks.join("")).toBe("Fix the failing test");
    expect(streamedChunks).toEqual(["first chunk\n", "second chunk\n"]);
    expect(result).toMatchObject({
      exitCode: 0,
      output: "first chunk\nsecond chunk",
      pgid: 4321,
    });
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("tears down a partially started child before throwing", async () => {
    const spawnMock = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const child = createPartialMockChild(9876);
    spawnMock.mockReturnValue(child);

    const { claudeCodeAdapter } = await import("../../src/adapters/claude-code.js");

    expect(() =>
      claudeCodeAdapter.spawn({
        prompt: "Fail fast",
        workingDirectory: "/tmp/openharness-task",
        timeoutMinutes: 15,
      }),
    ).toThrow(/failed to start child process/i);

    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("kills the process group when the adapter timeout elapses", async () => {
    vi.useFakeTimers();
    const spawnMock = vi.fn();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const child = createMockChild(2468);
    spawnMock.mockReturnValue(child);

    const { claudeCodeAdapter } = await import("../../src/adapters/claude-code.js");
    claudeCodeAdapter.spawn({
      prompt: "Time out",
      workingDirectory: "/tmp/openharness-task",
      timeoutMinutes: 0.01,
    });

    await vi.advanceTimersByTimeAsync(600);

    expect(killSpy).toHaveBeenCalledWith(-2468, "SIGTERM");
    vi.useRealTimers();
  });

  it("clears the adapter timeout after normal exit", async () => {
    vi.useFakeTimers();
    const spawnMock = vi.fn();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const child = createMockChild(1357);
    spawnMock.mockReturnValue(child);

    const { claudeCodeAdapter } = await import("../../src/adapters/claude-code.js");
    const processHandle = claudeCodeAdapter.spawn({
      prompt: "Exit normally",
      workingDirectory: "/tmp/openharness-task",
      timeoutMinutes: 0.01,
    });

    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
    await processHandle.wait();

    await vi.advanceTimersByTimeAsync(600);

    expect(killSpy).not.toHaveBeenCalledWith(-1357, "SIGTERM");
    vi.useRealTimers();
  });

  it("normalizes stream-json output into readable text", async () => {
    const { normalizeClaudeStreamJsonOutput } = await import("../../src/adapters/claude-code.js");

    const normalized = normalizeClaudeStreamJsonOutput({
      stdout: [
        JSON.stringify({
          type: "system",
          subtype: "hook_started",
          hook_name: "SessionStart:startup",
        }),
        JSON.stringify({
          type: "system",
          output: "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"learning mode\"}}",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "I'll read the required context first." }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", text: "ignored tool payload" }],
          },
        }),
        JSON.stringify({
          type: "result",
          result: "Current working directory: /tmp/task",
        }),
      ].join("\n"),
      stderr: JSON.stringify({
        type: "system",
        stderr: "ENOSPC: No space left on device",
      }),
      combined: "",
    });

    expect(normalized.stdout).toBe(
      [
        "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"learning mode\"}}",
        "I'll read the required context first.",
        "Current working directory: /tmp/task",
      ].join("\n"),
    );
    expect(normalized.stderr).toBe("ENOSPC: No space left on device");
    expect(normalized.output).toContain("I'll read the required context first.");
    expect(normalized.output).toContain("Current working directory: /tmp/task");
    expect(normalized.output).toContain("ENOSPC: No space left on device");
    expect(normalized.output).not.toContain("\"type\":\"tool_use\"");
    expect(normalized.output).not.toContain("\"type\":\"system\",\"subtype\":\"hook_started\"");
  });
});
