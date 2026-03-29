// Connection module for the OpenHarness dashboard.
//
// Manages the lifecycle: bootstrap fetch → WebSocket connect → authenticate →
// subscribe → snapshot/delta processing → reconnect on failure.
//
// Design:
// - Dependency-injectable (fetch, WebSocket) for Node.js testing with `ws`.
// - No browser-only APIs except through injected deps.
// - Reconnect replaces all state from a fresh snapshot (I5).
// - No sequence gap detection (E14, F14).
// - No explicit unsubscribe before close (edge case #32).
// - Authenticate before subscribe for forward compat with controls (I3).

import type {
  BootstrapData,
  IpcResponse,
  SnapshotResponse,
  TaskSummary,
  TaskSummariesUpdatedResponse,
  Task,
  LogsResponse,
  OutputResponse,
  OutputEndedResponse,
  OutputEndedReason,
} from "../types.js";

export type { TaskSummary } from "../types.js";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export type ControlResult =
  | { ok: true }
  | { ok: false; error: string };

export interface TaskDetailResult {
  task: Task | null;
}

export interface LogsResult {
  runLogs: Array<{ runId: string; path: string }>;
  output: string;
}

export interface OutputListener {
  onChunk: (text: string) => void;
  onEnded: (reason: OutputEndedReason) => void;
}

export interface ConnectionConfig {
  bootstrapUrl: string;
  maxRetries?: number;   // default 20
  baseRetryMs?: number;  // default 1000
  maxRetryMs?: number;   // default 30000
  ackTimeoutMs?: number; // default 5000 — timeout waiting for control ack
}

export interface ConnectionCallbacks {
  onStateChange: (state: ConnectionState) => void;
  onTasksUpdated: (tasks: ReadonlyMap<string, TaskSummary>) => void;
  onError?: (message: string) => void;
}

export interface ConnectionDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  WebSocket: new (url: string) => WebSocket;
}

export interface KernelConnection {
  readonly state: ConnectionState;
  readonly tasks: ReadonlyMap<string, TaskSummary>;
  connect(): void;
  disconnect(): void;
  /** Fetch full task object via get-task. Returns null if task not found. */
  getTask(taskId: string): Promise<TaskDetailResult>;
  /** Fetch latest run logs via get-logs. */
  getLogs(taskId: string): Promise<LogsResult>;
  /** Subscribe to live output for a running task. Returns unsubscribe function. */
  subscribeOutput(taskId: string, listener: OutputListener): () => void;
  /** Send pause control. Resolves on ack/error/timeout — does NOT change task status. */
  pauseTask(taskId: string): Promise<ControlResult>;
  /** Send resume control. Resolves on ack/error/timeout — does NOT change task status. */
  resumeTask(taskId: string): Promise<ControlResult>;
  /** Send kill control. Resolves on ack/error/timeout — does NOT change task status. */
  killTask(taskId: string): Promise<ControlResult>;
}

export function createKernelConnection(
  config: ConnectionConfig,
  callbacks: ConnectionCallbacks,
  deps: ConnectionDeps,
): KernelConnection {
  const maxRetries = config.maxRetries ?? 20;
  const baseRetryMs = config.baseRetryMs ?? 1000;
  const maxRetryMs = config.maxRetryMs ?? 30000;
  const ackTimeoutMs = config.ackTimeoutMs ?? 5000;

  let state: ConnectionState = "disconnected";
  const tasks = new Map<string, TaskSummary>();
  let socket: WebSocket | null = null;
  let retryCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;
  let intentionalDisconnect = false;

  // Request/response correlation for get-task and get-logs
  type PendingRequest = {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  };
  const pendingTaskRequests = new Map<string, PendingRequest>();
  const pendingLogsRequests = new Map<string, PendingRequest>();

  // Pending control requests — keyed by "command:taskId" for ack correlation.
  // Errors from the server don't carry taskId, so we use a FIFO queue as fallback.
  const CONTROL_COMMANDS = new Set(["pause", "resume", "kill"]);
  type PendingControl = {
    resolve: (result: ControlResult) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  const pendingControls = new Map<string, PendingControl>();
  // FIFO queue for error correlation (errors don't carry command/taskId)
  const controlQueue: string[] = [];

  // Output subscription state (one subscription at a time per client)
  let activeOutputSubscription: { taskId: string; listener: OutputListener } | null = null;

  function setState(newState: ConnectionState): void {
    if (state === newState) return;
    state = newState;
    callbacks.onStateChange(newState);
  }

  function cleanup(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    // Reject all pending requests
    const disconnectError = new Error("Connection closed");
    for (const [, pending] of pendingTaskRequests) pending.reject(disconnectError);
    pendingTaskRequests.clear();
    for (const [, pending] of pendingLogsRequests) pending.reject(disconnectError);
    pendingLogsRequests.clear();
    // Resolve pending controls with error (not reject — controls return ControlResult)
    for (const [, pending] of pendingControls) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "Connection closed" });
    }
    pendingControls.clear();
    controlQueue.length = 0;
    // Clear output subscription
    activeOutputSubscription = null;

    if (socket) {
      const s = socket;
      socket = null;
      // Remove listeners before closing to avoid triggering reconnect
      s.onopen = null;
      s.onmessage = null;
      s.onclose = null;
      s.onerror = null;
      if (s.readyState === s.OPEN || s.readyState === s.CONNECTING) {
        s.close();
      }
    }
  }

  async function fetchBootstrap(signal: AbortSignal): Promise<BootstrapData | null> {
    try {
      const res = await deps.fetch(config.bootstrapUrl, { signal });
      if (res.status === 503) {
        return null; // Kernel shutting down or not ready
      }
      if (!res.ok) {
        callbacks.onError?.(`Bootstrap failed: HTTP ${res.status}`);
        return null;
      }
      return (await res.json()) as BootstrapData;
    } catch (error) {
      if ((error as Error).name === "AbortError") return null;
      // Bootstrap unreachable (ECONNREFUSED, network error)
      return null;
    }
  }

  function connectWebSocket(bootstrap: BootstrapData): void {
    const ws = deps.WebSocket ? new deps.WebSocket(bootstrap.wsUrl) : null;
    if (!ws) {
      callbacks.onError?.("WebSocket constructor unavailable");
      handleConnectionFailure();
      return;
    }

    socket = ws;
    let authenticated = false;
    let subscribed = false;

    ws.onopen = () => {
      // Authenticate first (I3)
      ws.send(JSON.stringify({ type: "authenticate", token: bootstrap.token }));
    };

    ws.onmessage = (event) => {
      let msg: IpcResponse;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)) as IpcResponse;
      } catch {
        return; // Ignore unparseable messages
      }

      if (!authenticated) {
        if (msg.type === "error") {
          // Auth rejected — don't retry with same token (F4)
          callbacks.onError?.(`Authentication failed: ${msg.message}`);
          cleanup();
          setState("disconnected");
          return;
        }
        if (msg.type === "ack" && (msg as { command: string }).command === "authenticate") {
          authenticated = true;
          // Subscribe to task stream
          ws.send(JSON.stringify({ type: "subscribe", channel: "tasks" }));
          subscribed = true;
          return;
        }
        return;
      }

      // Route control ack — ack with command in CONTROL_COMMANDS and a taskId
      if (msg.type === "ack") {
        const ack = msg as import("../types.js").AckResponse;
        if (CONTROL_COMMANDS.has(ack.command) && ack.taskId) {
          const key = `${ack.command}:${ack.taskId}`;
          const pending = pendingControls.get(key);
          if (pending) {
            clearTimeout(pending.timer);
            pendingControls.delete(key);
            const idx = controlQueue.indexOf(key);
            if (idx !== -1) controlQueue.splice(idx, 1);
            pending.resolve({ ok: true });
          }
          return;
        }
      }

      // Route control error — errors don't carry taskId, use FIFO queue
      if (msg.type === "error" && controlQueue.length > 0) {
        const key = controlQueue.shift()!;
        const pending = pendingControls.get(key);
        if (pending) {
          clearTimeout(pending.timer);
          pendingControls.delete(key);
          pending.resolve({ ok: false, error: msg.message });
          return;
        }
      }

      if (msg.type === "snapshot") {
        applySnapshot(msg as SnapshotResponse);
        retryCount = 0; // Successful connection resets retry budget
        setState("connected");
        return;
      }

      if (msg.type === "task-summaries-updated") {
        applyDelta(msg as TaskSummariesUpdatedResponse);
        return;
      }

      // Route task response to pending request
      if (msg.type === "task") {
        const resp = msg as import("../types.js").TaskResponse;
        const pending = pendingTaskRequests.get(resp.taskId);
        if (pending) {
          pendingTaskRequests.delete(resp.taskId);
          pending.resolve({ task: resp.task });
        }
        return;
      }

      // Route logs response to pending request
      if (msg.type === "logs") {
        const resp = msg as LogsResponse;
        const pending = pendingLogsRequests.get(resp.taskId);
        if (pending) {
          pendingLogsRequests.delete(resp.taskId);
          pending.resolve(resp.logs);
        }
        return;
      }

      // Route output chunk to active subscription
      if (msg.type === "output") {
        const resp = msg as OutputResponse;
        if (activeOutputSubscription && activeOutputSubscription.taskId === resp.taskId) {
          activeOutputSubscription.listener.onChunk(resp.text);
        }
        return;
      }

      // Route output-ended to active subscription
      if (msg.type === "output-ended") {
        const resp = msg as OutputEndedResponse;
        if (activeOutputSubscription && activeOutputSubscription.taskId === resp.taskId) {
          const listener = activeOutputSubscription.listener;
          activeOutputSubscription = null;
          listener.onEnded(resp.reason);
        }
        return;
      }

      if (msg.type === "error") {
        callbacks.onError?.(msg.message);
        return;
      }

      // For empty kernel: after subscribing, the server may send no snapshot
      // (E8 fix ensures it always does, but be defensive). If we sent subscribe
      // and haven't received a snapshot, we're still waiting. The server fix
      // guarantees a snapshot arrives, so this path is a safety net only.
    };

    ws.onclose = () => {
      if (socket !== ws) return; // Stale socket — already replaced
      socket = null;

      if (intentionalDisconnect) {
        setState("disconnected");
        return;
      }

      // Unexpected close — attempt reconnect
      handleConnectionFailure();
    };

    ws.onerror = () => {
      // The close event will fire after this — let onclose handle state
    };
  }

  function applySnapshot(snapshot: SnapshotResponse): void {
    // Replace all state from fresh snapshot (I5)
    tasks.clear();
    for (const summary of snapshot.tasks) {
      tasks.set(summary.taskId, summary);
    }
    callbacks.onTasksUpdated(tasks);
  }

  function applyDelta(delta: TaskSummariesUpdatedResponse): void {
    // Process ALL summaries in the batch (F17, edge case #33)
    for (const summary of delta.summaries) {
      tasks.set(summary.taskId, summary); // Upsert — handles unknown tasks (edge case #20)
    }
    callbacks.onTasksUpdated(tasks);
  }

  function handleConnectionFailure(): void {
    cleanup();

    if (intentionalDisconnect) {
      setState("disconnected");
      return;
    }

    if (retryCount >= maxRetries) {
      setState("disconnected");
      callbacks.onError?.(`Disconnected after ${maxRetries} reconnect attempts`);
      return;
    }

    setState("reconnecting");
    const delay = Math.min(baseRetryMs * Math.pow(2, retryCount), maxRetryMs);
    retryCount++;

    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (intentionalDisconnect) {
        setState("disconnected");
        return;
      }
      void attemptConnection();
    }, delay);
  }

  async function attemptConnection(): Promise<void> {
    if (intentionalDisconnect) {
      setState("disconnected");
      return;
    }

    abortController = new AbortController();
    const bootstrap = await fetchBootstrap(abortController.signal);
    abortController = null;

    if (intentionalDisconnect) {
      setState("disconnected");
      return;
    }

    if (!bootstrap) {
      handleConnectionFailure();
      return;
    }

    connectWebSocket(bootstrap);
  }

  return {
    get state() { return state; },
    get tasks() { return tasks as ReadonlyMap<string, TaskSummary>; },

    connect() {
      if (state === "connecting" || state === "connected" || state === "reconnecting") return;
      intentionalDisconnect = false;
      retryCount = 0;
      tasks.clear();
      setState("connecting");
      void attemptConnection();
    },

    disconnect() {
      intentionalDisconnect = true;
      cleanup();
      tasks.clear();
      setState("disconnected");
    },

    getTask(taskId: string): Promise<TaskDetailResult> {
      return new Promise((resolve, reject) => {
        if (!socket || state !== "connected") {
          reject(new Error("Not connected"));
          return;
        }
        pendingTaskRequests.set(taskId, {
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        socket.send(JSON.stringify({ type: "get-task", taskId }));
      });
    },

    getLogs(taskId: string): Promise<LogsResult> {
      return new Promise((resolve, reject) => {
        if (!socket || state !== "connected") {
          reject(new Error("Not connected"));
          return;
        }
        pendingLogsRequests.set(taskId, {
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        socket.send(JSON.stringify({ type: "get-logs", taskId }));
      });
    },

    subscribeOutput(taskId: string, listener: OutputListener): () => void {
      // Unsubscribe previous if any
      if (activeOutputSubscription && socket && state === "connected") {
        socket.send(JSON.stringify({
          type: "unsubscribe",
          channel: "output",
          taskId: activeOutputSubscription.taskId,
        }));
      }
      activeOutputSubscription = { taskId, listener };

      if (socket && state === "connected") {
        socket.send(JSON.stringify({
          type: "subscribe",
          channel: "output",
          taskId,
        }));
      }

      return () => {
        if (activeOutputSubscription?.taskId === taskId) {
          activeOutputSubscription = null;
          if (socket && state === "connected") {
            socket.send(JSON.stringify({
              type: "unsubscribe",
              channel: "output",
              taskId,
            }));
          }
        }
      };
    },

    pauseTask(taskId: string): Promise<ControlResult> {
      return sendControl("pause", taskId);
    },

    resumeTask(taskId: string): Promise<ControlResult> {
      return sendControl("resume", taskId);
    },

    killTask(taskId: string): Promise<ControlResult> {
      return sendControl("kill", taskId);
    },
  };

  function sendControl(command: string, taskId: string): Promise<ControlResult> {
    if (!socket || state !== "connected") {
      return Promise.resolve({ ok: false, error: "Not connected" });
    }

    const key = `${command}:${taskId}`;

    // If there's already a pending control for this exact command+task, return it
    const existing = pendingControls.get(key);
    if (existing) {
      return new Promise((resolve) => {
        // Chain: when existing resolves, we resolve with the same result.
        // But actually, just replace — dedup per reviewer spec (edge case: double-click)
        clearTimeout(existing.timer);
        pendingControls.delete(key);
        const idx = controlQueue.indexOf(key);
        if (idx !== -1) controlQueue.splice(idx, 1);
        existing.resolve({ ok: false, error: "Superseded by new request" });
      });
    }

    return new Promise<ControlResult>((resolve) => {
      const timer = setTimeout(() => {
        pendingControls.delete(key);
        const idx = controlQueue.indexOf(key);
        if (idx !== -1) controlQueue.splice(idx, 1);
        resolve({ ok: false, error: `Control ${command} timed out after ${ackTimeoutMs}ms` });
      }, ackTimeoutMs);

      pendingControls.set(key, { resolve, timer });
      controlQueue.push(key);
      socket!.send(JSON.stringify({ type: command, taskId }));
    });
  }
}
