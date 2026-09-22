import { expect, test, vi } from "vitest";
import { createHarness, type DiscussionModelPort } from "./index";
import { createTestDependencies, testRole, testSettings } from "../../testing/src/index";
import { createConversation, waitForTurn, until } from "../test-support";

test("plans once, retrieves each selected person, then generates all answers in one call", async () => {
  const deps = createTestDependencies();
  const second = { ...testRole, id: "second", label: "Second", corpusId: "second-corpus" };
  deps.roles = [testRole, second];
  const order: string[] = [];
  const model: DiscussionModelPort = {
    plan: async ({ input }) => { order.push("plan"); return { ok: true, plan: { philosophicalQuestion: input.question.text, userClaims: [], targets: input.settings.participantIds.map((roleId) => ({ roleId, searchQuery: `query-${roleId}` })) } }; },
    discuss: async ({ input }) => { order.push("discuss"); expect(deps.rag.calls).toHaveLength(2); return { ok: true, answer: {
      answers: input.participants.map(({ participant, evidence }) => ({ roleId: participant.id, answer: { text: "有据回答", kind: "PARAPHRASE", evidenceIds: evidence.map((e) => e.id) } })),
      commentary: { text: "", claimIndexes: [] }, summary: { text: "两位人物均作出了有据回答。", roleIds: input.participants.map((p) => p.participant.id) },
    } }; },
  };
  const harness = await createHarness({ ...deps, discussionModel: model });
  const id = await createConversation(harness, "create", { ...testSettings, participantIds: [testRole.id, second.id] });
  await harness.dispatch({ type: "SubmitQuestion", commandId: "submit", conversationId: id, text: "自由是什么？" });
  const turn = await waitForTurn(harness, id, "COMPLETED");
  expect(order).toEqual(["plan", "discuss"]);
  expect(turn.roleRuns.map((role) => role.answer?.text)).toEqual(["有据回答", "有据回答"]);
  expect(turn.discussion?.attempts.map((attempt) => attempt.kind)).toEqual(["PLAN", "RAG", "RAG", "DISCUSSION"]);
  expect(deps.model.calls).toHaveLength(0);
});

function discussionModel(): DiscussionModelPort {
  return {
    plan: vi.fn<DiscussionModelPort["plan"]>(async ({ input }) => ({ ok: true as const, plan: {
      philosophicalQuestion: input.question.text, userClaims: [],
      targets: (input.settings.participantIds.length ? input.settings.participantIds : [input.catalog[0]!.id]).map((roleId) => ({ roleId, searchQuery: input.question.text })),
    } })),
    discuss: vi.fn<DiscussionModelPort["discuss"]>(async ({ input }) => ({ ok: true as const, answer: {
      answers: input.participants.map(({ participant, evidence }) => ({ roleId: participant.id, answer: { text: "有据回答", kind: "PARAPHRASE" as const, evidenceIds: evidence.map((e) => e.id) } })),
      commentary: { text: "", claimIndexes: [] }, summary: { text: "", roleIds: [] },
    } })),
  };
}

test("automatic selection uses the confirmed catalog and retrieves only the selected person", async () => {
  const deps = createTestDependencies();
  const model = discussionModel();
  const harness = await createHarness({ ...deps, discussionModel: model });
  const id = await createConversation(harness, "create", { ...testSettings, participantIds: [] });
  await harness.dispatch({ type: "SubmitQuestion", commandId: "s", conversationId: id, text: "自由是什么？" });
  const turn = await waitForTurn(harness, id, "COMPLETED");
  expect(turn.roleRuns.map((role) => role.context.participant.id)).toEqual([testRole.id]);
  expect(deps.rag.calls).toHaveLength(1);
});

test("rejects a planner changing an explicit person before any retrieval", async () => {
  const deps = createTestDependencies();
  const model = discussionModel();
  model.plan = async () => ({ ok: true, plan: { philosophicalQuestion: "自由", userClaims: [], targets: [{ roleId: "invented", searchQuery: "自由" }] } });
  const harness = await createHarness({ ...deps, discussionModel: model });
  const id = await createConversation(harness);
  await harness.dispatch({ type: "SubmitQuestion", commandId: "s", conversationId: id, text: "自由" });
  expect((await waitForTurn(harness, id, "FAILED")).discussion?.errorCode).toBe("INVALID_ROUTE");
  expect(deps.rag.calls).toHaveLength(0);
  expect(model.discuss).not.toHaveBeenCalled();
});

test("retrievals remain serial and all-empty evidence skips final generation", async () => {
  const deps = createTestDependencies();
  deps.roles = [testRole, { ...testRole, id: "second", corpusId: "second-corpus" }];
  deps.rag.holdNext(); deps.rag.holdNext();
  const model = discussionModel();
  const harness = await createHarness({ ...deps, discussionModel: model });
  const id = await createConversation(harness, "create", { ...testSettings, participantIds: [testRole.id, "second"] });
  await harness.dispatch({ type: "SubmitQuestion", commandId: "s", conversationId: id, text: "自由" });
  await until(() => deps.rag.calls.length === 1);
  await harness.query({ type: "GetConversation", conversationId: id });
  expect(deps.rag.calls).toHaveLength(1);
  expect(model.discuss).not.toHaveBeenCalled();
  deps.rag.calls[0]!.complete([]);
  await until(() => deps.rag.calls.length === 2);
  deps.rag.calls[1]!.complete([]);
  const turn = await waitForTurn(harness, id, "COMPLETED");
  expect(turn.roleRuns.every((role) => role.answer?.kind === "INSUFFICIENT_EVIDENCE")).toBe(true);
  expect(model.discuss).not.toHaveBeenCalled();
});

test("explicit recovery repeats only the unknown final request and reuses durable retrievals", async () => {
  const deps = createTestDependencies();
  const model = discussionModel();
  const succeed = model.discuss;
  let attempts = 0;
  model.discuss = vi.fn<DiscussionModelPort["discuss"]>((...args) => ++attempts === 1 ? Promise.resolve({ ok: false as const, code: "OUTCOME_UNKNOWN" as const }) : succeed(...args));
  const harness = await createHarness({ ...deps, discussionModel: model });
  const id = await createConversation(harness);
  await harness.dispatch({ type: "SubmitQuestion", commandId: "s", conversationId: id, text: "自由" });
  const waiting = await waitForTurn(harness, id, "WAITING_USER");
  expect(model.discuss).toHaveBeenCalledTimes(1);
  expect((await harness.dispatch({ type: "RegenerateDiscussion", commandId: "retry", turnId: waiting.id })).ok).toBe(true);
  const complete = await waitForTurn(harness, id, "COMPLETED");
  expect(deps.rag.calls).toHaveLength(1);
  expect(model.plan).toHaveBeenCalledTimes(1);
  expect(model.discuss).toHaveBeenCalledTimes(2);
  const final = complete.discussion!.attempts.filter((attempt) => attempt.kind === "DISCUSSION");
  expect(final.map((attempt) => attempt.status)).toEqual(["OUTCOME_UNKNOWN", "SUCCEEDED"]);
  expect(final[1]!.previousAttemptId).toBe(final[0]!.id);
  expect(final[1]!.input).toEqual(final[0]!.input);
});

test("stopping a pending paid plan fences its late result and records unknown delivery", async () => {
  const deps = createTestDependencies();
  let deliver: ((value: Awaited<ReturnType<DiscussionModelPort["plan"]>>) => void) | undefined;
  const harness = await createHarness({ ...deps, discussionModel: {
    plan: () => new Promise((resolve) => { deliver = resolve; }),
    discuss: async () => { throw new Error("Must not generate"); },
  } });
  const id = await createConversation(harness);
  await harness.dispatch({ type: "SubmitQuestion", commandId: "s", conversationId: id, text: "A" });
  await until(() => Boolean(deliver));
  const turn = await waitForTurn(harness, id, "RUNNING");
  expect((await harness.dispatch({ type: "StopTurn", commandId: "stop", turnId: turn.id })).ok).toBe(true);
  deliver!({ ok: true, plan: { philosophicalQuestion: "A", userClaims: [], targets: [{ roleId: testRole.id, searchQuery: "A" }] } });
  const stopped = await waitForTurn(harness, id, "STOPPED");
  expect(stopped.discussion).toMatchObject({ status: "STOPPED", attempts: [{ status: "OUTCOME_UNKNOWN" }] });
  expect(deps.rag.calls).toHaveLength(0);
});

test("explicit fiction can generate a labelled creative answer after empty primary retrieval", async () => {
  const deps = createTestDependencies();
  deps.rag.holdNext();
  const model = discussionModel();
  model.discuss = vi.fn(async () => ({ ok: true as const, answer: {
    answers: [{ roleId: testRole.id, answer: { text: "这是一段明确标注的创作拟构，不是人物原话。", kind: "FICTION" as const, evidenceIds: [] } }],
    commentary: { text: "", claimIndexes: [] }, summary: { text: "", roleIds: [] },
  } }));
  const harness = await createHarness({ ...deps, discussionModel: model });
  const id = await createConversation(harness, "create", { ...testSettings, knowledgeMode: "FICTION" });
  await harness.dispatch({ type: "SubmitQuestion", commandId: "s", conversationId: id, text: "请创作一段关于选择的寓言。" });
  await until(() => deps.rag.calls.length === 1);
  deps.rag.calls[0]!.complete([]);
  const turn = await waitForTurn(harness, id, (item) => item.status !== "RUNNING");
  expect(model.discuss).toHaveBeenCalledTimes(1);
  expect(turn).toMatchObject({ status: "COMPLETED", roleRuns: [{ answer: { kind: "FICTION", evidenceIds: [] } }] });
});

test("stopping preserves a draft below the checkpoint threshold and fences late draft delivery", async () => {
  const deps = createTestDependencies({ draftCheckpointChars: 1000 });
  const model = discussionModel();
  let draft: NonNullable<Parameters<DiscussionModelPort["discuss"]>[0]["onDraft"]> | undefined;
  let finish: ((value: Awaited<ReturnType<DiscussionModelPort["discuss"]>>) => void) | undefined;
  model.discuss = ({ onDraft }) => { draft = onDraft; return new Promise((resolve) => { finish = resolve; }); };
  const harness = await createHarness({ ...deps, discussionModel: model });
  const id = await createConversation(harness);
  await harness.dispatch({ type: "SubmitQuestion", commandId: "s", conversationId: id, text: "自由" });
  await until(() => Boolean(draft));
  await draft!({ roleId: testRole.id, text: "未完成的短草稿" });
  const running = await waitForTurn(harness, id, "RUNNING");
  await harness.dispatch({ type: "StopTurn", commandId: "stop", turnId: running.id });
  const stopped = await waitForTurn(harness, id, "STOPPED");
  expect(stopped.roleRuns[0]!.textSoFar).toBe("未完成的短草稿");
  expect(stopped.discussion!.attempts.at(-1)?.drafts).toEqual([{ roleId: testRole.id, text: "未完成的短草稿" }]);
  await expect(draft!({ roleId: testRole.id, text: "迟到的覆盖" })).rejects.toThrow();
  finish!({ ok: false, code: "OUTCOME_UNKNOWN" });
  expect((await waitForTurn(harness, id, "STOPPED")).roleRuns[0]!.textSoFar).toBe("未完成的短草稿");
});

test("a grouped discussion reserves a slot for each participant across conversations", async () => {
  const deps = createTestDependencies();
  deps.limits.maxRoleRuns = 2;
  deps.roles = [testRole, { ...testRole, id: "second", corpusId: "second-corpus" }];
  deps.rag.holdNext();
  const model = discussionModel();
  const harness = await createHarness({ ...deps, discussionModel: model });
  const first = await createConversation(harness, "first", { ...testSettings, participantIds: [testRole.id, "second"] });
  const second = await createConversation(harness, "second");
  await harness.dispatch({ type: "SubmitQuestion", commandId: "s1", conversationId: first, text: "自由" });
  await until(() => deps.rag.calls.length === 1);
  await harness.dispatch({ type: "SubmitQuestion", commandId: "s2", conversationId: second, text: "责任" });
  expect(model.plan).toHaveBeenCalledTimes(1);
  deps.rag.calls[0]!.complete();
  await waitForTurn(harness, first, "COMPLETED");
  await waitForTurn(harness, second, "COMPLETED");
  expect(model.plan).toHaveBeenCalledTimes(2);
});

test.each(["INSUFFICIENT_EVIDENCE", "INFERENCE", "FICTION"] as const)("settles %s in primary mode without presenting an unsupported summary", async (kind) => {
  const deps = createTestDependencies();
  const model = discussionModel();
  model.discuss = async ({ input }) => ({ ok: true, answer: {
    answers: [{ roleId: testRole.id, answer: { text: "不能在当前证据下确认的模型观点", kind, evidenceIds: input.participants[0]!.evidence.map((e) => e.id) } }],
    commentary: { text: "", claimIndexes: [] }, summary: { text: "根据这个人物的观点得出结论", roleIds: [testRole.id] },
  } });
  const harness = await createHarness({ ...deps, discussionModel: model });
  const id = await createConversation(harness);
  await harness.dispatch({ type: "SubmitQuestion", commandId: "s", conversationId: id, text: "自由" });
  const turn = await waitForTurn(harness, id, "COMPLETED");
  expect(turn.roleRuns[0]!.answer?.kind).toBe("INSUFFICIENT_EVIDENCE");
  expect(turn.roleRuns[0]!.answer?.text).not.toContain("模型观点");
  expect(turn.discussion!.summary).toEqual({ text: "", roleIds: [] });
  expect(turn.discussion!.attempts.at(-1)?.status).toBe("SUCCEEDED");
});

test("budgets the provider's rendered request while preserving full evidence audit metadata", async () => {
  const deps = createTestDependencies();
  deps.modelExecution.policies[0]!.windowTokens = 4096;
  const model = discussionModel();
  model.countInput = vi.fn(() => 1000);
  const harness = await createHarness({ ...deps, discussionModel: model });
  const id = await createConversation(harness);
  await harness.dispatch({ type: "SubmitQuestion", commandId: "s", conversationId: id, text: "自由" });
  const turn = await waitForTurn(harness, id, "COMPLETED");
  expect(model.countInput).toHaveBeenCalled();
  expect(turn.roleRuns[0]!.evidence[0]!.sourceRevision).toBe("source-v1");
  expect(turn.discussion!.attempts.at(-1)?.input).toMatchObject({ participants: [{ evidence: [{ sourceRevision: "source-v1" }] }] });
});

test("a discarded participant cannot leak its prohibited inference into commentary or the summary", async () => {
  const deps = createTestDependencies();
  deps.roles = [testRole, { ...testRole, id: "second", corpusId: "second-corpus" }];
  const model = discussionModel();
  model.plan = async ({ input }) => ({ ok: true, plan: { philosophicalQuestion: "自由", userClaims: ["我认为自由不需要责任"], targets: input.settings.participantIds.map((roleId) => ({ roleId, searchQuery: "自由" })) } });
  model.discuss = async ({ input }) => ({ ok: true, answer: {
    answers: input.participants.map(({ participant, evidence }, index) => ({ roleId: participant.id, answer: { text: "人物立场", kind: index === 0 ? "INFERENCE" : "PARAPHRASE", evidenceIds: evidence.map((e) => e.id) } })),
    commentary: { text: "依据第一人的推断，你的观点不成立", claimIndexes: [0] }, summary: { text: "由第一人的推断及第二人的立场可得", roleIds: ["second"] },
  } });
  const harness = await createHarness({ ...deps, discussionModel: model });
  const id = await createConversation(harness, "create", { ...testSettings, participantIds: [testRole.id, "second"] });
  await harness.dispatch({ type: "SubmitQuestion", commandId: "s", conversationId: id, text: "我认为自由不需要责任" });
  const turn = await waitForTurn(harness, id, "COMPLETED");
  expect(turn.roleRuns.map((role) => role.answer?.kind)).toEqual(["INSUFFICIENT_EVIDENCE", "PARAPHRASE"]);
  expect(turn.discussion!.commentary).toEqual({ text: "", claimIndexes: [] });
  expect(turn.discussion!.summary).toEqual({ text: "", roleIds: [] });
});
