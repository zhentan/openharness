import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompletionSignal, EscalationSignal } from "../types.js";

export interface SignalScope {
  taskId: string;
  runId: string;
}

export interface ScopedSignals {
  completionSignal?: CompletionSignal;
  escalationSignal?: EscalationSignal;
}

export class ConflictingSignalsError extends Error {
  constructor() {
    super("conflicting_signals: completion and escalation signals cannot both exist for one run");
    this.name = "ConflictingSignalsError";
  }
}

export async function readScopedSignals(worktreeDir: string, scope: SignalScope): Promise<ScopedSignals> {
  const signalDir = join(worktreeDir, ".openharness");

  const completionSignal = await readJsonIfScoped<CompletionSignal>(
    join(signalDir, "completion.json"),
    scope,
    isCompletionSignal,
  );
  const escalationSignal = await readJsonIfScoped<EscalationSignal>(
    join(signalDir, "escalation.json"),
    scope,
    isEscalationSignal,
  );

  if (completionSignal && escalationSignal) {
    throw new ConflictingSignalsError();
  }

  return { completionSignal, escalationSignal };
}

async function readJsonIfScoped<T extends { task_id?: string; run_id?: string }>(
  filePath: string,
  scope: SignalScope,
  guard: (value: unknown) => value is T,
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!guard(parsed)) {
    return undefined;
  }

  if (parsed.task_id !== scope.taskId || parsed.run_id !== scope.runId) {
    return undefined;
  }

  return parsed;
}

function isCompletionSignal(value: unknown): value is CompletionSignal {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.status === "completed" &&
    typeof value.summary === "string" &&
    optionalString(value.task_id) &&
    optionalString(value.run_id)
  );
}

function isEscalationSignal(value: unknown): value is EscalationSignal {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.reason === "string" &&
    typeof value.rule === "string" &&
    optionalString(value.task_id) &&
    optionalString(value.run_id)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}