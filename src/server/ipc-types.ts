import type { RawData } from "ws";
import type { Task, TaskStatus, TransitionReason } from "../types.js";

export const IPC_REQUEST_TYPES = [
  "subscribe",
  "unsubscribe",
  "pause",
  "resume",
  "retry",
  "kill",
  "help",
  "accept",
  "dismiss",
  "re-evaluate",
  "get-logs",
  "shutdown",
  "get-status",
  "get-task",
  "authenticate",
  "report-completion",
  "report-escalation",
] as const;

export const IPC_RESPONSE_TYPES = [
  "snapshot",
  "task-summaries-updated",
  "tasks",
  "output",
  "output-ended",
  "status-change",
  "error",
  "ack",
  "logs",
  "kernel-status",
  "signal-ack",
  "task",
] as const;

export const MUTATING_IPC_REQUEST_TYPES = [
  "pause",
  "resume",
  "retry",
  "kill",
  "accept",
  "dismiss",
  "re-evaluate",
  "shutdown",
  "help",
  "report-completion",
  "report-escalation",
] as const satisfies ReadonlyArray<IpcRequest["type"]>;

export interface RuntimeTaskSummary {
  taskId: string;
  title: string;
  status: TaskStatus;
  updatedAt: string;
  lastOutputAt?: string;
  runHealth?: "active" | "quiet";
  transitionReason?: TransitionReason;
}

export type TaskStatusCounts = Record<TaskStatus, number>;

export interface SubscribeRequest {
  type: "subscribe";
  channel: "tasks" | "output";
  taskId?: string;
}

export interface UnsubscribeRequest {
  type: "unsubscribe";
  channel: "tasks" | "output";
  taskId?: string;
}

export interface PauseRequest {
  type: "pause";
  taskId: string;
}

export interface ResumeRequest {
  type: "resume";
  taskId: string;
}

export interface RetryRequest {
  type: "retry";
  taskId: string;
}

export interface KillRequest {
  type: "kill";
  taskId: string;
}

export interface HelpRequest {
  type: "help";
  taskId: string;
  hint: string;
}

export interface AcceptRequest {
  type: "accept";
  taskId: string;
}

export interface DismissRequest {
  type: "dismiss";
  taskId: string;
}

export interface ReEvaluateRequest {
  type: "re-evaluate";
  taskId: string;
}

export interface GetLogsRequest {
  type: "get-logs";
  taskId: string;
}

export interface ShutdownRequest {
  type: "shutdown";
}

export interface GetStatusRequest {
  type: "get-status";
}

export interface GetTaskRequest {
  type: "get-task";
  taskId: string;
}

export interface AuthenticateRequest {
  type: "authenticate";
  token: string;
}

export interface ReportCompletionRequest {
  type: "report-completion";
  taskId: string;
  summary: string;
}

export interface ReportEscalationRequest {
  type: "report-escalation";
  taskId: string;
  reason: string;
  rule: string;
}

export type IpcRequest =
  | SubscribeRequest
  | UnsubscribeRequest
  | PauseRequest
  | ResumeRequest
  | RetryRequest
  | KillRequest
  | HelpRequest
  | AcceptRequest
  | DismissRequest
  | ReEvaluateRequest
  | GetLogsRequest
  | ShutdownRequest
  | GetStatusRequest
  | GetTaskRequest
  | AuthenticateRequest
  | ReportCompletionRequest
  | ReportEscalationRequest;

export interface SnapshotResponse {
  type: "snapshot";
  sequence: number;
  counts: TaskStatusCounts;
  tasks: RuntimeTaskSummary[];
}

export interface TaskSummariesUpdatedResponse {
  type: "task-summaries-updated";
  sequence: number;
  summaries: RuntimeTaskSummary[];
}

export interface TasksResponse {
  type: "tasks";
  tasks: Task[];
}

export interface OutputResponse {
  type: "output";
  taskId: string;
  text: string;
}

/**
 * Output stream contract:
 * - Output subscriptions are live-only. Subscribers receive only chunks produced
 *   after the subscribe call. Historical output is available via `get-logs`.
 * - Output delivery is best-effort. Trailing chunks may be lost at process exit
 *   due to the race between output forwarding and exit handling.
 * - Output chunks are opaque text forwarded verbatim from agent stdout/stderr.
 * - Each client socket supports at most one output subscription at a time.
 */
export type OutputEndedReason = "completed" | "escalated" | "paused" | "retry" | "shutdown";

export interface OutputEndedResponse {
  type: "output-ended";
  taskId: string;
  reason: OutputEndedReason;
}

export interface StatusChangeResponse {
  type: "status-change";
  taskId: string;
  status: TaskStatus;
}

export interface ErrorResponse {
  type: "error";
  message: string;
}

export interface AckResponse {
  type: "ack";
  command: string;
  taskId?: string;
}

export interface RunLogSummary {
  runId: string;
  path: string;
}

export interface LogsResponse {
  type: "logs";
  taskId: string;
  logs: { runLogs: RunLogSummary[]; output: string };
}

export interface KernelStatusResponse {
  type: "kernel-status";
  counts: {
    pending: number;
    running: number;
    evaluating: number;
    completed: number;
    escalated: number;
    paused: number;
    merged: number;
  };
  tasks: Task[];
}

export interface SignalAckResponse {
  type: "signal-ack";
  taskId: string;
  signal: "completion" | "escalation";
}

export interface TaskResponse {
  type: "task";
  task: Task | null;
  taskId: string;
}

export type IpcResponse =
  | SnapshotResponse
  | TaskSummariesUpdatedResponse
  | TasksResponse
  | OutputResponse
  | OutputEndedResponse
  | StatusChangeResponse
  | ErrorResponse
  | AckResponse
  | LogsResponse
  | KernelStatusResponse
  | SignalAckResponse
  | TaskResponse;

export function isIpcRequestType(value: string): value is IpcRequest["type"] {
  return (IPC_REQUEST_TYPES as readonly string[]).includes(value);
}

export function isIpcResponseType(value: string): value is IpcResponse["type"] {
  return (IPC_RESPONSE_TYPES as readonly string[]).includes(value);
}

export function isMutatingIpcRequestType(value: string): value is (typeof MUTATING_IPC_REQUEST_TYPES)[number] {
  return (MUTATING_IPC_REQUEST_TYPES as readonly string[]).includes(value);
}

export function isIpcResponse(value: unknown): value is IpcResponse {
  return typeof value === "object"
    && value !== null
    && "type" in value
    && typeof (value as { type?: unknown }).type === "string"
    && isIpcResponseType((value as { type: string }).type);
}

export function normalizeIpcRawData(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}
