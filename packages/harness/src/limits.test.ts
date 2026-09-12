import { describe, expect, it } from "vitest";
import { createHarness } from "./index";
import { createTestDependencies } from "../../testing/src/index";
import { createConversation, until, waitForTurn } from "../test-support";

describe("global execution limits", () => {
  it("does not start another external call while the only slot is occupied", async () => {
    const deps = createTestDependencies({ limits: { maxActiveTurns: 4, maxRoleRuns: 4, maxExternalCalls: 1, maxCostUnits: 100 } });
    deps.rag.holdNext();
    const harness = await createHarness(deps);
    const first = await createConversation(harness, "first");
    const second = await createConversation(harness, "second");
    await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId: first, text: "A" });
    await until(() => deps.rag.calls.length === 1);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "B", conversationId: second, text: "B" });
    for (let i = 0; i < 30; i++) await harness.query({ type: "GetConversation", conversationId: second });
    expect(deps.rag.calls).toHaveLength(1);
    expect(deps.model.calls).toHaveLength(0);
    deps.rag.calls[0]!.complete();
    await waitForTurn(harness, first, "COMPLETED");
    await waitForTurn(harness, second, "COMPLETED");
  });

  it("reserves cost atomically and retains unknown charges against the budget", async () => {
    const deps = createTestDependencies({ limits: { maxActiveTurns: 4, maxRoleRuns: 4, maxExternalCalls: 4, maxCostUnits: 1 } });
    deps.rag.holdNext();
    const harness = await createHarness(deps);
    const first = await createConversation(harness, "first");
    const second = await createConversation(harness, "second");
    await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId: first, text: "A" });
    await until(() => deps.rag.calls.length === 1);
    deps.rag.calls[0]!.unknown();
    await waitForTurn(harness, first, "WAITING_USER");
    await harness.dispatch({ type: "SubmitQuestion", commandId: "B", conversationId: second, text: "B" });
    const failed = await waitForTurn(harness, second, "FAILED");
    expect(failed.roleRuns[0]).toMatchObject({ attempts: [], errorCode: "BUDGET_EXCEEDED" });
    expect(deps.rag.calls).toHaveLength(1);
    expect(deps.model.calls).toHaveLength(0);
  });

  it("does not let explicit regeneration bypass the active-turn limit", async () => {
    const deps = createTestDependencies({ limits: { maxActiveTurns: 1, maxRoleRuns: 1, maxExternalCalls: 2, maxCostUnits: 100 } });
    deps.model.holdNext();
    const harness = await createHarness(deps);
    const first = await createConversation(harness, "first");
    const second = await createConversation(harness, "second");
    await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId: first, text: "A" });
    await until(() => deps.model.calls.length === 1);
    deps.model.calls[0]!.unknown();
    const waiting = await waitForTurn(harness, first, "WAITING_USER");
    deps.model.holdNext();
    await harness.dispatch({ type: "SubmitQuestion", commandId: "B", conversationId: second, text: "B" });
    await until(() => deps.model.calls.length === 2);
    expect(await harness.dispatch({ type: "RegenerateRole", commandId: "too-early", roleRunId: waiting.roleRuns[0]!.id })).toMatchObject({ ok: false, error: { code: "CAPACITY_EXCEEDED" } });
    deps.model.calls[1]!.complete();
    await waitForTurn(harness, second, "COMPLETED");
    await harness.dispatch({ type: "RegenerateRole", commandId: "regenerate", roleRunId: waiting.roleRuns[0]!.id });
    await waitForTurn(harness, first, "COMPLETED");
  });
});
