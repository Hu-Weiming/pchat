import { describe, expect, it } from "vitest";
import { createHarness, type RuntimeState, type RuntimeStore } from "./index";
import { createTestDependencies } from "../../testing/src/index";
import { createConversation, until, waitForTurn } from "../test-support";

class DelayedCommitStore implements RuntimeStore {
  held = false;
  release = () => {};
  private gate = new Promise<void>((resolve) => { this.release = resolve });
  constructor(private delegate: RuntimeStore, private kind: "RAG" | "MODEL", private phase: "PREPARED" | "IN_FLIGHT") {}
  read<T>(reader: (state: Readonly<RuntimeState>) => T) { return this.delegate.read(reader) }
  subscribe(listener: Parameters<RuntimeStore["subscribe"]>[0]) { return this.delegate.subscribe(listener) }
  async transaction<T>(writer: (state: RuntimeState) => T): Promise<T> {
    let hold = false;
    const result = await this.delegate.transaction((state) => {
      const count = () => state.turns.flatMap((turn) => turn.roleRuns).flatMap((role) => role.attempts).filter((attempt) => attempt.kind === this.kind && attempt.status === this.phase).length;
      const before = count();
      const result = writer(state);
      if (!this.held && count() > before) { this.held = true; hold = true }
      return result;
    });
    if (hold) await this.gate;
    return result;
  }
}

class FailingStore implements RuntimeStore {
  failures = 0;
  constructor(private delegate: RuntimeStore) {}
  read<T>(reader: (state: Readonly<RuntimeState>) => T) { return this.delegate.read(reader) }
  subscribe(listener: Parameters<RuntimeStore["subscribe"]>[0]) { return this.delegate.subscribe(listener) }
  transaction<T>(writer: (state: RuntimeState) => T): Promise<T> {
    if (this.failures > 0) { this.failures--; return Promise.reject(new Error("Injected persistence failure")) }
    return this.delegate.transaction(writer);
  }
}

describe("commit and external-send failure windows", () => {
  it.each(["RAG", "MODEL"] as const)("revokes old %s execution before a delayed commit acknowledgement resumes", async (kind) => {
    const deps = createTestDependencies();
    const store = new DelayedCommitStore(deps.store, kind, "IN_FLIGHT");
    const old = await createHarness({ ...deps, store });
    const conversationId = await createConversation(old);
    await old.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    await until(() => store.held);
    const recovered = await createHarness({ ...deps, store });
    const waiting = await waitForTurn(recovered, conversationId, "WAITING_USER");
    store.release();
    for (let i = 0; i < 50; i++) await recovered.query({ type: "GetTurn", turnId: waiting.id });
    expect(kind === "RAG" ? deps.rag.calls : deps.model.calls).toHaveLength(0);
    expect(waiting.roleRuns[0]?.attempts.at(-1)?.status).toBe("OUTCOME_UNKNOWN");
  });

  it("fails closed if both the result and the failure state cannot be committed", async () => {
    const deps = createTestDependencies();
    deps.rag.holdNext();
    const store = new FailingStore(deps.store);
    const harness = await createHarness({ ...deps, store });
    const conversationId = await createConversation(harness);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    await until(() => deps.rag.calls.length === 1);
    for (let i = 0; i < 10; i++) await harness.query({ type: "GetConversation", conversationId });
    store.failures = 2;
    deps.rag.calls[0]!.complete();
    for (let i = 0; i < 50; i++) await harness.query({ type: "GetConversation", conversationId });
    expect(await harness.query({ type: "GetConversation", conversationId })).toMatchObject({ ok: false, error: { code: "RUNTIME_UNAVAILABLE" } });
    expect(await harness.dispatch({ type: "SubmitQuestion", commandId: "B", conversationId, text: "B" })).toMatchObject({ ok: false, error: { code: "RUNTIME_UNAVAILABLE" } });
    expect(deps.rag.calls).toHaveLength(1);
    expect(deps.model.calls).toHaveLength(0);
    const recovered = await createHarness({ ...deps, store });
    const waiting = await waitForTurn(recovered, conversationId, "WAITING_USER");
    expect(waiting.roleRuns[0]?.attempts.map((attempt) => attempt.status)).toEqual(["OUTCOME_UNKNOWN"]);
  });
});
