import { describe, expect, it } from "vitest";
import { createHarness } from "./index";
import { createTestDependencies, testRole, testSettings } from "../../testing/src/index";
import { createConversation, until, waitForTurn } from "../test-support";

describe("conversation queue", () => {
  it("executes A then B then C without putting pending questions in A's context", async () => {
    const deps = createTestDependencies();
    deps.model.holdNext();
    const harness = await createHarness(deps);
    const conversationId = await createConversation(harness);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    await until(() => deps.model.calls.length === 1);
    await Promise.all(["B", "C"].map((text) => harness.dispatch({ type: "SubmitQuestion", commandId: text, conversationId, text })));
    expect(deps.model.calls[0]?.request.context).toMatchObject({ question: { text: "A" }, history: [] });
    expect(deps.model.calls).toHaveLength(1);
    deps.model.calls[0]!.complete();
    const third = await waitForTurn(harness, conversationId, "COMPLETED", 2);
    expect(deps.model.calls.map((call) => call.request.context.question.text)).toEqual(["A", "B", "C"]);
    expect(third.context.history.map((entry) => entry.question)).toEqual(["A", "B"]);
    expect((await harness.query({ type: "GetConversation", conversationId }))).toMatchObject({ ok: true, data: { questions: [{ text: "A", status: "COMPLETED" }, { text: "B", status: "COMPLETED" }, { text: "C", status: "COMPLETED" }], activeTurnId: null } });
  });

  it("deduplicates concurrent command retries including the original receipt", async () => {
    const deps = createTestDependencies();
    const harness = await createHarness(deps);
    const conversationId = await createConversation(harness);
    const command = { type: "SubmitQuestion" as const, commandId: "same", conversationId, text: "A" };
    const receipts = await Promise.all(Array.from({ length: 20 }, () => harness.dispatch(command)));
    expect(receipts.every((receipt) => JSON.stringify(receipt) === JSON.stringify(receipts[0]))).toBe(true);
    const turn = await waitForTurn(harness, conversationId, "COMPLETED");
    expect(await harness.dispatch(command)).toEqual(receipts[0]);
    expect(turn.roleRuns[0]?.attempts).toHaveLength(2);
    expect(deps.model.calls).toHaveLength(1);
    expect(deps.rag.calls).toHaveLength(1);
    expect(await harness.dispatch({ ...command, text: "Different" })).toMatchObject({ ok: false, error: { code: "COMMAND_CONFLICT" } });
    expect(await harness.query({ type: "GetConversation", conversationId })).toMatchObject({ ok: true, data: { turnIds: [turn.id], questions: [{ text: "A" }] } });
  });

  it("stops the entire turn, retains its draft, and resumes only queued questions", async () => {
    const deps = createTestDependencies({ draftCheckpointChars: 1 });
    deps.model.holdNext();
    const harness = await createHarness(deps);
    const conversationId = await createConversation(harness);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    await until(() => deps.model.calls.length === 1);
    deps.model.calls[0]!.delta("Partial answer");
    const active = await waitForTurn(harness, conversationId, (turn) => turn.roleRuns[0]?.textSoFar === "Partial answer");
    await harness.dispatch({ type: "SubmitQuestion", commandId: "B", conversationId, text: "B" });
    expect(await harness.dispatch({ type: "StopTurn", commandId: "stop-A", turnId: active.id })).toMatchObject({ ok: true });
    const stopped = await waitForTurn(harness, conversationId, "STOPPED");
    expect(stopped.roleRuns.every((role) => role.status === "STOPPED")).toBe(true);
    expect(stopped.roleRuns[0]).toMatchObject({ textSoFar: "Partial answer", answer: null });
    expect(stopped.roleRuns[0]?.attempts.at(-1)?.status).toBe("OUTCOME_UNKNOWN");
    expect(deps.model.calls[0]?.cancellation.cancelled).toBe(true);
    expect(await harness.query({ type: "GetConversation", conversationId })).toMatchObject({ ok: true, data: { queueStatus: "PAUSED", questions: [{ status: "STOPPED" }, { status: "QUEUED" }] } });
    deps.model.calls[0]!.complete();
    expect(await harness.dispatch({ type: "ResumeQueue", commandId: "resume", conversationId })).toMatchObject({ ok: true });
    await waitForTurn(harness, conversationId, "COMPLETED", 1);
    expect((await harness.query({ type: "GetTurn", turnId: stopped.id }))).toMatchObject({ ok: true, data: stopped });
    expect(deps.model.calls.map((call) => call.request.context.question.text)).toEqual(["A", "B"]);
  });

  it("withdraws only queued questions and rejects terminal-state transitions", async () => {
    const deps = createTestDependencies();
    deps.model.holdNext();
    const harness = await createHarness(deps);
    const conversationId = await createConversation(harness);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    await until(() => deps.model.calls.length === 1);
    const active = await waitForTurn(harness, conversationId, "RUNNING");
    const pending = await harness.dispatch({ type: "SubmitQuestion", commandId: "B", conversationId, text: "B" });
    if (!pending.ok || !pending.questionId) throw new Error("Missing queued question");
    expect(await harness.dispatch({ type: "WithdrawQuestion", commandId: "withdraw", questionId: pending.questionId })).toMatchObject({ ok: true });
    expect(await harness.dispatch({ type: "WithdrawQuestion", commandId: "withdraw-active", questionId: active.questionId })).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION" } });
    deps.model.calls[0]!.complete();
    const completed = await waitForTurn(harness, conversationId, "COMPLETED");
    for (const command of [
      { type: "StopTurn" as const, commandId: "stop-finished", turnId: completed.id },
      { type: "RegenerateRole" as const, commandId: "regenerate-finished", roleRunId: completed.roleRuns[0]!.id },
      { type: "WithdrawQuestion" as const, commandId: "withdraw-again", questionId: pending.questionId },
      { type: "ResumeQueue" as const, commandId: "resume-running", conversationId },
    ]) expect(await harness.dispatch(command)).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION" } });
    expect(await harness.query({ type: "GetConversation", conversationId })).toMatchObject({ ok: true, data: { turnIds: [completed.id], questions: [{ status: "COMPLETED" }, { status: "WITHDRAWN" }] } });
    expect(deps.model.calls).toHaveLength(1);
  });

  it("freezes submitted choices while participant changes affect only later questions", async () => {
    const laterRole = { ...testRole, id: "later-role", corpusId: "later-corpus", corpusRevision: "later-v1" };
    const deps = createTestDependencies({ roles: [testRole, laterRole] });
    deps.model.holdNext();
    const harness = await createHarness(deps);
    const settings = { ...testSettings, model: { ...testSettings.model } };
    const conversationId = await createConversation(harness, "create", settings);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    await until(() => deps.model.calls.length === 1);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "B", conversationId, text: "B" });
    expect(await harness.dispatch({ type: "ChangeParticipants", commandId: "change", conversationId, participantIds: [laterRole.id] })).toMatchObject({ ok: true });
    await harness.dispatch({ type: "SubmitQuestion", commandId: "C", conversationId, text: "C" });
    settings.model.modelId = "mutated-model";
    laterRole.corpusRevision = "mutated-revision";
    deps.model.calls[0]!.complete();
    await waitForTurn(harness, conversationId, "COMPLETED", 2);
    expect(deps.model.calls.map((call) => call.request.context.participant.id)).toEqual([testRole.id, testRole.id, "later-role"]);
    expect(deps.rag.calls.map((call) => [call.request.corpusId, call.request.corpusRevision])).toEqual([[testRole.corpusId, testRole.corpusRevision], [testRole.corpusId, testRole.corpusRevision], ["later-corpus", "later-v1"]]);
    expect(deps.model.calls.every((call) => call.request.context.settings.model.modelId === testSettings.model.modelId)).toBe(true);
  });
});
