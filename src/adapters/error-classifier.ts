import type {
  CompletionSignal,
  ErrorClassification,
  ErrorSeverity,
  EscalationSignal,
  TransitionReason,
} from "../types.js";

export interface AdapterErrorPattern {
  pattern: RegExp;
  severity: ErrorSeverity;
  reason: TransitionReason;
}

export interface ClassifyErrorInput {
  exitCode: number;
  stderr?: string;
  stdout?: string;
  completionSignal?: CompletionSignal;
  escalationSignal?: EscalationSignal;
  patterns?: AdapterErrorPattern[];
}

/**
 * Classify an agent exit into an ErrorClassification.
 *
 * Precedence (plan §5.1):
 *   1. Completion signal present → return undefined (no error to classify)
 *   2. Escalation signal present → AGENT / agent_escalated
 *   3. Exit 0 without signal → TRANSIENT / missing_signal (fail-closed, H11)
 *   4. Adapter stderr/stdout patterns → FATAL or TRANSIENT per pattern
 *   5. Exit 137 → TRANSIENT / sigkill_unknown (not assumed OOM)
 *   6. Fallback → TRANSIENT / transient_unknown
 *
 * Returns undefined only when completion signal is present — the caller
 * should treat this as "completed successfully, no error."
 */
export function classifyError(input: ClassifyErrorInput): ErrorClassification | undefined {
  // Precedence 1: completion signal is authoritative — no error
  if (input.completionSignal) {
    return undefined;
  }

  if (input.escalationSignal) {
    return {
      severity: "AGENT",
      reason: "agent_escalated",
      detail: input.escalationSignal.reason,
    };
  }

  if (input.exitCode === 0) {
    return {
      severity: "TRANSIENT",
      reason: "missing_signal",
      detail: "Process exited successfully without emitting a scoped completion or escalation signal.",
    };
  }

  const combinedOutput = [input.stderr, input.stdout].filter(Boolean).join("\n");
  for (const pattern of input.patterns ?? []) {
    if (pattern.pattern.test(combinedOutput)) {
      return {
        severity: pattern.severity,
        reason: pattern.reason,
        detail: combinedOutput || undefined,
      };
    }
  }

  if (input.exitCode === 137) {
    return {
      severity: "TRANSIENT",
      reason: "sigkill_unknown",
      detail: combinedOutput || undefined,
    };
  }

  return {
    severity: "TRANSIENT",
    reason: "transient_unknown",
    detail: combinedOutput || undefined,
  };
}