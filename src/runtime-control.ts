import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import type {
  IpcRequest,
  IpcResponse,
  SnapshotResponse,
  TaskSummariesUpdatedResponse,
} from "./server/ipc-types.js";
import {
  isIpcResponse,
  isMutatingIpcRequestType,
  normalizeIpcRawData,
} from "./server/ipc-types.js";
import { sleep } from "./utils/sleep.js";

export interface RuntimeControlInfo {
  pid: number;
  url: string;
  token: string;
}

export interface WaitForRuntimeStopOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export class RuntimeUnavailableError extends Error {
  constructor(message = "Kernel is not running.") {
    super(message);
    this.name = "RuntimeUnavailableError";
  }
}

export function getRuntimeControlPath(repoDir: string): string {
  return join(repoDir, ".openharness", "runtime-control.json");
}

export async function writeRuntimeControlInfo(repoDir: string, info: RuntimeControlInfo): Promise<void> {
  const controlPath = getRuntimeControlPath(repoDir);
  const tempPath = `${controlPath}.tmp-${process.pid}`;

  await mkdir(dirname(controlPath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(info, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, controlPath);
}

export async function removeRuntimeControlInfo(repoDir: string, expectedPid?: number): Promise<void> {
  const controlPath = getRuntimeControlPath(repoDir);

  try {
    const current = JSON.parse(await readFile(controlPath, "utf8")) as Partial<RuntimeControlInfo>;
    if (expectedPid !== undefined && current.pid !== expectedPid) {
      return;
    }
    await unlink(controlPath);
  } catch {
    // Already removed or unreadable.
  }
}

export async function readRuntimeControlInfo(repoDir: string): Promise<RuntimeControlInfo> {
  const controlPath = getRuntimeControlPath(repoDir);

  let parsed: RuntimeControlInfo;
  try {
    parsed = JSON.parse(await readFile(controlPath, "utf8")) as RuntimeControlInfo;
  } catch {
    throw new RuntimeUnavailableError();
  }

  if (!isRuntimeControlInfo(parsed)) {
    await removeRuntimeControlInfo(repoDir);
    throw new RuntimeUnavailableError();
  }

  if (!isProcessAlive(parsed.pid)) {
    await removeRuntimeControlInfo(repoDir, parsed.pid);
    throw new RuntimeUnavailableError();
  }

  return parsed;
}

export async function waitForRuntimeStop(
  repoDir: string,
  options: WaitForRuntimeStopOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await readRuntimeControlInfo(repoDir);
    } catch (error) {
      if (error instanceof RuntimeUnavailableError) {
        return;
      }
      throw error;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for kernel shutdown after ${timeoutMs}ms.`);
}

export async function sendRuntimeCommand(repoDir: string, request: IpcRequest): Promise<IpcResponse> {
  const control = await readRuntimeControlInfo(repoDir);
  const socket = new WebSocket(control.url);

  try {
    await waitForSocketOpen(socket);

    if (isMutatingIpcRequestType(request.type)) {
      socket.send(JSON.stringify({ type: "authenticate", token: control.token } satisfies IpcRequest));
      const authResponse = await waitForNextResponse(socket);
      if (authResponse.type === "error") {
        throw new Error(authResponse.message);
      }
    }

    socket.send(JSON.stringify(request));
    const response = await waitForNextResponse(socket);
    if (response.type === "error") {
      throw new Error(response.message);
    }
    return response;
  } finally {
    socket.terminate();
  }
}

export function watchTaskStream(
  repoDir: string,
): AsyncGenerator<SnapshotResponse | TaskSummariesUpdatedResponse> {
  const queue: Array<SnapshotResponse | TaskSummariesUpdatedResponse> = [];
  const waiters: Array<() => void> = [];
  let streamError: Error | undefined;
  let closed = false;
  let finalized = false;
  let socket: WebSocket | undefined;
  let initPromise: Promise<void> | undefined;

  const notify = (): void => {
    for (const waiter of waiters.splice(0)) {
      waiter();
    }
  };

  const finalize = (): void => {
    if (finalized) {
      return;
    }
    finalized = true;
    closed = true;
    if (socket) {
      socket.removeAllListeners();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    }
    notify();
  };

  const ensureConnected = async (): Promise<void> => {
    if (initPromise) {
      await initPromise;
      return;
    }

    initPromise = (async () => {
      const control = await readRuntimeControlInfo(repoDir);
      if (finalized) {
        return;
      }

      socket = new WebSocket(control.url);

      socket.on("message", (data) => {
        try {
          const response = parseIpcResponse(normalizeIpcRawData(data));
          if (!response) {
            return;
          }
          if (response.type === "error") {
            streamError = new Error(response.message);
            notify();
            return;
          }
          if (response.type === "snapshot" || response.type === "task-summaries-updated") {
            queue.push(response);
            notify();
          }
        } catch (error) {
          streamError = error instanceof Error ? error : new Error(String(error));
          notify();
        }
      });
      socket.on("close", () => {
        closed = true;
        notify();
      });
      socket.on("error", (error) => {
        streamError = error instanceof Error ? error : new Error(String(error));
        notify();
      });

      try {
        await waitForSocketOpen(socket);
        if (finalized) {
          socket.terminate();
          return;
        }
        socket.send(JSON.stringify({ type: "subscribe", channel: "tasks" } satisfies IpcRequest));
      } catch (error) {
        streamError = error instanceof Error ? error : new Error(String(error));
        closed = true;
        notify();
      }
    })();

    await initPromise;
  };

  const waitForEvent = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  };

  const iterator: AsyncGenerator<SnapshotResponse | TaskSummariesUpdatedResponse> = {
    async next() {
      await ensureConnected();

      while (true) {
        const nextMessage = queue.shift();
        if (nextMessage) {
          return { done: false, value: nextMessage };
        }
        if (streamError) {
          throw streamError;
        }
        if (closed) {
          return { done: true, value: undefined };
        }

        await waitForEvent();
      }
    },
    async return(value?: unknown) {
      finalize();
      return { done: true, value: value as undefined };
    },
    async throw(error?: unknown) {
      finalize();
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    [Symbol.asyncDispose]: async () => {
      finalize();
    },
  };

  return iterator;
}

function isRuntimeControlInfo(value: unknown): value is RuntimeControlInfo {
  return typeof value === "object"
    && value !== null
    && typeof (value as { pid?: unknown }).pid === "number"
    && typeof (value as { url?: unknown }).url === "string"
    && typeof (value as { token?: unknown }).token === "string";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off("open", onOpen);
      socket.off("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.on("open", onOpen);
    socket.on("error", onError);
  });
}

async function waitForNextResponse(socket: WebSocket): Promise<IpcResponse> {
  return await new Promise<IpcResponse>((resolve, reject) => {
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onMessage = (data: WebSocket.RawData) => {
      const response = parseIpcResponse(normalizeIpcRawData(data));
      if (!response) {
        cleanup();
        reject(new Error("Invalid response from runtime control server"));
        return;
      }
      cleanup();
      resolve(response);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Runtime control connection closed unexpectedly"));
    };

    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

function parseIpcResponse(raw: string): IpcResponse | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return isIpcResponse(value) ? value : null;
  } catch {
    return null;
  }
}
