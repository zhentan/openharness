import type { KernelConfig } from "./types.js";

const DEFAULTS: KernelConfig = {
  tickIntervalMs: 30_000,
  maxConcurrency: 4,
  tasksDir: "tasks",
  runsDir: "runs",
  worktreesDir: ".worktrees",
  port: 3000,
  defaultAdapter: "claude-code",
  evaluatorAdapter: "copilot",
  adapters: {
    "claude-code": "built-in",
    copilot: "built-in",
    codex: "built-in",
  },
  backoffBaseDelayMs: 30_000,
  backoffMaxDelayMs: 600_000,
  poisonPillThreshold: 2,
  maxRecurringFixTasks: 3,
};

/**
 * Load and validate kernel configuration.
 * Throws on invalid config values — startup must fail before scheduling begins (H5).
 */
export function loadConfig(overrides?: Partial<KernelConfig>): KernelConfig {
  const config = { ...DEFAULTS, ...overrides };
  validateConfig(config);
  return config;
}

function validateConfig(config: KernelConfig): void {
  if (typeof config.tickIntervalMs !== "number" || config.tickIntervalMs < 1000) {
    throw new Error(`Invalid config: tickIntervalMs must be >= 1000 (got ${config.tickIntervalMs})`);
  }
  if (typeof config.maxConcurrency !== "number" || config.maxConcurrency < 1) {
    throw new Error(`Invalid config: maxConcurrency must be >= 1 (got ${config.maxConcurrency})`);
  }
  if (typeof config.port !== "number" || config.port < 0 || config.port > 65535) {
    throw new Error(`Invalid config: port must be 0-65535 (got ${config.port})`);
  }
  if (typeof config.poisonPillThreshold !== "number" || config.poisonPillThreshold < 1) {
    throw new Error(`Invalid config: poisonPillThreshold must be >= 1 (got ${config.poisonPillThreshold})`);
  }
  if (typeof config.maxRecurringFixTasks !== "number" || config.maxRecurringFixTasks < 0) {
    throw new Error(`Invalid config: maxRecurringFixTasks must be >= 0 (got ${config.maxRecurringFixTasks})`);
  }
  if (!config.defaultAdapter || typeof config.defaultAdapter !== "string") {
    throw new Error("Invalid config: defaultAdapter is required");
  }
  if (!config.evaluatorAdapter || typeof config.evaluatorAdapter !== "string") {
    throw new Error("Invalid config: evaluatorAdapter is required");
  }
  if (!config.adapters || typeof config.adapters !== "object") {
    throw new Error("Invalid config: adapters map is required");
  }
}
