import { describe, expect, it } from "vitest";
import type { Cancellation, GenerationRequest, ModelChunk, RetrievalRequest } from "@pchat/harness";
import { createTestDependencies, testEvidence, testRole, testSettings } from "./index";

const active: Cancellation = { cancelled: false, subscribe: () => () => {} };
const retrieval: RetrievalRequest = {
  attemptId: "rag-1", roleRunId: "role-1", connectionId: "rag-test",
  query: "What is freedom?", corpusId: "a-different-corpus", corpusRevision: "v2", retrievalConfigRevision: "v1",
};
const generation: GenerationRequest = {
  attemptId: "model-held", roleRunId: "role-held", evidence: [testEvidence],
  context: { question: { id: "q-held", text: "A held question" }, settings: testSettings, participant: testRole, history: [] },
};

describe("test dependencies through the injected ports", () => {
  it("automatically retrieves scoped evidence and generates a cited paraphrase without external services", async () => {
    const deps = createTestDependencies();
    const result = await deps.rag.retrieve(retrieval, active);
    if (!result.ok) throw new Error("Expected fake evidence");
    expect(result.evidence[0]).toMatchObject({ corpusId: "a-different-corpus", corpusRevision: "v2" });
    const request: GenerationRequest = {
      attemptId: "model-1", roleRunId: "role-1", evidence: result.evidence,
      context: { question: { id: "q-1", text: "What is freedom?" }, settings: testSettings, participant: testRole, history: [] },
    };
    const chunks: ModelChunk[] = [];
    for await (const chunk of deps.model.generate(request, active)) chunks.push(chunk);
    expect(chunks).toEqual([{ type: "complete", answer: {
      text: "A test paraphrase about: What is freedom?", kind: "PARAPHRASE", evidenceIds: [result.evidence[0]?.id],
    } }]);
  });

  it("holds one model call for controlled deltas and permits a late result after cancellation", async () => {
    const deps = createTestDependencies();
    const cancellation = { cancelled: false, subscribe: () => () => {} };
    deps.model.holdNext();
    const iterator = deps.model.generate(generation, cancellation)[Symbol.asyncIterator]();
    const call = deps.model.calls[0];
    if (!call) throw new Error("Expected the held model call");
    expect(call.request.context.question.text).toBe("A held question");
    const pending = iterator.next();
    call.delta("Draft text");
    expect(await pending).toEqual({ done: false, value: { type: "delta", text: "Draft text" } });
    cancellation.cancelled = true;
    expect(call.cancellation.cancelled).toBe(true);
    call.complete({ text: "Late text", kind: "PARAPHRASE", evidenceIds: [testEvidence.id] });
    expect(await iterator.next()).toMatchObject({ value: { type: "complete", answer: { text: "Late text" } } });
    expect(await iterator.next()).toMatchObject({ done: true });
    const automatic = deps.model.generate(generation, active)[Symbol.asyncIterator]();
    expect(await automatic.next()).toMatchObject({ value: { type: "complete" } });
  });

  it("holds retrieval until a caller supplies evidence even if cancellation was already requested", async () => {
    const deps = createTestDependencies();
    const cancellation = { cancelled: false, subscribe: () => () => {} };
    deps.rag.holdNext();
    const pending = deps.rag.retrieve(retrieval, cancellation);
    const call = deps.rag.calls[0];
    if (!call) throw new Error("Expected the held retrieval call");
    expect(call.request.query).toBe("What is freedom?");
    cancellation.cancelled = true;
    expect(call.cancellation.cancelled).toBe(true);
    call.complete([{ ...testEvidence, text: "Late evidence" }]);
    expect(await pending).toMatchObject({ ok: true, evidence: [{ text: "Late evidence" }] });
    expect(await deps.rag.retrieve(retrieval, active)).toMatchObject({ ok: true });
  });

  it.each(["unknown", "reject"] as const)("allows both providers to return a controlled %s outcome", async (outcome) => {
    const deps = createTestDependencies();
    deps.rag.holdNext();
    deps.model.holdNext();
    const retrievalResult = deps.rag.retrieve(retrieval, active);
    const modelResult = deps.model.generate(generation, active)[Symbol.asyncIterator]().next();
    const ragCall = deps.rag.calls[0];
    const modelCall = deps.model.calls[0];
    if (!ragCall || !modelCall) throw new Error("Expected both provider calls");
    ragCall[outcome]();
    modelCall[outcome]();
    const code = outcome === "unknown" ? "OUTCOME_UNKNOWN" : "REJECTED";
    expect(await retrievalResult).toEqual({ ok: false, code });
    expect(await modelResult).toEqual({ done: false, value: { type: "failure", code } });
  });

  it("can simulate adapter exceptions independently of declared provider rejections", async () => {
    const deps = createTestDependencies();
    deps.rag.holdNext();
    deps.model.holdNext();
    const retrievalResult = deps.rag.retrieve(retrieval, active);
    const modelResult = deps.model.generate(generation, active)[Symbol.asyncIterator]().next();
    const ragCall = deps.rag.calls[0];
    const modelCall = deps.model.calls[0];
    if (!ragCall || !modelCall) throw new Error("Expected both provider calls");
    const ragFailure = expect(retrievalResult).rejects.toThrow("connection lost");
    const modelFailure = expect(modelResult).rejects.toThrow("connection lost");
    ragCall.throw(new Error("connection lost"));
    modelCall.throw(new Error("connection lost"));
    await Promise.all([ragFailure, modelFailure]);
  });
});
