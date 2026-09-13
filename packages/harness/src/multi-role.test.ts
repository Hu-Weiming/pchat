import { describe, expect, it } from "vitest";
import { createHarness } from "./index";
import { createTestDependencies, testEvidence, testRole, testSettings } from "../../testing/src/index";
import { createConversation, until, waitForTurn } from "../test-support";

const roles = [testRole, { ...testRole, id: "second-role", label: "Second stage", corpusId: "second-corpus" }, { ...testRole, id: "third-role", label: "Third stage", corpusId: "third-corpus" }];
const settings = { ...testSettings, participantIds: roles.map((role) => role.id) };

describe("one question with multiple independent thought-stage roles", () => {
  it.each([1, 2])("completes two selected roles in one turn with %i external slots and compares only their existing answers", async (maxExternalCalls) => {
    const second = { ...testRole, id: "second-role", label: "Second stage", corpusId: "second-corpus" };
    const deps = createTestDependencies({ roles: [testRole, second], limits: { maxActiveTurns: 3, maxRoleRuns: 3, maxExternalCalls, maxCostUnits: 100 } });
    const harness = await createHarness(deps);
    const created = await harness.dispatch({ type: "CreateConversation", commandId: "create", title: "Two positions", settings: { ...testSettings, participantIds: [testRole.id, second.id] } });
    expect(created).toMatchObject({ ok: true });
    if (!created.ok || !created.conversationId) throw new Error("Expected the selected participants to create a conversation");
    const submitted = await harness.dispatch({ type: "SubmitQuestion", commandId: "question", conversationId: created.conversationId, text: "What is freedom?" });
    expect(submitted).toMatchObject({ ok: true });
    const turn = await waitForTurn(harness, created.conversationId, "COMPLETED");
    expect(turn.roleRuns).toHaveLength(2);
    expect(turn).toMatchObject({
      roleRuns: [
        { status: "COMPLETED", context: { participant: { id: testRole.id, corpusId: testRole.corpusId } } },
        { status: "COMPLETED", context: { participant: { id: second.id, corpusId: second.corpusId } } },
      ],
      comparison: { columns: turn.roleRuns.map((role, index) => ({ roleRunId: role.id, participantId: [testRole.id, second.id][index], answer: role.answer })), excludedRoleRunIds: [] },
    });
    expect(deps.rag.calls.map((call) => call.request.corpusId)).toEqual([testRole.corpusId, second.corpusId]);
    expect(deps.model.calls).toHaveLength(2);
    expect(await harness.query({ type: "GetConversation", conversationId: created.conversationId })).toMatchObject({ ok: true, data: { turnIds: [turn.id], questions: [{ status: "COMPLETED" }] } });
  });

  it("uses one role slot for three selected roles without giving pending roles attempts", async () => {
    const deps = createTestDependencies({ roles, limits: { maxActiveTurns: 3, maxRoleRuns: 1, maxExternalCalls: 3, maxCostUnits: 100 } });
    for (const _ of roles) deps.model.holdNext();
    const harness = await createHarness(deps);
    const conversationId = await createConversation(harness, "create", settings);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    for (let index = 0; index < roles.length; index++) {
      await until(() => deps.model.calls.length === index + 1);
      const active = await waitForTurn(harness, conversationId, (turn) => turn.roleRuns[index]?.status === "GENERATING");
      expect(active.roleRuns.slice(index + 1).map((role) => [role.status, role.attempts])).toEqual(roles.slice(index + 1).map(() => ["PENDING", []]));
      expect(deps.rag.calls).toHaveLength(index + 1);
      deps.model.calls[index]!.complete();
    }
    const complete = await waitForTurn(harness, conversationId, "COMPLETED");
    expect(complete.roleRuns.map((role) => role.status)).toEqual(["COMPLETED", "COMPLETED", "COMPLETED"]);
    expect(complete.comparison?.columns.map((column) => column.participantId)).toEqual(settings.participantIds);
    expect(deps.model.calls.map((call) => call.request.context.participant.id)).toEqual(settings.participantIds);
  });

  it("preserves a completed answer and stops all other streams including buffered drafts", async () => {
    const deps = createTestDependencies({ roles, draftCheckpointChars: 1_000 });
    for (const _ of roles) deps.model.holdNext();
    const harness = await createHarness(deps);
    const conversationId = await createConversation(harness, "create", settings);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    await until(() => deps.model.calls.length === 3);
    deps.model.calls[0]!.complete();
    deps.model.calls[1]!.delta("Second partial");
    deps.model.calls[2]!.delta("Third partial");
    const active = await waitForTurn(harness, conversationId, (turn) => turn.roleRuns[0]?.status === "COMPLETED");
    await harness.dispatch({ type: "SubmitQuestion", commandId: "B", conversationId, text: "B" });
    await harness.dispatch({ type: "StopTurn", commandId: "stop", turnId: active.id });
    const stopped = await waitForTurn(harness, conversationId, "STOPPED");
    expect(stopped.roleRuns[0]).toEqual(active.roleRuns[0]);
    expect(stopped.roleRuns.slice(1).map((role) => [role.status, role.textSoFar, role.attempts.at(-1)?.status])).toEqual([["STOPPED", "Second partial", "OUTCOME_UNKNOWN"], ["STOPPED", "Third partial", "OUTCOME_UNKNOWN"]]);
    expect(deps.model.calls.slice(1).every((call) => call.cancellation.cancelled)).toBe(true);
    expect(stopped.comparison).toBeNull();
    deps.model.calls[1]!.complete();
    deps.model.calls[2]!.complete();
    for (let index = 0; index < 20; index++) await harness.query({ type: "GetConversation", conversationId });
    expect(await harness.query({ type: "GetTurn", turnId: stopped.id })).toMatchObject({ ok: true, data: stopped });
    expect(deps.model.calls).toHaveLength(3);
    expect(await harness.query({ type: "GetConversation", conversationId })).toMatchObject({ ok: true, data: { queueStatus: "PAUSED", questions: [{ status: "STOPPED" }, { status: "QUEUED" }] } });
  });

  it("rejects one role's foreign corpus without losing two valid companions or inventing a comparison", async () => {
    const deps = createTestDependencies({ roles });
    for (const _ of roles) deps.rag.holdNext();
    const harness = await createHarness(deps);
    const conversationId = await createConversation(harness, "create", settings);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    await until(() => deps.rag.calls.length === 3);
    deps.rag.calls[0]!.complete();
    deps.rag.calls[1]!.complete([{ ...testEvidence, corpusId: roles[0]!.corpusId }]);
    deps.rag.calls[2]!.complete();
    const failed = await waitForTurn(harness, conversationId, "FAILED");
    expect(failed.roleRuns.map((role) => role.status)).toEqual(["COMPLETED", "FAILED", "COMPLETED"]);
    expect(failed.roleRuns[1]?.errorCode).toBe("INVALID_PROVIDER_RESULT");
    expect(deps.model.calls.map((call) => call.request.context.participant.id)).toEqual([roles[0]!.id, roles[2]!.id]);
    expect(failed.comparison).toEqual({ columns: [failed.roleRuns[0]!, failed.roleRuns[2]!].map((role) => ({ roleRunId: role.id, participantId: role.context.participant.id, participantLabel: role.context.participant.label, answer: role.answer })), excludedRoleRunIds: [failed.roleRuns[1]!.id] });
    expect(await harness.query({ type: "GetConversation", conversationId })).toMatchObject({ ok: true, data: { queueStatus: "PAUSED", activeTurnId: null } });
  });

  it("excludes local insufficient-evidence answers from comparison", async () => {
    const deps = createTestDependencies({ roles });
    for (const _ of roles) deps.rag.holdNext();
    const harness = await createHarness(deps);
    const conversationId = await createConversation(harness, "create", settings);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    await until(() => deps.rag.calls.length === 3);
    deps.rag.calls[0]!.complete([]);
    deps.rag.calls[1]!.complete();
    deps.rag.calls[2]!.complete();
    const complete = await waitForTurn(harness, conversationId, "COMPLETED");
    expect(complete.roleRuns[0]?.answer?.kind).toBe("INSUFFICIENT_EVIDENCE");
    expect(complete.comparison?.columns.map((column) => column.roleRunId)).toEqual(complete.roleRuns.slice(1).map((role) => role.id));
    expect(complete.comparison?.excludedRoleRunIds).toEqual([complete.roleRuns[0]!.id]);
    expect(deps.model.calls).toHaveLength(2);
  });

  it("holds an external slot through cancellation drain and never starts waiting requests", async () => {
    const deps = createTestDependencies({ roles, limits: { maxActiveTurns: 3, maxRoleRuns: 3, maxExternalCalls: 1, maxCostUnits: 100 } });
    deps.rag.holdNext();
    const harness = await createHarness(deps);
    const conversationId = await createConversation(harness, "create", settings);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    const active = await waitForTurn(harness, conversationId, (turn) => turn.roleRuns.every((role) => role.status === "RETRIEVING"));
    expect(deps.rag.calls).toHaveLength(1);
    expect(active.roleRuns.slice(1).map((role) => role.attempts)).toEqual([[], []]);
    await harness.dispatch({ type: "StopTurn", commandId: "stop", turnId: active.id });
    const nextConversation = await createConversation(harness, "other", { ...settings, participantIds: [roles[2]!.id] });
    await harness.dispatch({ type: "SubmitQuestion", commandId: "B", conversationId: nextConversation, text: "B" });
    await waitForTurn(harness, nextConversation, "RUNNING");
    expect(deps.rag.calls).toHaveLength(1);
    expect((await waitForTurn(harness, conversationId, "STOPPED")).roleRuns.slice(1).map((role) => role.attempts)).toEqual([[], []]);
    deps.rag.calls[0]!.complete();
    await waitForTurn(harness, nextConversation, "COMPLETED");
    expect(deps.rag.calls.map((call) => [call.request.query, call.request.corpusId])).toEqual([["A", roles[0]!.corpusId], ["B", roles[2]!.corpusId]]);
    expect(deps.model.calls).toHaveLength(1);
  });

  it("regenerates only the unknown role while a companion is still running", async () => {
    const deps = createTestDependencies({ roles });
    for (const _ of roles) deps.model.holdNext();
    const harness = await createHarness(deps);
    const conversationId = await createConversation(harness, "create", settings);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    await until(() => deps.model.calls.length === 3);
    deps.model.calls[0]!.complete();
    deps.model.calls[1]!.delta("Uncertain draft");
    deps.model.calls[1]!.unknown();
    const active = await waitForTurn(harness, conversationId, (turn) => turn.roleRuns[0]?.status === "COMPLETED" && turn.roleRuns[1]?.status === "WAITING_USER");
    expect(active.status).toBe("RUNNING");
    expect(active.roleRuns[2]?.status).toBe("GENERATING");
    expect(await harness.dispatch({ type: "ResumeQueue", commandId: "early", conversationId })).toMatchObject({ ok: false, error: { code: "QUEUE_BLOCKED" } });
    const regenerate = { type: "RegenerateRole" as const, commandId: "regenerate", roleRunId: active.roleRuns[1]!.id };
    const [first, replay] = await Promise.all([harness.dispatch(regenerate), harness.dispatch(regenerate)]);
    expect(first).toMatchObject({ ok: true });
    expect(first).toEqual(replay);
    const regenerated = await waitForTurn(harness, conversationId, (turn) => turn.roleRuns[1]?.status === "COMPLETED");
    expect(regenerated.roleRuns[0]).toEqual(active.roleRuns[0]);
    expect(regenerated.roleRuns[2]).toEqual(active.roleRuns[2]);
    expect(regenerated.roleRuns[1]?.attempts.map((attempt) => attempt.status)).toEqual(["SUCCEEDED", "OUTCOME_UNKNOWN", "SUCCEEDED"]);
    expect(regenerated.roleRuns[1]?.attempts[2]?.previousAttemptId).toBe(active.roleRuns[1]?.attempts[1]?.id);
    expect(regenerated.roleRuns[1]?.attempts[1]?.draft).toBe("Uncertain draft");
    expect(deps.rag.calls).toHaveLength(3);
    expect(deps.model.calls.map((call) => call.request.roleRunId)).toEqual([...active.roleRuns.map((role) => role.id), active.roleRuns[1]!.id]);
    deps.model.calls[2]!.complete();
    const complete = await waitForTurn(harness, conversationId, "COMPLETED");
    expect(complete.comparison?.columns).toHaveLength(3);
    expect(await harness.query({ type: "GetConversation", conversationId })).toMatchObject({ ok: true, data: { queueStatus: "PAUSED" } });
  });

  it("recovers completed, in-flight and pending roles without any automatic retry", async () => {
    const deps = createTestDependencies({ roles, limits: { maxActiveTurns: 3, maxRoleRuns: 1, maxExternalCalls: 1, maxCostUnits: 100 } });
    deps.model.holdNext();
    deps.model.holdNext();
    const old = await createHarness(deps);
    const conversationId = await createConversation(old, "create", settings);
    await old.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    await until(() => deps.model.calls.length === 1);
    deps.model.calls[0]!.complete();
    await until(() => deps.model.calls.length === 2);
    deps.model.calls[1]!.delta("Saved before restart");
    const active = await waitForTurn(old, conversationId, (turn) => turn.roleRuns[1]?.textSoFar === "Saved before restart");
    const recovered = await createHarness(deps);
    const waiting = await waitForTurn(recovered, conversationId, "WAITING_USER");
    expect(waiting.roleRuns[0]).toEqual(active.roleRuns[0]);
    expect(waiting.roleRuns.slice(1).map((role) => role.status)).toEqual(["WAITING_USER", "WAITING_USER"]);
    expect(waiting.roleRuns[2]?.attempts).toEqual([]);
    expect(deps.model.calls).toHaveLength(2);
    expect(deps.rag.calls).toHaveLength(2);
    await recovered.dispatch({ type: "RegenerateRole", commandId: "retry-second", roleRunId: waiting.roleRuns[1]!.id });
    const partial = await waitForTurn(recovered, conversationId, "WAITING_USER");
    expect(partial.roleRuns.map((role) => role.status)).toEqual(["COMPLETED", "COMPLETED", "WAITING_USER"]);
    expect(partial.comparison?.columns).toHaveLength(2);
    await recovered.dispatch({ type: "RegenerateRole", commandId: "start-third", roleRunId: waiting.roleRuns[2]!.id });
    const complete = await waitForTurn(recovered, conversationId, "COMPLETED");
    expect(complete.roleRuns[0]).toEqual(active.roleRuns[0]);
    expect(complete.roleRuns[1]?.attempts[2]?.previousAttemptId).toBe(waiting.roleRuns[1]?.attempts[1]?.id);
    expect(complete.roleRuns[2]?.attempts.map((attempt) => attempt.kind)).toEqual(["RAG", "MODEL"]);
    deps.model.calls[1]!.complete();
    for (let index = 0; index < 10; index++) await recovered.query({ type: "GetTurn", turnId: complete.id });
    expect(await recovered.query({ type: "GetTurn", turnId: complete.id })).toMatchObject({ ok: true, data: complete });
  });

  it("keeps FIFO questions and their selected roles frozen before a later participant change", async () => {
    const deps = createTestDependencies({ roles });
    deps.model.holdNext();
    deps.model.holdNext();
    const harness = await createHarness(deps);
    const initialSettings = { ...settings, participantIds: roles.slice(0, 2).map((role) => role.id) };
    const conversationId = await createConversation(harness, "create", initialSettings);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    await until(() => deps.model.calls.length === 2);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "B", conversationId, text: "B" });
    await harness.dispatch({ type: "ChangeParticipants", commandId: "change", conversationId, participantIds: [roles[2]!.id] });
    await harness.dispatch({ type: "SubmitQuestion", commandId: "C", conversationId, text: "C" });
    const active = await waitForTurn(harness, conversationId, "RUNNING");
    expect(active.context.settings).toEqual(initialSettings);
    expect(active.context.history).toEqual([]);
    expect(deps.model.calls.map((call) => call.request.context)).toEqual(active.roleRuns.map((role) => role.context));
    deps.model.calls[0]!.complete();
    deps.model.calls[1]!.complete();
    const first = await waitForTurn(harness, conversationId, "COMPLETED");
    const second = await waitForTurn(harness, conversationId, "COMPLETED", 1);
    const third = await waitForTurn(harness, conversationId, "COMPLETED", 2);
    expect(second.context.settings).toEqual(initialSettings);
    expect(third.context.settings.participantIds).toEqual([roles[2]!.id]);
    expect(third.comparison).toBeNull();
    expect(deps.model.calls.map((call) => [call.request.context.question.text, call.request.context.participant.id])).toEqual([["A", roles[0]!.id], ["A", roles[1]!.id], ["B", roles[0]!.id], ["B", roles[1]!.id], ["C", roles[2]!.id]]);
    expect(second.context.history).toEqual([{ turnId: first.id, question: "A", answer: first.roleRuns.map((role) => `${role.context.participant.label}:\n${role.answer!.text}`).join("\n\n") }]);
    expect(third.context.history.map((item) => item.turnId)).toEqual([first.id, second.id]);
    expect(second.roleRuns.every((role) => role.context.history.length === 1 && role.context.history[0]?.turnId === first.id)).toBe(true);
    expect(deps.rag.calls.map((call) => [call.request.query, call.request.corpusId])).toEqual([["A", roles[0]!.corpusId], ["A", roles[1]!.corpusId], ["B", roles[0]!.corpusId], ["B", roles[1]!.corpusId], ["C", roles[2]!.corpusId]]);
  });

  it("reserves one shared budget atomically across roles and preserves funded answers", async () => {
    const deps = createTestDependencies({ roles, limits: { maxActiveTurns: 3, maxRoleRuns: 3, maxExternalCalls: 3, maxCostUnits: 5 } });
    const harness = await createHarness(deps);
    const conversationId = await createConversation(harness, "create", settings);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    const failed = await waitForTurn(harness, conversationId, "FAILED");
    expect(failed.roleRuns.filter((role) => role.status === "COMPLETED")).toHaveLength(2);
    expect(failed.roleRuns.filter((role) => role.status === "FAILED").map((role) => role.errorCode)).toEqual(["BUDGET_EXCEEDED"]);
    expect(failed.roleRuns.flatMap((role) => role.attempts).reduce((sum, attempt) => sum + attempt.reservedCostUnits, 0)).toBe(5);
    expect(deps.rag.calls).toHaveLength(3);
    expect(deps.model.calls).toHaveLength(2);
    expect(failed.comparison?.columns).toHaveLength(2);
  });

  it("replays each role's completion and one turn completion after a projection bookmark", async () => {
    const deps = createTestDependencies({ roles });
    for (const _ of roles) deps.model.holdNext();
    const harness = await createHarness(deps);
    const conversationId = await createConversation(harness, "create", settings);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "A" });
    await until(() => deps.model.calls.length === 3);
    const active = await waitForTurn(harness, conversationId, "RUNNING");
    const bookmark = (await harness.query({ type: "GetTurn", turnId: active.id })).lastEventSeq;
    for (const call of deps.model.calls) call.complete();
    await waitForTurn(harness, conversationId, "COMPLETED");
    const snapshot = await harness.query({ type: "GetTurn", turnId: active.id });
    const iterator = harness.events(bookmark)[Symbol.asyncIterator]();
    const replay = [];
    for (let seq = bookmark + 1; seq <= snapshot.lastEventSeq; seq++) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      expect(next.value.seq).toBe(seq);
      replay.push(next.value);
    }
    await iterator.return?.();
    expect(replay.filter((event) => event.type === "RoleCompleted").map((event) => event.roleRunId).sort()).toEqual(active.roleRuns.map((role) => role.id).sort());
    expect(replay.filter((event) => event.type === "TurnCompleted")).toHaveLength(1);
    expect(await harness.query({ type: "GetTurn", turnId: active.id })).toEqual(snapshot);
  });
});
