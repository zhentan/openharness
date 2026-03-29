export interface MergeOptions {
  taskId: string;
  attemptsRemaining?: boolean;
  performMerge?: () => Promise<void>;
  runPostMergeChecks?: () => Promise<void>;
  revertMerge?: () => Promise<void>;
}

export interface MergeResult {
  nextStatus: "merged";
}

export async function mergeWorktreeToMain(options: MergeOptions): Promise<MergeResult> {
  if (!options.performMerge) {
    const error = new Error(`No merge implementation configured for task ${options.taskId}`);
    Object.assign(error, {
      nextStatus: "escalated" as const,
      taskId: options.taskId,
    });
    throw error;
  }

  const performMerge = options.performMerge;
  const runPostMergeChecks = options.runPostMergeChecks ?? (async () => {});
  const revertMerge = options.revertMerge ?? (async () => {});

  try {
    await performMerge();
    await runPostMergeChecks();
    return { nextStatus: "merged" };
  } catch (error) {
    let revertFailure: unknown;
    try {
      await revertMerge();
    } catch (revertError) {
      revertFailure = revertError;
    }

    const nextStatus = options.attemptsRemaining === false ? "escalated" : "retry_pending";
    const mergeError = error instanceof Error ? error : new Error(String(error));
    if (revertFailure !== undefined && !("cause" in mergeError)) {
      Object.assign(mergeError, { cause: revertFailure });
    }
    Object.assign(mergeError, { nextStatus, taskId: options.taskId });
    throw mergeError;
  }
}
