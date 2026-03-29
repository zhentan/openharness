import { claudeCodeAdapter } from "./claude-code.js";
import { copilotAdapter } from "./copilot.js";
import { codexAdapter } from "./codex.js";
import type { AgentAdapter, KernelConfig, Task } from "../types.js";

export interface ResolvedTaskAdapters {
  generator: AgentAdapter;
  evaluator: AgentAdapter;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  constructor(adapters: AgentAdapter[] = defaultAdapters()) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.name, adapter);
    }
  }

  get(name: string): AgentAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(`Unknown adapter: ${name}`);
    }
    return adapter;
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  resolveTaskAdapters(
    task: Pick<Task, "agent" | "evaluator_agent"> & Partial<Task>,
    config: Pick<KernelConfig, "defaultAdapter" | "evaluatorAdapter">,
  ): ResolvedTaskAdapters {
    return {
      generator: this.get(task.agent ?? config.defaultAdapter),
      evaluator: this.get(task.evaluator_agent ?? config.evaluatorAdapter),
    };
  }
}

function defaultAdapters(): AgentAdapter[] {
  return [claudeCodeAdapter, copilotAdapter, codexAdapter];
}
