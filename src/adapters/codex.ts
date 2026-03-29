import type { AgentAdapter, AgentProcess } from "../types.js";
import { spawnAdapterProcess } from "./process-adapter.js";

/**
 * Create a Codex CLI adapter with an optional model override.
 * Defaults to GPT-5.4 for direct OpenAI-backed coding runs.
 */
export function createCodexAdapter(options?: { model?: string }): AgentAdapter {
  const model = options?.model ?? "gpt-5.4";

  return {
    name: "codex",
    command: "codex",
    availabilityArgs: ["exec", "--help"],
    spawn(config): AgentProcess {
      return spawnAdapterProcess({
        command: "codex",
        args: [
          "exec",
          "--model",
          model,
          "--dangerously-bypass-approvals-and-sandbox",
          "--cd",
          config.workingDirectory,
          "--color",
          "never",
          config.prompt,
        ],
        adapterName: "codex",
        config,
      });
    },
  };
}

/** Default Codex adapter pinned to GPT-5.4. */
export const codexAdapter: AgentAdapter = createCodexAdapter();
