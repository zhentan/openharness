import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Task } from "../../src/types.js";

describe("Phase 7: websocket server", () => {
  const servers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server) {
        await server.close();
      }
    }
  });

  it("sends a runtime snapshot when a client subscribes to tasks", async () => {
    const { createRuntimeStateHub } = await import("../../src/server/runtime-state-hub.js");
    const { WsServer } = await import("../../src/server/ws-server.js");

    const hub = createRuntimeStateHub();
    const tasks = [createTask({ id: "task_1", status: "pending", enqueued_at: "2026-03-28T02:00:00.000Z" })];
    const server = new WsServer({ port: 0, runtimeStateHub: hub, listTasks: async () => tasks });
    servers.push(server);
    await server.ready;

    const client = new WebSocket(server.url);
    await waitForOpen(client);

    client.send(JSON.stringify({ type: "subscribe", channel: "tasks" }));
    const snapshot = await waitForMessage(client);

    expect(snapshot).toEqual({
      type: "snapshot",
      sequence: 0,
      counts: {
        pending: 1,
        reserved: 0,
        pre_eval: 0,
        generator_running: 0,
        evaluator_running: 0,
        revisions_requested: 0,
        completed: 0,
        merge_pending: 0,
        merged: 0,
        paused: 0,
        retry_pending: 0,
        escalated: 0,
      },
      tasks: [
        {
          taskId: "task_1",
          title: "Task task_1",
          status: "pending",
          updatedAt: "2026-03-28T02:00:00.000Z",
        },
      ],
    });

    client.close();
  });

  it("relays runtime state hub deltas to subscribed clients", async () => {
    const { createRuntimeStateHub } = await import("../../src/server/runtime-state-hub.js");
    const { WsServer } = await import("../../src/server/ws-server.js");

    const hub = createRuntimeStateHub({ batchMs: 5 });
    const tasks = [createTask({ id: "task_1", status: "pending", enqueued_at: "2026-03-28T02:00:00.000Z" })];
    const server = new WsServer({ port: 0, runtimeStateHub: hub, listTasks: async () => tasks });
    servers.push(server);
    await server.ready;

    const client = new WebSocket(server.url);
    await waitForOpen(client);

    client.send(JSON.stringify({ type: "subscribe", channel: "tasks" }));
    await waitForMessage(client);

    const updatedAt = new Date().toISOString();
    hub.queueTaskUpdate(createTask({ id: "task_1", status: "generator_running" }), {
      updatedAt,
    });

    const delta = await waitForMessage(client);
    expect(delta).toEqual({
      type: "task-summaries-updated",
      sequence: 1,
      summaries: [
        {
          taskId: "task_1",
          title: "Task task_1",
          status: "generator_running",
          updatedAt,
          runHealth: "active",
        },
      ],
    });

    client.close();
  });

  it("rejects mutating commands over the socket until the client authenticates", async () => {
    const { createRuntimeStateHub } = await import("../../src/server/runtime-state-hub.js");
    const { WsServer } = await import("../../src/server/ws-server.js");

    const server = new WsServer({ port: 0, runtimeStateHub: createRuntimeStateHub(), listTasks: async () => [] });
    servers.push(server);
    await server.ready;

    const client = new WebSocket(server.url);
    await waitForOpen(client);

    client.send(JSON.stringify({ type: "pause", taskId: "task_1" }));
    const error = await waitForMessage(client);

    expect(error).toEqual({
      type: "error",
      message: "Unauthorized",
    });

    client.close();
  });

  it("accepts authenticate then forwards mutating commands to the handler", async () => {
    const { createRuntimeStateHub } = await import("../../src/server/runtime-state-hub.js");
    const { WsServer } = await import("../../src/server/ws-server.js");

    const seen: Array<{ type: string; taskId?: string }> = [];
    const server = new WsServer({
      port: 0,
      runtimeStateHub: createRuntimeStateHub(),
      listTasks: async () => [],
      onRequest: async (request) => {
        seen.push({ type: request.type, taskId: "taskId" in request ? request.taskId : undefined });
      },
    });
    servers.push(server);
    await server.ready;

    const client = new WebSocket(server.url);
    await waitForOpen(client);

    client.send(JSON.stringify({ type: "authenticate", token: server.token }));
    const authAck = await waitForMessage(client);
    expect(authAck).toEqual({ type: "ack", command: "authenticate" });

    client.send(JSON.stringify({ type: "pause", taskId: "task_1" }));
    const pauseAck = await waitForMessage(client);
    expect(pauseAck).toEqual({ type: "ack", command: "pause", taskId: "task_1" });
    expect(seen).toEqual([{ type: "pause", taskId: "task_1" }]);

    client.close();
  });

  it("returns a snapshot for get-status", async () => {
    const { createRuntimeStateHub } = await import("../../src/server/runtime-state-hub.js");
    const { WsServer } = await import("../../src/server/ws-server.js");

    const tasks = [
      createTask({ id: "task_1", status: "pending", enqueued_at: "2026-03-28T02:00:00.000Z" }),
      createTask({ id: "task_2", status: "paused", assigned_at: "2026-03-28T02:01:00.000Z" }),
    ];
    const server = new WsServer({
      port: 0,
      runtimeStateHub: createRuntimeStateHub(),
      listTasks: async () => tasks,
    });
    servers.push(server);
    await server.ready;

    const client = new WebSocket(server.url);
    await waitForOpen(client);

    client.send(JSON.stringify({ type: "get-status" }));
    const snapshot = await waitForMessage(client);

    expect(snapshot).toEqual({
      type: "snapshot",
      sequence: 0,
      counts: {
        pending: 1,
        reserved: 0,
        pre_eval: 0,
        generator_running: 0,
        evaluator_running: 0,
        revisions_requested: 0,
        completed: 0,
        merge_pending: 0,
        merged: 0,
        paused: 1,
        retry_pending: 0,
        escalated: 0,
      },
      tasks: [
        {
          taskId: "task_1",
          title: "Task task_1",
          status: "pending",
          updatedAt: "2026-03-28T02:00:00.000Z",
        },
        {
          taskId: "task_2",
          title: "Task task_2",
          status: "paused",
          updatedAt: "2026-03-28T02:01:00.000Z",
        },
      ],
    });

    client.close();
  });

  it("returns an individual task for get-task", async () => {
    const { WsServer } = await import("../../src/server/ws-server.js");

    const tasks = [
      createTask({ id: "task_1", status: "pending" }),
      createTask({ id: "task_2", status: "generator_running" }),
    ];
    const server = new WsServer({
      port: 0,
      listTasks: async () => tasks,
    });
    servers.push(server);
    await server.ready;

    const client = new WebSocket(server.url);
    await waitForOpen(client);

    client.send(JSON.stringify({ type: "get-task", taskId: "task_2" }));
    const taskResponse = await waitForMessage(client);

    expect(taskResponse).toEqual({
      type: "task",
      taskId: "task_2",
      task: expect.objectContaining({
        id: "task_2",
        title: "Task task_2",
        status: "generator_running",
      }),
    });

    client.send(JSON.stringify({ type: "get-task", taskId: "missing" }));
    const missingResponse = await waitForMessage(client);

    expect(missingResponse).toEqual({
      type: "task",
      taskId: "missing",
      task: null,
    });

    client.close();
  });

  it("relays live output chunks to clients subscribed to a task output channel", async () => {
    const { WsServer } = await import("../../src/server/ws-server.js");

    let pushChunk: ((chunk: string) => void) | undefined;
    const server = new WsServer({
      port: 0,
      subscribeTaskOutput: (_taskId, listener) => {
        pushChunk = listener;
        return () => {
          pushChunk = undefined;
        };
      },
    });
    servers.push(server);
    await server.ready;

    const client = new WebSocket(server.url);
    await waitForOpen(client);

    client.send(JSON.stringify({ type: "subscribe", channel: "output", taskId: "task_1" }));
    const ack = await waitForMessage(client);
    expect(ack).toEqual({ type: "ack", command: "subscribe", taskId: "task_1" });

    pushChunk?.("first line\n");
    const output = await waitForMessage(client);
    expect(output).toEqual({
      type: "output",
      taskId: "task_1",
      text: "first line\n",
    });

    client.close();
  });

  it("rejects output subscriptions without a taskId", async () => {
    const { WsServer } = await import("../../src/server/ws-server.js");

    const server = new WsServer({
      port: 0,
      subscribeTaskOutput: () => () => undefined,
    });
    servers.push(server);
    await server.ready;

    const client = new WebSocket(server.url);
    await waitForOpen(client);

    client.send(JSON.stringify({ type: "subscribe", channel: "output" }));
    const error = await waitForMessage(client);
    expect(error).toEqual({
      type: "error",
      message: "Output subscription requires taskId",
    });

    client.close();
  });

  it("stops relaying output after the client unsubscribes", async () => {
    const { WsServer } = await import("../../src/server/ws-server.js");

    let pushChunk: ((chunk: string) => void) | undefined;
    const server = new WsServer({
      port: 0,
      subscribeTaskOutput: (_taskId, listener) => {
        pushChunk = listener;
        return () => {
          pushChunk = undefined;
        };
      },
    });
    servers.push(server);
    await server.ready;

    const client = new WebSocket(server.url);
    await waitForOpen(client);

    client.send(JSON.stringify({ type: "subscribe", channel: "output", taskId: "task_1" }));
    await waitForMessage(client);

    client.send(JSON.stringify({ type: "unsubscribe", channel: "output", taskId: "task_1" }));
    const ack = await waitForMessage(client);
    expect(ack).toEqual({ type: "ack", command: "unsubscribe", taskId: "task_1" });
    expect(pushChunk).toBeUndefined();

    client.close();
  });
});

function createTask(overrides: Partial<Task> & Pick<Task, "id" | "status">): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? `Task ${overrides.id}`,
    status: overrides.status,
    priority: overrides.priority ?? "medium",
    depends_on: overrides.depends_on ?? [],
    agent_prompt: overrides.agent_prompt ?? "Do the thing",
    exploration_budget: overrides.exploration_budget ?? {
      max_attempts: 3,
      timeout_per_attempt: 15,
      total_timeout: 60,
    },
    escalation_rules: overrides.escalation_rules ?? [],
    previous_attempts: overrides.previous_attempts,
    enqueued_at: overrides.enqueued_at,
    assigned_at: overrides.assigned_at,
    completed_at: overrides.completed_at,
    cooldown_until: overrides.cooldown_until,
    current_attempt: overrides.current_attempt,
    crash_count: overrides.crash_count,
  };
}

async function waitForOpen(client: WebSocket): Promise<void> {
  if (client.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket open"));
    }, 5_000);

    const cleanup = () => {
      clearTimeout(timeout);
      client.off("open", onOpen);
      client.off("error", onError);
    };

    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    client.on("open", onOpen);
    client.on("error", onError);
  });
}

async function waitForMessage(client: WebSocket): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket message"));
    }, 5_000);

    const cleanup = () => {
      clearTimeout(timeout);
      client.off("message", onMessage);
      client.off("error", onError);
    };

    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]) => {
      cleanup();
      resolve(JSON.parse(normalizeMessageData(data)) as unknown);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    client.on("message", onMessage);
    client.on("error", onError);
  });
}

function normalizeMessageData(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}
