/**
 * Minimal tick loop with reentrancy guard (H18).
 *
 * Phase 2: wires TaskStore → Scheduler. Phase 6 replaces this with
 * the full kernel tick loop.
 */

export interface TickLoop {
  start(): void;
  stop(): void;
}

interface TickLoopOptions {
  intervalMs: number;
  onError?: (err: unknown) => void;
}

/**
 * Create a tick loop that calls `tickFn` on a fixed interval.
 * If a previous tick is still running, the next tick is skipped.
 * This prevents overlapping ticks from double-dispatching tasks.
 */
export function createTickLoop(tickFn: () => Promise<void>, options: TickLoopOptions): TickLoop {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function guardedTick(): Promise<void> {
    if (running) return; // Reentrancy guard (H18)
    running = true;
    try {
      await tickFn();
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      const handleError = (err: unknown) => {
        if (options.onError) options.onError(err);
        else console.error("[tick] Unhandled tick error:", err);
      };
      // Run first tick immediately, then on interval
      guardedTick().catch(handleError);
      timer = setInterval(() => {
        guardedTick().catch(handleError);
      }, options.intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
