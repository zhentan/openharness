import type { AgentAdapter, AgentProcess } from "../types.js";
import { spawnAdapterProcess } from "./process-adapter.js";

/**
 * Create a copilot adapter with optional model override.
 * Default model is unset (uses copilot's default).
 */
export function createCopilotAdapter(options?: { model?: string }): AgentAdapter {
  return {
    name: "copilot",
    command: "gh",
    availabilityArgs: ["copilot", "--help"],
    spawn(config): AgentProcess {
      const args = ["copilot", "-p", config.prompt, "--allow-all-tools"];
      if (options?.model) {
        args.push("--model", options.model);
      }
      return spawnAdapterProcess({
        command: "gh",
        args,
        adapterName: "copilot",
        config,
      });
    },
  };
}

/** Default copilot adapter (no model override — uses copilot's default). */
export const copilotAdapter: AgentAdapter = createCopilotAdapter();
