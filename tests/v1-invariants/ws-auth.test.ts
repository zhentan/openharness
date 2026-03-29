/**
 * P12: WS auth for mutating commands
 *
 * v1 proof: src/server/ws-server.ts:17-21 — MUTATING_COMMANDS set
 * Phase gate: 7
 *
 * Mutating commands (pause, resume, kill, shutdown, etc.) require
 * authentication via a per-instance token. Read-only commands
 * (subscribe, get-status) do not require auth.
 */
import { describe, it, expect } from "vitest";

describe("P12: WS auth for mutating commands", () => {
  it("rejects mutating commands without valid token", async () => {
    const { WsServer } = await import("../../src/server/ws-server.js");

    // The server should have a way to validate requests
    const server = new WsServer({ port: 0 }); // port 0 = random available

    const mutatingCommands = [
      { type: "pause", taskId: "t_1" },
      { type: "resume", taskId: "t_1" },
      { type: "kill", taskId: "t_1" },
      { type: "shutdown" },
      { type: "help", taskId: "t_1", hint: "try X" },
    ];

    for (const cmd of mutatingCommands) {
      const result = server.validateRequest(cmd, null); // no token
      expect(result.authorized, `${cmd.type} should require auth`).toBe(false);
    }

    await server.close();
  });

  it("allows mutating commands with valid token", async () => {
    const { WsServer } = await import("../../src/server/ws-server.js");

    const server = new WsServer({ port: 0 });
    const token = server.token;

    const result = server.validateRequest({ type: "pause", taskId: "t_1" }, token);
    expect(result.authorized).toBe(true);

    await server.close();
  });

  it("allows read-only commands without auth", async () => {
    const { WsServer } = await import("../../src/server/ws-server.js");

    const server = new WsServer({ port: 0 });

    const readOnlyCommands = [
      { type: "subscribe", channel: "tasks" },
      { type: "get-status" },
      { type: "get-task", taskId: "t_1" },
    ];

    for (const cmd of readOnlyCommands) {
      const result = server.validateRequest(cmd, null);
      expect(result.authorized, `${cmd.type} should not require auth`).toBe(true);
    }

    await server.close();
  });
});
