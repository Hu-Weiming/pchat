import { describe, expect, it } from "vitest";
import { createHarness, type RuntimeState, type RuntimeStore } from "./index";
import { createTestDependencies } from "../../testing/src/index";
import { createConversation, until } from "../test-support";

/** A Store-port decorator exposes notifications and read timing, without
 * inspecting the Harness's implementation or mutating persistent state. */
class ObservedStore implements RuntimeStore {
  subscriptions = 0;
  reads = 0;
  afterRead: (() => Promise<void>) | undefined;
  readFailure: Error | undefined;
  constructor(private readonly delegate: RuntimeStore) {}

  async read<T>(reader: (snapshot: Readonly<RuntimeState>) => T): Promise<T> {
    this.reads++;
    if (this.readFailure) {
      const failure = this.readFailure;
      this.readFailure = undefined;
      throw failure;
    }
    const result = await this.delegate.read(reader);
    const hook = this.afterRead;
    this.afterRead = undefined;
    await hook?.();
    return result;
  }

  transaction<T>(writer: (draft: RuntimeState) => T): Promise<T> {
    return this.delegate.transaction(writer);
  }

  subscribe(listener: () => void): () => void {
    this.subscriptions++;
    const unsubscribe = this.delegate.subscribe(listener);
    return () => { this.subscriptions--; unsubscribe(); };
  }
}

async function fixture() {
  const dependencies = createTestDependencies();
  const store = new ObservedStore(dependencies.store);
  const harness = await createHarness({ ...dependencies, store });
  return { harness, store };
}

describe("query bookmarks and event subscriptions", () => {
  it("replays a change committed after a query and before subscription", async () => {
    const { harness } = await fixture();
    await createConversation(harness, "first");
    const snapshot = await harness.query({ type: "ListConversations" });
    const second = await createConversation(harness, "second");
    const iterator = harness.events(snapshot.lastEventSeq)[Symbol.asyncIterator]();
    try {
      expect(await iterator.next()).toMatchObject({
        done: false, value: { type: "ConversationCreated", conversationId: second, seq: 2 },
      });
    } finally {
      await iterator.return?.();
    }
  });

  it("continues from journal replay into changes committed during replay", async () => {
    const { harness } = await fixture();
    await createConversation(harness, "first");
    await createConversation(harness, "second");
    const iterator = harness.events()[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      await createConversation(harness, "third");
      const rest = [await iterator.next(), await iterator.next()];
      expect([first, ...rest].map((item) => item.value.seq)).toEqual([1, 2, 3]);
    } finally {
      await iterator.return?.();
    }
  });

  it("observes a commit after an empty journal scan and before entering the wait", async () => {
    const { harness, store } = await fixture();
    const snapshot = await harness.query({ type: "ListConversations" });
    const iterator = harness.events(snapshot.lastEventSeq)[Symbol.asyncIterator]();
    store.afterRead = async () => { await createConversation(harness, "between-scan-and-wait"); };
    try {
      expect(await iterator.next()).toMatchObject({ done: false, value: { type: "ConversationCreated", seq: 1 } });
    } finally {
      await iterator.return?.();
    }
  });

  it("serves concurrent next requests exactly once and in journal order", async () => {
    const { harness } = await fixture();
    const iterator = harness.events()[Symbol.asyncIterator]();
    try {
      const pending = Promise.all([iterator.next(), iterator.next(), iterator.next()]);
      await createConversation(harness, "first");
      await createConversation(harness, "second");
      await createConversation(harness, "third");
      expect((await pending).map((item) => item.value.seq)).toEqual([1, 2, 3]);
    } finally {
      await iterator.return?.();
    }
  });

  it("return ends pending reads and queued next calls without waiting for storage", async () => {
    const { harness, store } = await fixture();
    let releaseRead = () => {};
    const heldRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    let readIsHeld = false;
    store.afterRead = async () => { readIsHeld = true; await heldRead; };
    const iterator = harness.events()[Symbol.asyncIterator]();
    let settled = false;
    const pending = Promise.all([iterator.next(), iterator.next()]).then((results) => {
      settled = true;
      return results;
    });
    try {
      await until(() => readIsHeld);
      await iterator.return?.();
      await until(() => settled);
      expect(await pending).toEqual([{ done: true, value: undefined }, { done: true, value: undefined }]);
      expect(store.subscriptions).toBe(0);
    } finally {
      releaseRead();
    }
  });

  it("repeated return calls release a waiting subscription exactly once", async () => {
    const { harness, store } = await fixture();
    const iterator = harness.events()[Symbol.asyncIterator]();
    const pending = iterator.next();
    await until(() => store.reads > 0);
    await iterator.return?.();
    await iterator.return?.();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(store.subscriptions).toBe(0);
  });

  it("closes and releases its listener when reading the journal fails", async () => {
    const { harness, store } = await fixture();
    store.readFailure = new Error("Journal unavailable");
    const iterator = harness.events()[Symbol.asyncIterator]();
    const rejected = expect(iterator.next()).rejects.toThrow("Journal unavailable");
    const queued = iterator.next();
    try {
      await rejected;
      expect(store.subscriptions).toBe(0);
      expect(await queued).toEqual({ done: true, value: undefined });
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
    } finally {
      await iterator.return?.();
    }
  });

  it("rejects a cursor ahead of the committed journal so callers can query again", async () => {
    const { harness, store } = await fixture();
    await createConversation(harness, "first");
    const snapshot = await harness.query({ type: "ListConversations" });
    const iterator = harness.events(snapshot.lastEventSeq + 1)[Symbol.asyncIterator]();
    let finished = false;
    const result = iterator.next().then(
      (value) => { finished = true; return { ok: true, value }; },
      (error: unknown) => { finished = true; return { ok: false, error }; },
    );
    try {
      await until(() => finished);
      expect(await result).toMatchObject({ ok: false, error: expect.any(RangeError) });
      expect(store.subscriptions).toBe(0);
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
    } finally {
      await iterator.return?.();
    }
  });
});
