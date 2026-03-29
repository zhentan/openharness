import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { vi } from "vitest";

export interface MockChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

/**
 * Create a mock child process for adapter tests.
 * Has piped stdout/stderr, a pid, and a kill stub.
 */
export function createMockChild(pid: number): MockChild {
  const child = new EventEmitter() as MockChild;
  child.pid = pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

/**
 * Create a mock child that has a pid but no stdout/stderr
 * (simulates partial spawn failure).
 */
export function createPartialMockChild(pid: number): EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout?: PassThrough;
    stderr?: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.kill = vi.fn(() => true);
  return child;
}
