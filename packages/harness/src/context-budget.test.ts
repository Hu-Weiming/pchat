import { expect, it } from "vitest";
import { createHarness } from "./index";
import { createTestDependencies, testSettings } from "../../testing/src/index";
import { createConversation, until, waitForTurn } from "../test-support";

it("budgets recent complete turns using the injected counter and persists the exact model input", async () => {
  const deps = createTestDependencies({ modelExecution: {
    policies: [{ binding: testSettings.model, windowTokens: 250, outputReserveTokens: 50, policyVersion: "test-policy", counterVersion: "test-tokens", promptVersion: "test-prompt", countMode: "EXACT" }],
    counter: { version: "test-tokens", count: (input) => 100 + input.context.history.length * 60 + (input.checkpoint ? 40 : 0) },
  } });
  const harness = await createHarness(deps);
  const conversationId = await createConversation(harness);
  const turns = [];
  for (const text of ["A", "B", "C"]) {
    await harness.dispatch({ type: "SubmitQuestion", commandId: text, conversationId, text });
    turns.push(await waitForTurn(harness, conversationId, "COMPLETED", turns.length));
  }
  const request = deps.model.calls[2]!.request;
  expect(request.context.history.map((entry) => entry.turnId)).toEqual([turns[1]!.id]);
  expect(turns[2]!.roleRuns[0]!.context.history.map((entry) => entry.turnId)).toEqual([turns[0]!.id, turns[1]!.id]);
  expect(request.input).toMatchObject({
    context: request.context, evidence: request.evidence,
    audit: { windowTokens: 250, outputReserveTokens: 50, baseInputTokens: 100, retainedTurnIds: [turns[1]!.id], omittedTurnIds: [turns[0]!.id], countMode: "EXACT" },
  });
  expect(turns[2]!.roleRuns[0]!.attempts.at(-1)?.input).toEqual(request.input);
  expect(request.input!.audit.inputTokens + request.input!.audit.outputReserveTokens).toBeLessThanOrEqual(250);
  expect((await harness.query({ type: "GetTurn", turnId: turns[0]!.id }))).toMatchObject({ ok: true, data: turns[0] });
});

it("records only attributable extracts in an older checkpoint with its original event range", async () => {
  const deps = createTestDependencies({ modelExecution: {
    policies: [{ binding: testSettings.model, windowTokens: 250, outputReserveTokens: 50, policyVersion: "test-policy", counterVersion: "test-tokens", promptVersion: "test-prompt", countMode: "EXACT" }],
    counter: { version: "test-tokens", count: (input) => 100 + input.context.history.length * 60 + (input.checkpoint ? 40 : 0) },
  } });
  deps.model.holdNext();
  const harness = await createHarness(deps);
  const conversationId = await createConversation(harness);
  await harness.dispatch({ type: "SubmitQuestion", commandId: "A", conversationId, text: "I have not decided what freedom means. Can you explain it?" });
  await until(() => deps.model.calls.length === 1);
  deps.model.calls[0]!.complete({ text: "A limited opening paragraph.\n\nA longer qualification follows.", kind: "PARAPHRASE", evidenceIds: ["test-evidence"] });
  const first = await waitForTurn(harness, conversationId, "COMPLETED");
  await harness.dispatch({ type: "SubmitQuestion", commandId: "B", conversationId, text: "B" });
  await waitForTurn(harness, conversationId, "COMPLETED", 1);
  await harness.dispatch({ type: "SubmitQuestion", commandId: "C", conversationId, text: "C" });
  const third = await waitForTurn(harness, conversationId, "COMPLETED", 2);
  const input = deps.model.calls[2]!.request.input!;
  const events = await deps.store.read((state) => state.events.filter((event) => "turnId" in event && event.turnId === first.id));
  expect(input.checkpoint).toEqual({
    generatorVersion: "pchat-extractive-v1", sourceTurnIds: [first.id], fromEventSeq: events[0]!.seq, toEventSeq: events.at(-1)!.seq,
    userQuestions: [{ turnId: first.id, text: first.context.question.text, start: 0, end: first.context.question.text.length }],
    userClaims: [], clarifiedConcepts: [], unresolvedDifferences: [],
    rolePositions: [{ turnId: first.id, roleRunId: first.roleRuns[0]!.id, participantId: first.roleRuns[0]!.context.participant.id, kind: "EXCERPT", text: "A limited opening paragraph.", start: 0, end: 28 }],
  });
  expect(input.audit.checkpointStatus).toBe("CAPTURED");
  expect(third.roleRuns[0]!.attempts.at(-1)?.input).toEqual(input);
});

it("opens an unconfigured runtime to read history but refuses a new unconfigured model binding", async () => {
  const deps = createTestDependencies();
  deps.modelExecution.policies = [];
  const harness = await createHarness(deps);
  expect(await harness.query({ type: "ListConversations" })).toMatchObject({ ok: true, data: [] });
  expect(await harness.dispatch({ type: "CreateConversation", commandId: "create", title: "Missing connection", settings: testSettings })).toMatchObject({ ok: false, error: { code: "CONTEXT_UNAVAILABLE" } });
  const empty = await createHarness({ ...deps, roles: [] });
  expect(await empty.query({ type: "ListRoles" })).toMatchObject({ ok: true, data: [] });
  expect(deps.rag.calls).toHaveLength(0);
  expect(deps.model.calls).toHaveLength(0);
});
