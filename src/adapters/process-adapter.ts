/**
 * Shared process-spawning infrastructure for CLI-based agent adapters.
 *
 * Both claude-code and copilot adapters use the same spawn, output streaming,
 * timeout, and kill patterns. This module extracts those so each adapter only
 * provides command + args.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { classifyError, type AdapterErrorPattern } from "./error-classifier.js";
import { ConflictingSignalsError, readScopedSignals } from "../evaluator/signal.js";
import type { AgentProcess, AgentResult, ErrorClassification } from "../types.js";

export interface SpawnAdapterConfig {
  prompt: string;
  workingDirectory: string;
  timeoutMinutes: number;
  outputFilePath?: string;
  env?: Record<string, string>;
  stdinInput?: string;
  workingDirectoryCheckIntervalMs?: number;
}

export interface AdapterSpawnOptions {
  command: string;
  args: string[];
  adapterName: string;
  config: SpawnAdapterConfig;
  patterns?: AdapterErrorPattern[];
  normalizeOutput?: (output: { stdout: string; stderr: string; combined: string }) => {
    stdout: string;
    stderr: string;
    output: string;
  };
}

/**
 * Spawn a CLI agent as a detached process group with output streaming,
 * timeout, and PGID-based kill.
 */
export function spawnAdapterProcess(options: AdapterSpawnOptions): AgentProcess {
  const { command, args, adapterName, config, patterns, normalizeOutput } = options;
  const output = createOutputChannel();
  const capturedChunks: string[] = [];
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const startedAt = Date.now();
  let forcedClassification: ErrorClassification | undefined;

  const outputFileStream = createOutputFileStream(config.outputFilePath);
  const stdio: ["ignore" | "pipe", "pipe", "pipe"] = [
    config.stdinInput === undefined ? "ignore" : "pipe",
    "pipe",
    "pipe",
  ];
  const child = spawn(command, args, {
    cwd: config.workingDirectory,
    detached: true,
    env: {
      ...process.env,
      ...config.env,
    },
    stdio,
  });

  if (
    !child.pid
    || !child.stdout
    || !child.stderr
    || (config.stdinInput !== undefined && !child.stdin)
  ) {
    child.kill();
    output.close();
    outputFileStream?.end();
    throw new Error(`${adapterName} adapter failed to start child process with piped output`);
  }

  const stdin = child.stdin;
  if (config.stdinInput !== undefined && stdin) {
    stdin.write(config.stdinInput);
    stdin.end();
  }

  const pgid = child.pid;
  writeRecordedProcess(config.workingDirectory, child.pid, pgid);
  const workingDirectoryCheckIntervalMs = config.workingDirectoryCheckIntervalMs ?? 250;
  const enforceWorktreeGuard = worktreePathExists(config.workingDirectory);
  const worktreeGuard = setInterval(() => {
    if (!enforceWorktreeGuard || forcedClassification || worktreePathExists(config.workingDirectory)) {
      return;
    }

    forcedClassification = {
      severity: "FATAL",
      reason: "worktree_lost",
      detail: `Assigned worktree disappeared during agent execution: ${config.workingDirectory}`,
    };

    try {
      process.kill(-pgid, "SIGTERM");
    } catch {
      // Process may have already exited.
    }
  }, workingDirectoryCheckIntervalMs);
  worktreeGuard.unref?.();

  const forwardChunk = (chunk: Buffer | string, target: string[]): void => {
    const text = chunk.toString();
    target.push(text);
    capturedChunks.push(text);
    output.push(text);
    outputFileStream?.write(text);
  };

  child.stdout.on("data", (chunk) => {
    forwardChunk(chunk, stdoutChunks);
  });
  child.stderr.on("data", (chunk) => {
    forwardChunk(chunk, stderrChunks);
  });

  // Defense-in-depth timeout — supervisor also monitors, but this ensures
  // the process is killed even if supervisor monitoring isn't wired up.
  const timeoutMs = config.timeoutMinutes * 60 * 1000;
  const timeoutHandle = setTimeout(() => {
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {
      // Process may have already exited.
    }
  }, timeoutMs);

  const exitResult = new Promise<AgentResult>((resolve, reject) => {
    child.once("error", (error) => {
      clearTimeout(timeoutHandle);
      clearInterval(worktreeGuard);
      output.close();
      outputFileStream?.end();
      reject(error);
    });

      child.once("close", (code, signal) => {
        clearTimeout(timeoutHandle);
        clearInterval(worktreeGuard);
        output.close();
        outputFileStream?.end();
        void buildAgentResult({
          exitCode: normalizeExitCode(code, signal),
          duration: Date.now() - startedAt,
          output: capturedChunks.join(""),
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
          pgid,
          workingDirectory: config.workingDirectory,
          env: config.env,
          patterns,
          normalizeOutput,
          forcedClassification,
        }).then(resolve, reject);
    });
  });

  return {
    pid: child.pid,
    pgid,
    output,
    wait: async () => exitResult,
    kill: async () => {
      try {
        process.kill(-pgid, "SIGTERM");
      } catch (error) {
        if (!isMissingProcessError(error)) {
          throw error;
        }
      }
    },
  };
}

async function buildAgentResult(options: {
  exitCode: number;
  duration: number;
  output: string;
  stdout: string;
  stderr: string;
  pgid: number;
  workingDirectory: string;
  env?: Record<string, string>;
  patterns?: AdapterErrorPattern[];
  normalizeOutput?: AdapterSpawnOptions["normalizeOutput"];
  forcedClassification?: ErrorClassification;
}): Promise<AgentResult> {
  const normalized = options.normalizeOutput?.({
    stdout: options.stdout,
    stderr: options.stderr,
    combined: options.output,
  }) ?? {
    stdout: options.stdout,
    stderr: options.stderr,
    output: options.output,
  };
  const scopedSignals = await readSignalsFromEnvScope(options.workingDirectory, options.env);
  const classification = options.forcedClassification ?? classifyError({
    exitCode: options.exitCode,
    stdout: normalized.stdout,
    stderr: normalized.stderr,
    completionSignal: scopedSignals.completionSignal,
    escalationSignal: scopedSignals.escalationSignal,
    patterns: options.patterns,
  });

  return {
    exitCode: options.exitCode,
    duration: options.duration,
    output: normalized.output,
    pgid: options.pgid,
    completionSignal: scopedSignals.completionSignal,
    escalationSignal: scopedSignals.escalationSignal,
    classification,
  };
}

async function readSignalsFromEnvScope(
  workingDirectory: string,
  env?: Record<string, string>,
): Promise<Awaited<ReturnType<typeof readScopedSignals>>> {
  const taskId = env?.OPENHARNESS_TASK_ID;
  const runId = env?.OPENHARNESS_RUN_ID;

  if (!taskId || !runId) {
    return {};
  }

  try {
    return await readScopedSignals(workingDirectory, { taskId, runId });
  } catch (error) {
    if (error instanceof ConflictingSignalsError) {
      return {
        completionSignal: undefined,
        escalationSignal: {
          reason: "conflicting_signals",
          rule: "signal_protocol",
          task_id: taskId,
          run_id: runId,
        },
      };
    }

    throw error;
  }
}

function normalizeExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (typeof code === "number") {
    return code;
  }
  if (signal) {
    return 128;
  }
  return 1;
}

function createOutputFileStream(outputFilePath?: string) {
  if (!outputFilePath) {
    return undefined;
  }
  mkdirSync(dirname(outputFilePath), { recursive: true });
  return createWriteStream(outputFilePath, { flags: "a" });
}

function writeRecordedProcess(workingDirectory: string, pid: number, pgid: number): void {
  const signalDir = join(workingDirectory, ".openharness");
  mkdirSync(signalDir, { recursive: true });
  writeFileSync(join(signalDir, "pid"), `${pid}\n`, "utf8");
  writeFileSync(join(signalDir, "pgid"), `${pgid}\n`, "utf8");
}

function isMissingProcessError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function worktreePathExists(workingDirectory: string): boolean {
  return existsSync(workingDirectory) && existsSync(join(workingDirectory, ".openharness", "worktree-meta.json"));
}

export function createOutputChannel(): AsyncIterable<string> & { push(chunk: string): void; close(): void } {
  const queued: string[] = [];
  const waiters: Array<(result: IteratorResult<string>) => void> = [];
  let closed = false;

  return {
    push(chunk: string) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value: chunk });
        return;
      }
      queued.push(chunk);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter({ done: true, value: undefined });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          const nextChunk = queued.shift();
          if (nextChunk !== undefined) {
            return Promise.resolve({ done: false, value: nextChunk });
          }
          if (closed) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise<IteratorResult<string>>((resolve) => {
            waiters.push(resolve);
          });
        },
      };
    },
  };
}
