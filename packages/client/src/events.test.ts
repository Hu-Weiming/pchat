import { describe, expect, it } from "vitest";
import { createHarness } from "../../harness/src/index";
import { createTestDependencies, testSettings } from "../../testing/src/index";
import { createClient, inProcessTransport } from "./index";

describe("client event bookmarks and subscription lifetime", () => {
  it("reads changes committed between a query and its subscription", async () => {
    const harness = await createHarness(createTestDependencies());
    let id = 0;
    const client = createClient({ ids: { next: () => `request-${++id}` }, transport: inProcessTransport(harness) });
    const snapshot = await client.query({ type: "ListConversations" });
    await client.dispatch({ type: "CreateConversation", commandId: "create", title: "讨论", settings: testSettings });
    const events = client.events(snapshot.lastEventSeq)[Symbol.asyncIterator]();
    expect(await events.next()).toMatchObject({ done: false, value: { seq: snapshot.lastEventSeq + 1, type: "ConversationCreated" } });
    await events.return?.();
  });

  it.each([
    { protocolVersion: 99, event: { seq: 1, at: 0, type: "RuntimeSuspended" } },
    { protocolVersion: 2, event: { seq: 1, at: 0, type: "unknown-event" } },
    { protocolVersion: 2, event: { seq: 2, at: 0, type: "RuntimeSuspended" } },
  ])("rejects incompatible or missing events and releases the subscription", async (event) => {
    let closed = 0;
    const client = createClient({ ids: { next: () => "request" }, transport: {
      async request() { throw new Error("Unused"); },
      async *events() { try { yield event; } finally { closed++; } },
    } });
    const events = client.events(0)[Symbol.asyncIterator]();
    await expect(events.next()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(closed).toBe(1);
  });

  it("closes a subscription promptly while its next transport event is pending", async () => {
    let closed = 0;
    const client = createClient({ ids: { next: () => "request" }, transport: {
      async request() { throw new Error("Unused"); },
      events() { return { [Symbol.asyncIterator]() { return {
        next: () => new Promise<IteratorResult<unknown>>(() => {}),
        async return() { closed++; return { done: true as const, value: undefined }; },
      }; } }; },
    } });
    const events = client.events(0)[Symbol.asyncIterator]();
    const next = events.next();
    await Promise.resolve();
    const closing = events.return?.();
    const result = await Promise.race([Promise.all([next, closing]).then(() => "closed"), (async () => {
      for (let i = 0; i < 50; i++) await Promise.resolve();
      return "still pending";
    })()]);
    expect(result).toBe("closed");
    expect(closed).toBe(1);
  });
});
