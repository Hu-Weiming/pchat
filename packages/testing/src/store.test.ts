import { describe, expect, it } from "vitest";
import { InMemoryStore } from "./index";

describe("InMemoryStore through RuntimeStore", () => {
  it("serializes synchronous writers and reads the complete committed state", async () => {
    const store = new InMemoryStore();
    const results = await Promise.all([
      store.transaction((state) => ++state.lastEventSeq),
      store.transaction((state) => ++state.lastEventSeq),
    ]);
    expect(results).toEqual([1, 2]);
    expect(await store.read((state) => state)).toEqual({
      epoch: 0, suspended: false, lastEventSeq: 2,
      conversations: [], turns: [], commands: [], events: [],
    });
  });

  it("rolls back a failed writer and keeps later writes usable", async () => {
    const store = new InMemoryStore();
    await expect(store.transaction((state) => {
      state.lastEventSeq = 100;
      throw new Error("failed write");
    })).rejects.toThrow("failed write");
    expect(await store.read((state) => state.lastEventSeq)).toBe(0);
    expect(await store.transaction((state) => ++state.lastEventSeq)).toBe(1);
  });

  it("isolates captured transaction drafts and query results from committed state", async () => {
    const store = new InMemoryStore();
    let changeCapturedDraft = () => {};
    const returned = await store.transaction((draft) => {
      draft.lastEventSeq = 1;
      changeCapturedDraft = () => { draft.lastEventSeq = 9; };
      return draft;
    });
    returned.lastEventSeq = 8;
    changeCapturedDraft();
    const readResult = await store.read((state) => state);
    readResult.events.push({ type: "ConversationCreated", conversationId: "intruder", seq: 9, at: 0 });
    expect(await store.read((state) => ({ seq: state.lastEventSeq, events: state.events })))
      .toEqual({ seq: 1, events: [] });
  });

  it("notifies only committed writes and listener failures do not affect other subscribers", async () => {
    const store = new InMemoryStore();
    const observations: Promise<number>[] = [];
    store.subscribe(() => { throw new Error("broken subscriber"); });
    const unsubscribe = store.subscribe(() => {
      observations.push(store.read((state) => state.lastEventSeq));
    });
    await store.transaction((state) => { state.lastEventSeq = 1; });
    await expect(store.transaction(() => { throw new Error("rollback"); })).rejects.toThrow();
    expect(await Promise.all(observations)).toEqual([0, 1]);
    unsubscribe();
    await store.transaction((state) => { state.lastEventSeq = 2; });
    expect(observations).toHaveLength(2);
    expect(await store.read((state) => state.lastEventSeq)).toBe(2);
  });

  it("rejects asynchronous transaction callbacks without committing their draft", async () => {
    const store = new InMemoryStore();
    await expect(store.transaction(async (state) => {
      state.lastEventSeq = 4;
      await Promise.resolve();
      state.lastEventSeq = 5;
    })).rejects.toThrow("synchronous");
    expect(await store.read((state) => state.lastEventSeq)).toBe(0);
  });
});
