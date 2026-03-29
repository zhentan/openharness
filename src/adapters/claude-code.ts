import type { AgentAdapter, AgentProcess } from "../types.js";
import { spawnAdapterProcess } from "./process-adapter.js";

export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",
  command: "claude",
  availabilityArgs: ["--version"],
  spawn(config): AgentProcess {
    return spawnAdapterProcess({
      command: "claude",
      args: [
        "--print",
        "--verbose",
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
      ],
      adapterName: "claude-code",
      normalizeOutput: normalizeClaudeStreamJsonOutput,
      config: {
        ...config,
        stdinInput: config.prompt,
      },
    });
  },
};

export function normalizeClaudeStreamJsonOutput(output: {
  stdout: string;
  stderr: string;
  combined: string;
}): { stdout: string; stderr: string; output: string } {
  const normalizedStdout = extractClaudeText(output.stdout);
  const normalizedStderr = extractClaudeText(output.stderr);

  return {
    stdout: normalizedStdout,
    stderr: normalizedStderr,
    output: [normalizedStdout, normalizedStderr].filter(Boolean).join("\n"),
  };
}

function extractClaudeText(raw: string): string {
  if (!raw.trim()) {
    return "";
  }

  const lines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as ClaudeStreamEvent;
      const text = extractEventText(parsed);
      if (text) {
        lines.push(text);
      }
    } catch {
      lines.push(trimmed);
    }
  }

  return lines.join("\n").trim();
}

function extractEventText(event: ClaudeStreamEvent): string | undefined {
  if (event.type === "assistant" && event.message?.content) {
    return event.message.content
      .flatMap((item) => item.type === "text" ? [item.text] : [])
      .join("\n")
      .trim() || undefined;
  }

  if (event.type === "result" && typeof event.result === "string") {
    return event.result.trim() || undefined;
  }

  if (event.type === "system") {
    const fragments = [event.output, event.stderr].filter((value): value is string => typeof value === "string");
    if (fragments.length > 0) {
      return fragments.join("\n").trim() || undefined;
    }
  }

  return undefined;
}

interface ClaudeStreamEvent {
  type?: string;
  output?: string;
  stderr?: string;
  result?: string;
  message?: {
    content?: Array<{ type?: string; text?: string }>;
  };
}
