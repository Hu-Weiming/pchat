import { describe, expect, it } from "vitest";
import { createHarness } from "../../../packages/harness/src/index";
import { createTestDependencies, testSettings } from "../../../packages/testing/src/index";
import { HARNESS_PROTOCOL_VERSION } from "@pchat/contracts";
import { createHarnessChannel } from "./harness-channel";
import { until } from "../../../packages/harness/test-support";

describe("private Windows Harness channel", () => {
  it("carries a validated command and correlated query through the same Harness", async () => {
    const harness = await createHarness(createTestDependencies());
    const channel = createHarnessChannel(harness, async () => {});
    const command = await channel.handle({ protocolVersion: 2, requestId: "host-command", method: "harness.request", params: {
      protocolVersion: HARNESS_PROTOCOL_VERSION, requestId: "client-command", type: "command",
      command: { type: "CreateConversation", commandId: "create", title: "讨论", settings: testSettings },
    } });
    expect(command).toMatchObject({ kind: "runtime.response", requestId: "host-command", ok: true, result: {
      protocolVersion: HARNESS_PROTOCOL_VERSION, requestId: "client-command", result: { ok: true, commandId: "create" },
    } });
    expect(await channel.handle({ protocolVersion: 2, requestId: "host-query", method: "harness.request", params: {
      protocolVersion: HARNESS_PROTOCOL_VERSION, requestId: "client-query", type: "query", query: { type: "ListConversations" },
    } })).toMatchObject({ ok: true, result: { requestId: "client-query", result: { ok: true, data: [{ title: "讨论" }] } } });
    await channel.close();
  });

  it("replays from the query bookmark even when changes commit before subscription", async () => {
    const harness = await createHarness(createTestDependencies());
    const snapshot = await harness.query({ type: "ListConversations" });
    await harness.dispatch({ type: "CreateConversation", commandId: "create", title: "讨论", settings: testSettings });
    const events: unknown[] = [];
    const channel = createHarnessChannel(harness, async (event) => { events.push(event); });
    try {
      expect(await channel.handle({ protocolVersion: 2, requestId: "subscribe", method: "harness.subscribe", params: { subscriptionId: "window", after: snapshot.lastEventSeq } }))
        .toMatchObject({ ok: true, result: { subscribed: true } });
      await until(() => events.length === 1);
      expect(events[0]).toMatchObject({ kind: "runtime.event", protocolVersion: 2, event: "harness", payload: {
        subscriptionId: "window", envelope: { protocolVersion: HARNESS_PROTOCOL_VERSION, event: { type: "ConversationCreated", seq: snapshot.lastEventSeq + 1 } },
      } });
    } finally { await channel.close(); }
  });

  it("unsubscribes pending reads and prevents events after the channel closes", async () => {
    const harness = await createHarness(createTestDependencies());
    const events: unknown[] = [];
    const channel = createHarnessChannel(harness, async (event) => { events.push(event); });
    const subscribe = { protocolVersion: 2, requestId: "subscribe", method: "harness.subscribe", params: { subscriptionId: "window", after: 0 } };
    expect(await channel.handle(subscribe)).toMatchObject({ ok: true });
    expect(await channel.handle({ protocolVersion: 2, requestId: "unsubscribe", method: "harness.unsubscribe", params: { subscriptionId: "window" } }))
      .toMatchObject({ ok: true, result: { unsubscribed: true } });
    await channel.close();
    expect(await channel.handle(subscribe)).toMatchObject({ ok: false, error: "RUNTIME_UNAVAILABLE" });
    await harness.dispatch({ type: "CreateConversation", commandId: "create", title: "讨论", settings: testSettings });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(events).toEqual([]);
  });

  it("signals refresh for an impossible bookmark without exposing internal errors", async () => {
    const harness = await createHarness(createTestDependencies());
    const events: unknown[] = [];
    const channel = createHarnessChannel(harness, async (event) => { events.push(event); });
    try {
      await channel.handle({ protocolVersion: 2, requestId: "subscribe", method: "harness.subscribe", params: { subscriptionId: "future", after: 99 } });
      await until(() => events.length > 0);
      expect(events).toEqual([{ kind: "runtime.event", protocolVersion: 2, event: "harness.closed", payload: { subscriptionId: "future", error: "REFRESH_REQUIRED" } }]);
    } finally { await channel.close(); }
  });

  it("does not duplicate a retried subscription or continue reading past host backpressure", async () => {
    const harness = await createHarness(createTestDependencies());
    await harness.dispatch({ type: "CreateConversation", commandId: "first", title: "一", settings: testSettings });
    await harness.dispatch({ type: "CreateConversation", commandId: "second", title: "二", settings: testSettings });
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const events: unknown[] = [];
    const channel = createHarnessChannel(harness, async (event) => { events.push(event); await held; });
    const request = { protocolVersion: 2, requestId: "subscribe", method: "harness.subscribe", params: { subscriptionId: "window", after: 0 } };
    try {
      expect(await channel.handle(request)).toMatchObject({ ok: true });
      expect(await channel.handle(request)).toMatchObject({ ok: true });
      expect(await channel.handle({ ...request, params: { ...request.params, after: 1 } })).toMatchObject({ ok: false, error: "INVALID_REQUEST" });
      await until(() => events.length === 1);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(events).toHaveLength(1);
      await channel.close();
      release();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(events).toHaveLength(1);
    } finally { release(); await channel.close(); }
  });

  it("rejects old private protocols and malformed methods before touching the Harness", async () => {
    const harness = await createHarness(createTestDependencies());
    const channel = createHarnessChannel(harness, async () => {});
    expect(await channel.handle({ protocolVersion: 1, requestId: "old", method: "harness.subscribe", params: { subscriptionId: "window", after: 0 } }))
      .toMatchObject({ ok: false, requestId: "old", error: "INVALID_REQUEST" });
    expect(await channel.handle({ protocolVersion: 2, requestId: "bad", method: "harness.request", params: { type: "command", command: { type: "arbitrary.shell" } } }))
      .toMatchObject({ ok: false, requestId: "bad", error: "INVALID_REQUEST" });
    expect(await harness.query({ type: "ListConversations" })).toMatchObject({ ok: true, data: [] });
    await channel.close();
  });
});
