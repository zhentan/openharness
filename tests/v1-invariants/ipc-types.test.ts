/**
 * P11: Typed IPC discriminated unions
 *
 * v1 proof: src/server/ipc-types.ts — IpcRequest/IpcResponse
 * Phase gate: 7
 *
 * The IPC contract is "messages are discriminated by `type`".
 * This test preserves that generically:
 * - every request/response variant has a unique `type`
 * - runtime routing can distinguish all known `type` values
 * - unknown `type` values are rejected
 * - the discriminant is the `type` field itself, not another property
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { IpcRequest, IpcResponse } from "../../src/server/ipc-types.js";

type MessageWithType = { type: string };
type TypeOf<T extends MessageWithType> = T["type"];

type IsUnion<T, Whole = T> = T extends T ? ([Whole] extends [T] ? false : true) : never;
type DuplicateDiscriminants<T extends MessageWithType> = {
  [K in TypeOf<T>]: IsUnion<Extract<T, { type: K }>> extends true ? K : never;
}[TypeOf<T>];

type AssertTrue<T extends true> = T;
type AssertNever<T extends never> = T;

type _RequestHasTypeDiscriminant = AssertTrue<IpcRequest extends MessageWithType ? true : false>;
type _ResponseHasTypeDiscriminant = AssertTrue<IpcResponse extends MessageWithType ? true : false>;
type _RequestTypeIsUnique = AssertNever<DuplicateDiscriminants<IpcRequest>>;
type _ResponseTypeIsUnique = AssertNever<DuplicateDiscriminants<IpcResponse>>;

describe("P11: Typed IPC discriminated unions", () => {
  it("keeps request and response variants keyed by unique runtime `type` values", async () => {
    const {
      IPC_REQUEST_TYPES,
      IPC_RESPONSE_TYPES,
      isIpcRequestType,
      isIpcResponseType,
    } = await import("../../src/server/ipc-types.js");

    expectTypeOf<(typeof IPC_REQUEST_TYPES)[number]>().toEqualTypeOf<IpcRequest["type"]>();
    expectTypeOf<IpcRequest["type"]>().toEqualTypeOf<(typeof IPC_REQUEST_TYPES)[number]>();
    expectTypeOf<(typeof IPC_RESPONSE_TYPES)[number]>().toEqualTypeOf<IpcResponse["type"]>();
    expectTypeOf<IpcResponse["type"]>().toEqualTypeOf<(typeof IPC_RESPONSE_TYPES)[number]>();

    expect(new Set(IPC_REQUEST_TYPES).size).toBe(IPC_REQUEST_TYPES.length);
    expect(new Set(IPC_RESPONSE_TYPES).size).toBe(IPC_RESPONSE_TYPES.length);

    for (const type of IPC_REQUEST_TYPES) {
      expect(isIpcRequestType(type)).toBe(true);
      expect(isIpcResponseType(type)).toBe(false);
    }

    for (const type of IPC_RESPONSE_TYPES) {
      expect(isIpcResponseType(type)).toBe(true);
      expect(isIpcRequestType(type)).toBe(false);
    }
  });

  it("can route every known request and response type at runtime", async () => {
    const {
      IPC_REQUEST_TYPES,
      IPC_RESPONSE_TYPES,
      isIpcRequestType,
      isIpcResponseType,
    } = await import("../../src/server/ipc-types.js");
    const routeMessage = createMessageRouter(isIpcRequestType, isIpcResponseType);

    for (const type of IPC_REQUEST_TYPES) {
      expect(routeMessage({ type })).toBe("request");
    }

    for (const type of IPC_RESPONSE_TYPES) {
      expect(routeMessage({ type })).toBe("response");
    }
  });

  it("rejects unknown types", async () => {
    const {
      IPC_REQUEST_TYPES,
      IPC_RESPONSE_TYPES,
      isIpcRequestType,
      isIpcResponseType,
    } = await import("../../src/server/ipc-types.js");
    const routeMessage = createMessageRouter(isIpcRequestType, isIpcResponseType);

    expect(routeMessage({ type: "__unknown_message__" })).toBeNull();
    expect(routeMessage({})).toBeNull();
    expect(routeMessage(null)).toBeNull();

    expect(isIpcRequestType("__unknown_request__")).toBe(false);
    expect(isIpcResponseType("__unknown_response__")).toBe(false);

    expect(new Set<string>([...IPC_REQUEST_TYPES, ...IPC_RESPONSE_TYPES]).has("__unknown_message__")).toBe(false);
  });

  it("uses the `type` field as the discriminant", async () => {
    const {
      IPC_REQUEST_TYPES,
      IPC_RESPONSE_TYPES,
      isIpcRequestType,
      isIpcResponseType,
    } = await import("../../src/server/ipc-types.js");
    const routeMessage = createMessageRouter(isIpcRequestType, isIpcResponseType);

    const requestType = IPC_REQUEST_TYPES[0];
    const responseType = IPC_RESPONSE_TYPES[0];

    expect(routeMessage({ type: requestType, unrelated: "ignored" })).toBe("request");
    expect(routeMessage({ type: responseType, payload: { any: "shape" } })).toBe("response");

    expect(routeMessage({ kind: requestType })).toBeNull();
    expect(routeMessage({ kind: responseType })).toBeNull();
    expect(routeMessage({ type: "__unknown_request__", kind: requestType })).toBeNull();
    expect(routeMessage({ type: "__unknown_response__", kind: responseType })).toBeNull();
  });

  it("classifies mutating request types from one shared source of truth", async () => {
    const {
      MUTATING_IPC_REQUEST_TYPES,
      isMutatingIpcRequestType,
      isIpcRequestType,
    } = await import("../../src/server/ipc-types.js");

    expect(new Set(MUTATING_IPC_REQUEST_TYPES).size).toBe(MUTATING_IPC_REQUEST_TYPES.length);

    for (const type of MUTATING_IPC_REQUEST_TYPES) {
      expect(isIpcRequestType(type)).toBe(true);
      expect(isMutatingIpcRequestType(type)).toBe(true);
    }

    expect(isMutatingIpcRequestType("subscribe")).toBe(false);
    expect(isMutatingIpcRequestType("get-status")).toBe(false);
    expect(isMutatingIpcRequestType("authenticate")).toBe(false);
  });

  it("accepts only known IPC responses when validating runtime messages", async () => {
    const { isIpcResponse } = await import("../../src/server/ipc-types.js");

    expect(isIpcResponse({ type: "ack", command: "pause", taskId: "t_1" })).toBe(true);
    expect(isIpcResponse({ type: "snapshot", sequence: 0, counts: {}, tasks: [] })).toBe(true);
    expect(isIpcResponse({ type: "bogus" })).toBe(false);
    expect(isIpcResponse({ command: "pause" })).toBe(false);
    expect(isIpcResponse(null)).toBe(false);
  });

  it("normalizes websocket raw payload shapes consistently", async () => {
    const { normalizeIpcRawData } = await import("../../src/server/ipc-types.js");

    expect(normalizeIpcRawData(Buffer.from("hello", "utf8"))).toBe("hello");
    expect(normalizeIpcRawData([Buffer.from("hel", "utf8"), Buffer.from("lo", "utf8")])).toBe("hello");
    expect(normalizeIpcRawData(new TextEncoder().encode("hello").buffer)).toBe("hello");
  });
});

function createMessageRouter(
  isIpcRequestType: (value: string) => boolean,
  isIpcResponseType: (value: string) => boolean,
) {
  return (value: unknown): "request" | "response" | null => {
    if (!isRecord(value) || typeof value.type !== "string") {
      return null;
    }

    if (isIpcRequestType(value.type)) {
      return "request";
    }

    if (isIpcResponseType(value.type)) {
      return "response";
    }

    return null;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
