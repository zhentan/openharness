import crypto from "node:crypto";
import type http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Task } from "../types.js";
import type { RuntimeStateHub } from "./runtime-state-hub.js";
import type { IpcRequest, IpcResponse, OutputEndedReason } from "./ipc-types.js";
import { isIpcRequestType, isMutatingIpcRequestType, normalizeIpcRawData } from "./ipc-types.js";

type BuiltInWsRequest = Extract<
  IpcRequest,
  { type: "authenticate" | "subscribe" | "unsubscribe" | "get-status" | "get-task" }
>;
type ForwardedWsRequest = Exclude<IpcRequest, BuiltInWsRequest>;

export interface WsServerOptions {
  /** Standalone port — creates a new underlying TCP server. */
  port?: number;
  /** Shared HTTP server — attaches WebSocket upgrade handler to it (E9 Option B). */
  server?: http.Server;
  runtimeStateHub?: RuntimeStateHub;
  listTasks?: () => Promise<Task[]> | Task[];
  subscribeTaskOutput?: (taskId: string, listener: (chunk: string) => void, onEnded?: (reason: OutputEndedReason) => void) => (() => void) | undefined;
  onRequest?: (request: ForwardedWsRequest) => Promise<IpcResponse | undefined> | IpcResponse | undefined;
}

export interface ValidationResult {
  authorized: boolean;
}

export class WsServer {
  readonly token: string;
  readonly ready: Promise<void>;

  private readonly server: WebSocketServer;
  private readonly runtimeStateHub: RuntimeStateHub | undefined;
  private readonly listTasks: (() => Promise<Task[]>) | undefined;
  private readonly subscribeTaskOutput: WsServerOptions["subscribeTaskOutput"];
  private readonly onRequest: WsServerOptions["onRequest"];
  private readonly authenticatedClients = new WeakSet<WebSocket>();
  private readonly taskSubscriptions = new Map<WebSocket, () => void>();
  private readonly outputSubscriptions = new Map<WebSocket, () => void>();

  constructor(options: WsServerOptions) {
    this.token = crypto.randomBytes(24).toString("hex");
    this.runtimeStateHub = options.runtimeStateHub;
    const listTasks = options.listTasks;
    this.listTasks = listTasks
      ? async () => await listTasks()
      : undefined;
    this.subscribeTaskOutput = options.subscribeTaskOutput;
    this.onRequest = options.onRequest;

    // Support both standalone port (existing tests) and shared HTTP server (E9 Option B).
    if (options.server) {
      this.server = new WebSocketServer({ server: options.server });
      // When attached to an HTTP server, the WS server is ready when the HTTP
      // server is already listening (caller's responsibility).
      this.ready = Promise.resolve();
    } else {
      this.server = new WebSocketServer({ port: options.port ?? 0 });
      this.ready = new Promise((resolve, reject) => {
        this.server.once("listening", resolve);
        this.server.once("error", reject);
      });
    }

    this.server.on("connection", (socket) => {
      socket.on("message", (data) => {
        void this.handleSocketMessage(socket, data);
      });
      socket.on("close", () => {
        this.unsubscribeClient(socket);
      });
    });
  }

  get url(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("WebSocket server is not listening on a TCP port");
    }
    return `ws://127.0.0.1:${address.port}`;
  }

  validateRequest<T extends { type: string }>(request: T, token: string | null): ValidationResult {
    if (isMutatingIpcRequestType(request.type)) {
      return { authorized: token === this.token };
    }

    return { authorized: true };
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.taskSubscriptions.values()) {
      unsubscribe();
    }
    this.taskSubscriptions.clear();
    for (const unsubscribe of this.outputSubscriptions.values()) {
      unsubscribe();
    }
    this.outputSubscriptions.clear();

    // When attached to an HTTP server via { server }, wss.close() does NOT
    // terminate existing client connections. Explicitly close all clients
    // so they receive proper close frames.
    for (const client of this.server.clients) {
      client.close(1001, "Server shutting down");
    }

    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handleSocketMessage(socket: WebSocket, data: WebSocket.RawData): Promise<void> {
    const request = this.parseRequest(data);
    if (!request) {
      this.send(socket, { type: "error", message: "Invalid request" });
      return;
    }

    if (request.type === "authenticate") {
      if (request.token !== this.token) {
        this.send(socket, { type: "error", message: "Unauthorized" });
        return;
      }

      this.authenticatedClients.add(socket);
      this.send(socket, { type: "ack", command: "authenticate" });
      return;
    }

    const authToken = this.authenticatedClients.has(socket) ? this.token : null;
    const validation = this.validateRequest(request, authToken);
    if (!validation.authorized) {
      this.send(socket, { type: "error", message: "Unauthorized" });
      return;
    }

    if (request.type === "subscribe") {
      await this.handleSubscribe(socket, request);
      return;
    }

    if (request.type === "unsubscribe") {
      this.unsubscribeClient(socket);
      this.send(socket, { type: "ack", command: "unsubscribe", taskId: request.taskId });
      return;
    }

    if (request.type === "get-status") {
      if (!this.runtimeStateHub || !this.listTasks) {
        this.send(socket, { type: "error", message: "Task stream unavailable" });
        return;
      }
      this.send(socket, this.runtimeStateHub.createSnapshot(await this.listTasks()));
      return;
    }

    if (request.type === "get-task") {
      const tasks = this.listTasks ? await this.listTasks() : [];
      this.send(socket, {
        type: "task",
        taskId: request.taskId,
        task: tasks.find((task) => task.id === request.taskId) ?? null,
      });
      return;
    }

    const response = await this.onRequest?.(request as ForwardedWsRequest);
    if (response) {
      this.send(socket, response);
      return;
    }

    this.send(socket, {
      type: "ack",
      command: request.type,
      taskId: "taskId" in request && typeof request.taskId === "string" ? request.taskId : undefined,
    });
  }

  private async handleSubscribe(socket: WebSocket, request: Extract<IpcRequest, { type: "subscribe" }>): Promise<void> {
    if (request.channel !== "tasks") {
      if (request.channel === "output") {
        if (!request.taskId) {
          this.send(socket, { type: "error", message: "Output subscription requires taskId" });
          return;
        }
        if (!this.subscribeTaskOutput) {
          this.send(socket, { type: "error", message: "Output streaming not configured" });
          return;
        }

        this.unsubscribeOutputClient(socket);
        const subscribedTaskId = request.taskId;
        const unsubscribe = this.subscribeTaskOutput(
          subscribedTaskId,
          (chunk) => {
            this.send(socket, {
              type: "output",
              taskId: subscribedTaskId!,
              text: chunk,
            });
          },
          (reason) => {
            this.send(socket, {
              type: "output-ended",
              taskId: subscribedTaskId!,
              reason,
            });
          },
        );
        if (!unsubscribe) {
          this.send(socket, { type: "error", message: "Output streaming not configured" });
          return;
        }
        this.outputSubscriptions.set(socket, unsubscribe);
        this.send(socket, { type: "ack", command: "subscribe", taskId: request.taskId });
        return;
      }

      this.send(socket, { type: "ack", command: "subscribe", taskId: request.taskId });
      return;
    }

    if (!this.runtimeStateHub || !this.listTasks) {
      this.send(socket, { type: "error", message: "Task stream unavailable" });
      return;
    }

    this.unsubscribeClient(socket);
    const tasks = await this.listTasks();
    const unsubscribe = this.runtimeStateHub.subscribe((message) => {
      this.send(socket, message);
    }, tasks);
    this.taskSubscriptions.set(socket, unsubscribe);
  }

  private unsubscribeClient(socket: WebSocket): void {
    const unsubscribe = this.taskSubscriptions.get(socket);
    if (unsubscribe) {
      unsubscribe();
      this.taskSubscriptions.delete(socket);
    }
    this.unsubscribeOutputClient(socket);
  }

  private unsubscribeOutputClient(socket: WebSocket): void {
    const unsubscribe = this.outputSubscriptions.get(socket);
    if (!unsubscribe) {
      return;
    }
    unsubscribe();
    this.outputSubscriptions.delete(socket);
  }

  private parseRequest(data: WebSocket.RawData): IpcRequest | null {
    try {
      const value = JSON.parse(normalizeIpcRawData(data)) as unknown;
      if (!isRequest(value)) {
        return null;
      }
      return value;
    } catch {
      return null;
    }
  }

  private send(socket: WebSocket, message: IpcResponse): void {
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(message));
  }
}

function isRequest(value: unknown): value is IpcRequest {
  return typeof value === "object"
    && value !== null
    && "type" in value
    && typeof (value as { type?: unknown }).type === "string"
    && isIpcRequestType((value as { type: string }).type);
}
