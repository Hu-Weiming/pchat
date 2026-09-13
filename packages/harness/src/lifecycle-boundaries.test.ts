import { describe, expect, it } from "vitest";
import { createHarness, type RuntimeState, type RuntimeStore } from "./index";
import { createTestDependencies } from "../../testing/src/index";
import { createConversation, until, waitForTurn } from "../test-support";

class CommitGate {
  entered = false;
  release = () => {};
  readonly pending = new Promise<void>((resolve) => { this.release = resolve; });
  constructor(readonly matches: (state: RuntimeState) => boolean) {}
}

/** Commit notifications still arrive immediately; only the caller's receipt is
 * delayed. Rollback injection throws inside the actual Store transaction. */
class LifecycleStore implements RuntimeStore {
  readonly gates: CommitGate[] = [];
  rollback: ((draft: RuntimeState) => boolean) | undefined;
  constructor(private readonly delegate: RuntimeStore) {}

  hold(matches: (state: RuntimeState) => boolean) {
    const gate = new CommitGate(matches);
    this.gates.push(gate);
    return gate;
  }

  read<T>(reader: (snapshot: Readonly<RuntimeState>) => T) { return this.delegate.read(reader); }
  subscribe(listener: Parameters<RuntimeStore["subscribe"]>[0]) { return this.delegate.subscribe(listener); }

  async transaction<T>(writer: (draft: RuntimeState) => T): Promise<T> {
    const held: CommitGate[] = [];
    const result = await this.delegate.transaction((draft) => {
      const value = writer(draft);
      if (this.rollback?.(draft)) {
        this.rollback = undefined;
        throw new Error("Injected transaction rollback");
      }
      for (const gate of this.gates) {
        if (!gate.entered && gate.matches(draft)) { gate.entered = true; held.push(gate); }
      }
      return value;
    });
    for (const gate of held) await gate.pending;
    return result;
  }
}

function hasAttempt(state: RuntimeState, kind: "RAG" | "MODEL", status: "PREPARED" | "IN_FLIGHT") {
  return state.turns.some((turn) => turn.roleRuns.some((role) => role.attempts.some((attempt) => attempt.kind === kind && attempt.status === status)));
}

describe("lifecycle boundaries around committed state", () => {
  it.each([
    ["StopTurn", "RAG"], ["StopTurn", "MODEL"],
    ["SuspendRuntime", "RAG"], ["SuspendRuntime", "MODEL"],
  ] as const)("%s revokes %s before either pending commit acknowledgement returns", async (control, kind) => {
    const deps = createTestDependencies();
    const store = new LifecycleStore(deps.store);
    const sendGate = store.hold((state) => hasAttempt(state, kind, "IN_FLIGHT"));
    const harness = await createHarness({ ...deps, store });
    const conversationId = await createConversation(harness);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    await until(() => sendGate.entered);
    const active = await waitForTurn(harness, conversationId, "RUNNING");
    const controlGate = store.hold((state) => state.commands.some((item) => item.receipt.commandId === "control"));
    let acknowledged = false;
    const pending = harness.dispatch(control === "StopTurn"
      ? { type: "StopTurn", commandId: "control", turnId: active.id }
      : { type: "SuspendRuntime", commandId: "control" }).then((receipt) => { acknowledged = true; return receipt; });
    try {
      await until(() => controlGate.entered);
      const interrupted = await waitForTurn(harness, conversationId, control === "StopTurn" ? "STOPPED" : "WAITING_USER");
      expect(interrupted.roleRuns[0]?.attempts.at(-1)?.status).toBe("OUTCOME_UNKNOWN");
      sendGate.release();
      for (let index = 0; index < 50; index++) await harness.query({ type: "GetTurn", turnId: active.id });
      expect(acknowledged).toBe(false);
      expect(kind === "RAG" ? deps.rag.calls : deps.model.calls).toHaveLength(0);
    } finally {
      sendGate.release();
      controlGate.release();
      await pending;
    }
  });

  it("does not start a factory whose initial epoch acknowledgement arrives after replacement", async () => {
    const firstDeps = createTestDependencies();
    const store = new LifecycleStore(firstDeps.store);
    const initialGate = store.hold((state) => state.epoch === 1);
    const lateFactory = createHarness({ ...firstDeps, store });
    await until(() => initialGate.entered);
    const currentDeps = createTestDependencies();
    currentDeps.rag.holdNext();
    const current = await createHarness({ ...currentDeps, store });
    const conversationId = await createConversation(current);
    await current.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    await until(() => currentDeps.rag.calls.length === 1);
    let retrievalReleased = false;
    try {
      initialGate.release();
      const replaced = await lateFactory;
      expect(await replaced.dispatch({ type: "SubmitQuestion", commandId: "stale", conversationId, text: "Stale" }))
        .toMatchObject({ ok: false, error: { code: "RUNTIME_REPLACED" } });
      currentDeps.rag.calls[0]!.complete();
      retrievalReleased = true;
      await waitForTurn(current, conversationId, "COMPLETED");
      expect(firstDeps.rag.calls).toHaveLength(0);
      expect(firstDeps.model.calls).toHaveLength(0);
      expect(currentDeps.rag.calls).toHaveLength(1);
      expect(currentDeps.model.calls).toHaveLength(1);
    } finally {
      initialGate.release();
      if (!retrievalReleased) currentDeps.rag.calls[0]!.complete();
    }
  });

  it.each(["RAG", "MODEL"] as const)("cancels a prepared %s attempt during recovery without sending it", async (kind) => {
    const deps = createTestDependencies();
    const store = new LifecycleStore(deps.store);
    const preparedGate = store.hold((state) => hasAttempt(state, kind, "PREPARED"));
    const old = await createHarness({ ...deps, store });
    const conversationId = await createConversation(old);
    await old.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    await until(() => preparedGate.entered);
    try {
      const recovered = await createHarness({ ...deps, store });
      const waiting = await waitForTurn(recovered, conversationId, "WAITING_USER");
      expect(waiting.roleRuns[0]?.attempts.at(-1)).toMatchObject({ kind, status: "CANCELLED" });
      preparedGate.release();
      for (let index = 0; index < 50; index++) await recovered.query({ type: "GetTurn", turnId: waiting.id });
      expect(kind === "RAG" ? deps.rag.calls : deps.model.calls).toHaveLength(0);
      expect(await recovered.query({ type: "GetTurn", turnId: waiting.id })).toMatchObject({ ok: true, data: waiting });
    } finally {
      preparedGate.release();
    }
  });

  it("keeps a returned provider result unknown when its transaction rolls back once", async () => {
    const deps = createTestDependencies();
    const store = new LifecycleStore(deps.store);
    const harness = await createHarness({ ...deps, store });
    const conversationId = await createConversation(harness);
    store.rollback = (state) => state.events.some((event) => event.type === "EvidenceCaptured");
    await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    const waiting = await waitForTurn(harness, conversationId, "WAITING_USER");
    expect(waiting.roleRuns[0]).toMatchObject({
      status: "WAITING_USER", evidence: [], answer: null,
      attempts: [{ kind: "RAG", status: "OUTCOME_UNKNOWN" }],
    });
    expect(deps.rag.calls).toHaveLength(1);
    expect(deps.model.calls).toHaveLength(0);
    const recovered = await createHarness({ ...deps, store });
    expect(await recovered.query({ type: "GetTurn", turnId: waiting.id })).toMatchObject({ ok: true, data: waiting });
    expect(deps.rag.calls).toHaveLength(1);
    expect(deps.model.calls).toHaveLength(0);
  });

  it("rolls back a question, its receipt and its events before accepting the same command once", async () => {
    const deps = createTestDependencies();
    const store = new LifecycleStore(deps.store);
    const harness = await createHarness({ ...deps, store });
    const conversationId = await createConversation(harness);
    const before = await harness.query({ type: "GetConversation", conversationId });
    const command = { type: "SubmitQuestion" as const, commandId: "A", conversationId, text: "A" };
    store.rollback = (state) => state.commands.some((item) => item.receipt.commandId === command.commandId);
    await expect(harness.dispatch(command)).rejects.toThrow("Injected transaction rollback");
    expect(await harness.query({ type: "GetConversation", conversationId })).toEqual(before);
    expect(deps.rag.calls).toHaveLength(0);
    expect(deps.model.calls).toHaveLength(0);

    const [accepted, replay] = await Promise.all([harness.dispatch(command), harness.dispatch(command)]);
    expect(accepted).toMatchObject({ ok: true });
    expect(replay).toEqual(accepted);
    const completed = await waitForTurn(harness, conversationId, "COMPLETED");
    const after = await harness.query({ type: "GetConversation", conversationId });
    if (!after.ok || !accepted.ok) throw new Error("Expected an accepted question and its conversation projection");
    expect(after.data.questions).toHaveLength(1);
    expect(after.data.questions[0]?.id).toBe(accepted.questionId);
    expect(after.data.turnIds).toEqual([completed.id]);
    expect(deps.rag.calls).toHaveLength(1);
    expect(deps.model.calls).toHaveLength(1);

    const iterator = harness.events(before.lastEventSeq)[Symbol.asyncIterator]();
    const eventTypes: string[] = [];
    try {
      for (let seq = before.lastEventSeq + 1; seq <= after.lastEventSeq; seq++) {
        const event = await iterator.next();
        if (event.done) throw new Error("Expected the committed journal to reach the projection bookmark");
        eventTypes.push(event.value.type);
      }
      expect(eventTypes.filter((type) => type === "QuestionAccepted")).toHaveLength(1);
    } finally {
      await iterator.return?.();
    }
  });
});
