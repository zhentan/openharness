import { describe, expect, it, vi } from "vitest";

describe("Phase 8: CLI entrypoint", () => {
  it("forces process exit with the runCli exit code", async () => {
    const { main } = await import("../../bin/openharness.js");

    const runCliImpl = vi.fn(async () => 0);
    const exit = vi.fn();
    const stderr = vi.fn();

    await main({
      args: ["watch"],
      runCliImpl,
      exit,
      stderr,
    });

    expect(runCliImpl).toHaveBeenCalledWith(["watch"]);
    expect(exit).toHaveBeenCalledWith(0);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("forces process exit with code 1 when startup fails", async () => {
    const { main } = await import("../../bin/openharness.js");

    const runCliImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    const exit = vi.fn();
    const stderr = vi.fn();

    await main({
      args: ["start"],
      runCliImpl,
      exit,
      stderr,
    });

    expect(stderr).toHaveBeenCalledWith("[kernel] Startup failed:", expect.any(Error));
    expect(exit).toHaveBeenCalledWith(1);
  });
});
