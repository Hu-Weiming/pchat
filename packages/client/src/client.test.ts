import { describe, expect, it } from "vitest";
import { createHarness } from "../../harness/src/index";
import { createTestDependencies, testSettings } from "../../testing/src/index";
import { waitForTurn } from "../../harness/test-support";
import { createClient, inProcessTransport } from "./index";
import type { ClientRequest } from "./index";

describe("PchatClient through the same Harness interface", () => {
  it("refuses the old single-participant wire version after the multi-participant contract upgrade", async () => {
    const client = createClient({ ids: { next: () => "request" }, transport: {
      async request() { return { protocolVersion: 1, requestId: "request", result: { ok: true, lastEventSeq: 0, data: [] } }; },
      async *events() {},
    } });
    await expect(client.query({ type: "ListConversations" })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });
  it("correlates new transport requests while replaying the same business command once", async () => {
    const deps = createTestDependencies();
    const harness = await createHarness(deps);
    const transport = inProcessTransport(harness);
    const requests: unknown[] = [];
    let sequence = 0;
    const client = createClient({
      ids: { next: () => `request-${++sequence}` },
      transport: { ...transport, async request(request) { requests.push(request); return transport.request(request); } },
    });
    const created = await client.dispatch({ type: "CreateConversation", commandId: "create", title: "讨论", settings: testSettings });
    if (!created.ok || !created.conversationId) throw new Error("Expected conversation creation");
    const command = { type: "SubmitQuestion" as const, commandId: "submit", conversationId: created.conversationId, text: "何为知识？" };
    const first = await client.dispatch(command);
    expect(await client.dispatch(command)).toEqual(first);
    const turn = await waitForTurn(client, created.conversationId, "COMPLETED");
    expect(await client.query({ type: "GetTurn", turnId: turn.id })).toMatchObject({ ok: true, data: turn });
    expect(requests[1]).toMatchObject({ requestId: "request-2", command: { commandId: "submit" } });
    expect(requests[2]).toMatchObject({ requestId: "request-3", command: { commandId: "submit" } });
    expect(deps.model.calls).toHaveLength(1);
    expect(deps.rag.calls).toHaveLength(1);
  });

  it.each([
    { protocolVersion: 99, requestId: "request-1", result: { ok: true, lastEventSeq: 0, data: [] } },
    { protocolVersion: 3, requestId: "wrong-request", result: { ok: true, lastEventSeq: 0, data: [] } },
    { protocolVersion: 3, requestId: "request-1", result: { ok: true, lastEventSeq: 0, data: { id: "wrong projection" } } },
    { protocolVersion: 3, requestId: "request-1", result: { ok: true, lastEventSeq: -1, data: [] } },
  ])("rejects a response with a mismatched protocol, correlation or projection", async (response) => {
    const client = createClient({ ids: { next: () => "request-1" }, transport: { async request() { return response; }, async *events() {} } });
    await expect(client.query({ type: "ListConversations" })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  it("rejects extra credential fields before sending a request", async () => {
    let calls = 0;
    const client = createClient({ ids: { next: () => "request" }, transport: {
      async request() { calls++; throw new Error("Should not be called"); }, async *events() {},
    } });
    const input = { type: "SubmitQuestion" as const, commandId: "submit", conversationId: "conversation", text: "Q", apiKey: "credential-marker" };
    await expect(client.dispatch(input)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls).toBe(0);
  });

  it("sanitizes a lost transport receipt without automatically repeating the command", async () => {
    let calls = 0;
    const client = createClient({ ids: { next: () => "request" }, transport: {
      async request() { calls++; throw new Error("credential-marker in transport error"); }, async *events() {},
    } });
    const pending = client.dispatch({ type: "SubmitQuestion", commandId: "submit", conversationId: "conversation", text: "Q" });
    await expect(pending).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(pending).rejects.not.toThrow("credential-marker");
    expect(calls).toBe(1);
  });

  it("refuses an incompatible incoming envelope before dispatching to the Harness", async () => {
    const harness = await createHarness(createTestDependencies());
    const transport = inProcessTransport(harness);
    const request = { protocolVersion: 99, requestId: "request", type: "command", command: {
      type: "CreateConversation", commandId: "create", title: "讨论", settings: testSettings,
    } };
    await expect(transport.request(request as ClientRequest)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await harness.query({ type: "ListConversations" })).toMatchObject({ ok: true, data: [] });
  });

  it("correlates against the submitted command snapshot when the caller changes its object", async () => {
    const harness = await createHarness(createTestDependencies());
    const transport = inProcessTransport(harness);
    let release = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const client = createClient({ ids: { next: () => "request" }, transport: {
      ...transport, async request(request) { const response = await transport.request(request); await hold; return response; },
    } });
    const command = { type: "CreateConversation" as const, commandId: "create", title: "讨论", settings: testSettings };
    const pending = client.dispatch(command);
    command.commandId = "changed-by-caller";
    release();
    await expect(pending).resolves.toMatchObject({ ok: true, commandId: "create" });
  });
});
