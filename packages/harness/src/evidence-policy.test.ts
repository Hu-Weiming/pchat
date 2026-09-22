import { describe, expect, it } from "vitest";
import type { ConversationSettings } from "@pchat/contracts";
import type { Evidence } from "./ports";
import { createHarness } from "./index";
import { createTestDependencies, testEvidence, testSettings } from "../../testing/src/index";
import { createConversation, until, waitForTurn } from "../test-support";

async function beginRetrieval(settings: ConversationSettings = testSettings) {
  const deps = createTestDependencies();
  deps.rag.holdNext();
  const harness = await createHarness(deps);
  const conversationId = await createConversation(harness, "create", settings);
  await harness.dispatch({ type: "SubmitQuestion", commandId: "submit", conversationId, text: "What is freedom?" });
  await until(() => deps.rag.calls.length === 1);
  const retrieval = deps.rag.calls[0];
  if (!retrieval) throw new Error("Expected a retrieval call");
  return { deps, harness, conversationId, retrieval };
}

async function beginGeneration(settings: ConversationSettings = testSettings, evidence: Evidence[] = [testEvidence]) {
  const run = await beginRetrieval(settings);
  run.deps.model.holdNext();
  run.retrieval.complete(evidence);
  await until(() => run.deps.model.calls.length === 1);
  const generation = run.deps.model.calls[0];
  if (!generation) throw new Error("Expected a model call");
  return { ...run, generation };
}

describe("evidence policy through PchatHarness", () => {
  it.each(["PRIMARY", "INFERENCE", "FICTION"] as const)("rejects research retrieval before generation in %s", async (knowledgeMode) => {
    const run = await beginRetrieval({ ...testSettings, knowledgeMode });
    run.retrieval.complete([{ ...testEvidence, kind: "RESEARCH" }]);
    const turn = await waitForTurn(run.harness, run.conversationId, (item) => item.status !== "RUNNING");
    expect(turn.roleRuns[0]).toMatchObject({ evidence: [], answer: null, errorCode: "INVALID_PROVIDER_RESULT" });
    expect(run.deps.model.calls).toHaveLength(0);
  });
  it("rejects another person's corpus before any evidence reaches the model", async () => {
    const run = await beginRetrieval();
    run.retrieval.complete([{ ...testEvidence, corpusId: "another-person" }]);
    const turn = await waitForTurn(run.harness, run.conversationId, (item) => item.status !== "RUNNING");
    expect(turn).toMatchObject({ status: "FAILED", roleRuns: [{ answer: null, evidence: [], errorCode: "INVALID_PROVIDER_RESULT" }] });
    expect(run.deps.model.calls).toHaveLength(0);
  });

  it("rejects a different corpus revision even when the corpus id matches", async () => {
    const run = await beginRetrieval();
    run.retrieval.complete([{ ...testEvidence, corpusRevision: "unexpected-revision" }]);
    const turn = await waitForTurn(run.harness, run.conversationId, (item) => item.status !== "RUNNING");
    expect(turn.status).toBe("FAILED");
    expect(run.deps.model.calls).toHaveLength(0);
  });

  it("rejects duplicate evidence ids instead of letting one citation identify different passages", async () => {
    const run = await beginRetrieval();
    run.retrieval.complete([testEvidence, { ...testEvidence, text: "Conflicting passage" }]);
    const turn = await waitForTurn(run.harness, run.conversationId, (item) => item.status !== "RUNNING");
    expect(turn.status).toBe("FAILED");
    expect(run.deps.model.calls).toHaveLength(0);
  });

  it.each([
    ["PRIMARY", "INFERENCE"], ["PRIMARY", "FICTION"], ["INFERENCE", "FICTION"],
  ] as const)("refuses provider escalation from %s to %s", async (knowledgeMode, kind) => {
    const run = await beginGeneration({ ...testSettings, knowledgeMode });
    run.generation.complete({ text: "An unsupported escalation", kind, evidenceIds: [testEvidence.id] });
    const turn = await waitForTurn(run.harness, run.conversationId, (item) => item.status !== "RUNNING");
    expect(turn).toMatchObject({
      status: "FAILED", context: { settings: { knowledgeMode } },
      roleRuns: [{ answer: null, errorCode: "INVALID_PROVIDER_RESULT" }],
    });
  });

  it.each([{ evidenceIds: [] }, { evidenceIds: ["never-retrieved"] }])("rejects unsupported references in a factual answer: $evidenceIds", async ({ evidenceIds }) => {
    const run = await beginGeneration();
    run.generation.complete({ text: "A factual assertion", kind: "PARAPHRASE", evidenceIds });
    const turn = await waitForTurn(run.harness, run.conversationId, (item) => item.status !== "RUNNING");
    expect(turn).toMatchObject({ status: "FAILED", roleRuns: [{ answer: null, errorCode: "INVALID_PROVIDER_RESULT" }] });
  });

  it.each(["locator", "workTitle", "edition", "translator"] as const)("refuses direct quotation without %s metadata", async (field) => {
    const run = await beginGeneration(testSettings, [{ ...testEvidence, translator: "Test translator", [field]: null }]);
    run.generation.complete({ text: testEvidence.text, kind: "QUOTE", evidenceIds: [testEvidence.id] });
    const turn = await waitForTurn(run.harness, run.conversationId, (item) => item.status !== "RUNNING");
    expect(turn).toMatchObject({ status: "FAILED", roleRuns: [{ answer: null, errorCode: "INVALID_PROVIDER_RESULT" }] });
  });

  it("permits an explicit paraphrase when quotation metadata is incomplete", async () => {
    const run = await beginGeneration(testSettings, [{ ...testEvidence, locator: null, workTitle: null, edition: null, translator: null }]);
    run.generation.complete({ text: "A clearly identified summary of the passage.", kind: "PARAPHRASE", evidenceIds: [testEvidence.id] });
    const turn = await waitForTurn(run.harness, run.conversationId, "COMPLETED");
    expect(turn.roleRuns[0]?.answer).toMatchObject({ kind: "PARAPHRASE", text: "A clearly identified summary of the passage." });
  });

  it("permits a primary quotation with complete verifiable metadata", async () => {
    const run = await beginGeneration(testSettings, [{ ...testEvidence, translator: "Test translator" }]);
    run.generation.complete({ text: testEvidence.text, kind: "QUOTE", evidenceIds: [testEvidence.id] });
    const turn = await waitForTurn(run.harness, run.conversationId, "COMPLETED");
    expect(turn.roleRuns[0]?.answer).toMatchObject({ kind: "QUOTE", text: testEvidence.text });
  });

  it.each(["PRIMARY", "INFERENCE"] as const)("finishes an empty retrieval safely in %s without a model attempt", async (knowledgeMode) => {
    const run = await beginRetrieval({ ...testSettings, knowledgeMode });
    run.retrieval.complete([]);
    const turn = await waitForTurn(run.harness, run.conversationId, "COMPLETED");
    expect(turn.roleRuns[0]?.answer).toEqual({
      text: "当前检索依据不足以在所选知识模式下回答。你可以补充更具体的问题或原典资料。",
      kind: "INSUFFICIENT_EVIDENCE", evidenceIds: [],
    });
    expect(turn.context.settings.knowledgeMode).toBe(knowledgeMode);
    expect(turn.roleRuns[0]?.attempts).toMatchObject([{ kind: "RAG", status: "SUCCEEDED" }]);
    expect(turn.roleRuns[0]?.attempts).toHaveLength(1);
    expect(run.deps.model.calls).toHaveLength(0);
  });

  it("allows the user's explicit fiction mode to generate from an empty retrieval", async () => {
    const run = await beginGeneration({ ...testSettings, knowledgeMode: "FICTION" }, []);
    run.generation.complete({ text: "An explicitly fictional scene.", kind: "FICTION", evidenceIds: [] });
    const turn = await waitForTurn(run.harness, run.conversationId, "COMPLETED");
    expect(turn.roleRuns[0]?.answer).toMatchObject({ kind: "FICTION" });
    expect(run.deps.model.calls).toHaveLength(1);
  });

  it("refuses an invented reference even in explicitly selected fiction mode", async () => {
    const run = await beginGeneration({ ...testSettings, knowledgeMode: "FICTION" });
    run.generation.complete({ text: "An explicitly fictional scene.", kind: "FICTION", evidenceIds: [testEvidence.id, "never-retrieved"] });
    const turn = await waitForTurn(run.harness, run.conversationId, (item) => item.status !== "RUNNING");
    expect(turn).toMatchObject({ status: "FAILED", roleRuns: [{ answer: null, errorCode: "INVALID_PROVIDER_RESULT" }] });
  });
});
