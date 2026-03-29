/**
 * H5 (partial): Config schema validation
 *
 * Phase gate: 1
 *
 * Invalid config values must fail startup before scheduling begins.
 */
import { describe, it, expect } from "vitest";

describe("H5: Config schema validation", () => {
  it("rejects tickIntervalMs below minimum", async () => {
    const { loadConfig } = await import("../../src/config.js");
    expect(() => loadConfig({ tickIntervalMs: 100 })).toThrow(/tickIntervalMs/);
  });

  it("rejects maxConcurrency below 1", async () => {
    const { loadConfig } = await import("../../src/config.js");
    expect(() => loadConfig({ maxConcurrency: 0 })).toThrow(/maxConcurrency/);
  });

  it("rejects invalid port", async () => {
    const { loadConfig } = await import("../../src/config.js");
    expect(() => loadConfig({ port: 70000 })).toThrow(/port/);
  });

  it("rejects missing defaultAdapter", async () => {
    const { loadConfig } = await import("../../src/config.js");
    expect(() => loadConfig({ defaultAdapter: "" })).toThrow(/defaultAdapter/);
  });

  it("accepts valid config overrides", async () => {
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig({ maxConcurrency: 8, port: 4000 });
    expect(config.maxConcurrency).toBe(8);
    expect(config.port).toBe(4000);
    expect(config.adapters).toMatchObject({
      "claude-code": "built-in",
      copilot: "built-in",
      codex: "built-in",
    });
  });
});
