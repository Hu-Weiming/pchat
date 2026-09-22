import { expect, it } from "vitest";
import { createClient } from "@pchat/client";
import { createHarness } from "../../../../packages/harness/src/index";
import { createTestDependencies, testSettings } from "../../../../packages/testing/src/index";
import { createHarnessChannel } from "../../../runtime-windows/src/harness-channel";
import { createWindowsTransport, type WindowsBridge } from "./windows-transport";
import { until } from "../../../../packages/harness/test-support";

it("carries client queries and bookmark replay over private host messages, including events before subscribe acknowledgment", async () => {
  const harness = await createHarness(createTestDependencies());
  const listeners = new Set<(event: unknown) => void>();
  const channel = createHarnessChannel(harness, async (event) => { for (const listener of listeners) listener(event); });
  const bridge: WindowsBridge = {
    request: (request) => channel.handle(request),
    async listen(handler) { listeners.add(handler); return () => { listeners.delete(handler); }; },
  };
  let sequence = 0;
  const client = createClient({ transport: createWindowsTransport(bridge, { next: () => `host-${++sequence}` }), ids: { next: () => `client-${++sequence}` } });
  const snapshot = await client.query({ type: "ListConversations" });
  expect(await client.dispatch({ type: "CreateConversation", commandId: "create", title: "讨论", settings: testSettings })).toMatchObject({ ok: true });
  const iterator = client.events(snapshot.lastEventSeq)[Symbol.asyncIterator]();
  try {
    expect(await iterator.next()).toMatchObject({ done: false, value: { type: "ConversationCreated", seq: snapshot.lastEventSeq + 1 } });
    const pending = iterator.next();
    await iterator.return?.();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(listeners.size).toBe(0);
  } finally { await iterator.return?.(); await channel.close(); }
});

function fixture() {
  let listener: ((event: unknown) => void) | undefined;
  let disposed = 0;
  let sequence = 0;
  const requests: unknown[] = [];
  const bridge: WindowsBridge = {
    async request(input) {
      requests.push(input);
      const message = input as { requestId: string; method: string };
      return { kind: "runtime.response", protocolVersion: 2, requestId: message.requestId, ok: true, result: message.method === "harness.subscribe" ? { subscribed: true } : { unsubscribed: true } };
    },
    async listen(handler) { listener = handler; return () => { disposed++; }; },
  };
  return { bridge, requests, emit: (event: unknown) => listener?.(event), disposed: () => disposed,
    iterator: () => createWindowsTransport(bridge, { next: () => `id-${++sequence}` }).events(0)[Symbol.asyncIterator]() };
}

it("bounds the desktop event backlog and requires a new query instead of silently losing messages", async () => {
  const test = fixture();
  const iterator = test.iterator();
  const first = iterator.next();
  await until(() => test.requests.length === 1);
  for (let seq = 1; seq <= 1026; seq++) test.emit({ kind: "runtime.event", protocolVersion: 2, event: "harness", payload: {
    subscriptionId: "id-1", envelope: { protocolVersion: 3, event: { seq, at: 0, type: "RuntimeSuspended" } },
  } });
  expect(await first).toMatchObject({ done: false });
  await expect(iterator.next()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(test.disposed()).toBe(1);
  await iterator.return?.();
});

it("rejects a malformed subscription acknowledgment and releases its native listener", async () => {
  const test = fixture();
  test.bridge.request = async (input) => ({ kind: "runtime.response", protocolVersion: 2, requestId: (input as { requestId: string }).requestId, ok: true, result: { subscribed: false } });
  const iterator = test.iterator();
  const pending = iterator.next();
  const outcome = pending.then(() => "resolved", () => "rejected");
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(test.disposed()).toBe(1);
  expect(await outcome).toBe("rejected");
  await iterator.return?.();
});

it("closes immediately while subscribe acknowledgment is held and unsubscribes after it arrives", async () => {
  const test = fixture();
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const original = test.bridge.request;
  test.bridge.request = async (input) => {
    const response = await original(input);
    if ((input as { method: string }).method === "harness.subscribe") await held;
    return response;
  };
  const iterator = test.iterator();
  const pending = iterator.next();
  await until(() => test.requests.length === 1);
  await iterator.return?.();
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(test.disposed()).toBe(1);
  release();
  await until(() => test.requests.length === 2);
  expect(test.requests[1]).toMatchObject({ method: "harness.unsubscribe", params: { subscriptionId: "id-1" } });
});

it("disposes a listener that attaches after cancellation without ever subscribing", async () => {
  const test = fixture();
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const original = test.bridge.listen;
  test.bridge.listen = async (handler) => { await held; return original(handler); };
  const iterator = test.iterator();
  const pending = iterator.next();
  await iterator.return?.();
  expect(await pending).toEqual({ done: true, value: undefined });
  release();
  await until(() => test.disposed() === 1);
  expect(test.requests).toEqual([]);
});

it("ignores another window's valid events and fails closed for an invalid protocol", async () => {
  const test = fixture();
  const iterator = test.iterator();
  const pending = iterator.next();
  const rejected = expect(pending).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await until(() => test.requests.length === 1);
  test.emit({ kind: "runtime.event", protocolVersion: 2, event: "harness.closed", payload: { subscriptionId: "another-window", error: "REFRESH_REQUIRED" } });
  expect(test.disposed()).toBe(0);
  test.emit({ kind: "runtime.event", protocolVersion: 1, event: "harness", payload: { secret: "do-not-expose" } });
  await rejected;
  expect(test.disposed()).toBe(1);
  await iterator.return?.();
});
