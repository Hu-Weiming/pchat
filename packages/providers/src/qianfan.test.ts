import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { Cancellation, RetrievalRequest } from "@pchat/harness";
import { QianfanRAG } from "./index";
import type { QianfanConfiguration, SecureNetworkRequest, SecureNetworkResponse } from "./index";

const request: RetrievalRequest = {
  attemptId: "rag-attempt", roleRunId: "role-run", connectionId: "qianfan-connection", query: "What is freedom?",
  corpusId: "own-corpus", corpusRevision: "corpus-v1", retrievalConfigRevision: "retrieval-v1",
};
const binding = { connectionId: request.connectionId, corpusId: request.corpusId, corpusRevision: request.corpusRevision, retrievalConfigRevision: request.retrievalConfigRevision };
const hash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const config = {
  binding, knowledgebaseId: "own-kb", topK: 6, scoreThreshold: 0.4,
  recall: { type: "hybrid" as const, topK: 50, vectorWeight: 0.8 },
  rerank: { enabled: true, topN: 6, model: "bce-reranker-base" },
  documents: [{ documentId: "own-document", sourceId: "own-source", sourceRevision: "reviewed-v1",
    kind: "PRIMARY" as const, workTitle: "Reviewed work", edition: null, translator: null,
    chunks: [{ chunkId: "own-chunk", expectedUpdateTime: 1755578217038, expectedSha256: hash, locator: null }],
  }],
};
const payload = {
  requestId: "provider-request", created_at: 1755578217040, total_count: 1,
  chunks: [{ chunk_id: "own-chunk", meta: { chunk_type: "text", update_time: 1755578217038, doc_info: { doc_id: "own-document", doc_name: "not an authoritative title" } },
    content: [{ type: "text", text: "abc" }], neighbors: [],
  }],
};
const cancellation = { cancelled: false, subscribe: () => () => {} };
const hasher = { sha256: async (text: string) => createHash("sha256").update(text, "utf8").digest("hex") };
function fixture(value: unknown = payload, configuration: QianfanConfiguration = config) {
  const calls: SecureNetworkRequest[] = [];
  const rag = new QianfanRAG({ configurations: { resolve: () => configuration }, hasher,
    network: { request: async (call) => { calls.push(call); return { ok: true, status: 200, body: (async function* () { yield JSON.stringify(value); })() }; } },
  });
  return { rag, calls };
}
class TestCancellation implements Cancellation {
  cancelled = false;
  listeners = new Set<() => void>();
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  cancel() { this.cancelled = true; for (const listener of this.listeners) listener(); }
}

describe("Qianfan RAGPort", () => {
  test.each([true, false])("verifies collected detail revisions without guessing search timestamp units (unchanged=%s)", async (unchanged) => {
    const collected: QianfanConfiguration = { ...config, documents: [{ ...config.documents[0]!, chunks: [{ ...config.documents[0]!.chunks[0]!, expectedUpdateTime: 1755578217, revisionSource: "DETAIL" }] }] };
    const rag = new QianfanRAG({ hasher, configurations: { resolve: () => collected }, network: { request: async (call) => ({ ok: true, status: 200, body: (async function* () {
      yield JSON.stringify(call.operation === "qianfan.search" ? payload : { requestId: "detail", id: "own-chunk", documentId: "own-document", knowledgeBaseId: "own-kb", enabled: true, status: "Indexed", content: "abc", updateTime: unchanged ? 1755578217 : 1755578218 });
    })() }) } });
    expect(await rag.retrieve(request, cancellation)).toMatchObject(unchanged ? { ok: true, evidence: [{ text: "abc" }] } : { ok: false, code: "REJECTED" });
  });
  test("does not send an already-cancelled retrieval", async () => {
    const { rag, calls } = fixture();
    const token = new TestCancellation(); token.cancel();
    expect(await rag.retrieve(request, token)).toEqual({ ok: false, code: "REJECTED" });
    expect(calls).toEqual([]);
    expect(token.listeners.size).toBe(0);
  });
  test("closes a late response after cancellation during the headers handoff", async () => {
    const token = new TestCancellation();
    let deliver = (_response: SecureNetworkResponse) => {};
    let returns = 0;
    const pendingHeaders = new Promise<SecureNetworkResponse>((resolve) => { deliver = resolve; });
    const rag = new QianfanRAG({ configurations: { resolve: () => config }, hasher, network: { request: () => pendingHeaders } });
    const pending = rag.retrieve(request, token);
    deliver({ ok: true, status: 200, body: { [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: true, value: undefined }), return: async () => { returns++; return { done: true, value: undefined }; },
    }) } });
    await Promise.resolve();
    token.cancel();
    expect(await pending).toEqual({ ok: false, code: "OUTCOME_UNKNOWN" });
    expect(returns).toBe(1);
  });
  test.each(["{", '{"chunks":', ""]) ("does not accept incomplete JSON %j", async (body) => {
    const rag = new QianfanRAG({ configurations: { resolve: () => config }, hasher,
      network: { request: async () => ({ ok: true, status: 200, body: (async function* () { yield body; })() }) },
    });
    expect(await rag.retrieve(request, cancellation)).toEqual({ ok: false, code: "OUTCOME_UNKNOWN" });
  });
  test("does not expose raw transport errors or perform an implicit retry", async () => {
    let calls = 0;
    const rag = new QianfanRAG({ configurations: { resolve: () => config }, hasher,
      network: { request: async () => { calls++; throw new Error("sensitive provider details"); } },
    });
    expect(await rag.retrieve(request, cancellation)).toEqual({ ok: false, code: "OUTCOME_UNKNOWN" });
    expect(calls).toBe(1);
  });
  test.each([
    { label: "unknown chunk", chunk: { ...payload.chunks[0], chunk_id: "unreviewed" } },
    { label: "foreign document", chunk: { ...payload.chunks[0], meta: { ...payload.chunks[0]?.meta, doc_info: { doc_id: "other-document" } } } },
    { label: "missing source", chunk: { ...payload.chunks[0], meta: { chunk_type: "text", update_time: 1755578217038 } } },
    { label: "changed timestamp", chunk: { ...payload.chunks[0], meta: { ...payload.chunks[0]?.meta, update_time: 1755578217039 } } },
    { label: "changed timestamp type", chunk: { ...payload.chunks[0], meta: { ...payload.chunks[0]?.meta, update_time: "1755578217038" } } },
    { label: "missing timestamp", chunk: { ...payload.chunks[0], meta: { ...payload.chunks[0]?.meta, update_time: undefined } } },
    { label: "same timestamp with changed content", chunk: { ...payload.chunks[0], content: [{ type: "text", text: "changed" }] } },
    { label: "mixed image content", chunk: { ...payload.chunks[0], content: [{ type: "figure", text: "abc" }] } },
    { label: "empty content", chunk: { ...payload.chunks[0], content: [] } },
  ])("rejects $label against the frozen manifest", async ({ chunk }) => {
    const { rag } = fixture({ ...payload, chunks: [chunk] });
    expect(await rag.retrieve(request, cancellation)).toEqual({ ok: false, code: "REJECTED" });
  });
  test("returns a genuine empty retrieval without inventing missing evidence", async () => {
    const { rag } = fixture({ ...payload, total_count: 0, chunks: [] });
    expect(await rag.retrieve(request, cancellation)).toEqual({ ok: true, evidence: [] });
  });
  test("limits retrieval to one KB and reviewed document IDs with graph and expansion disabled", async () => {
    const { rag, calls } = fixture();
    await rag.retrieve(request, cancellation);
    expect(calls).toEqual([{ operation: "qianfan.search", connectionId: "qianfan-connection", attemptId: "rag-attempt", body: {
      query: "What is freedom?", knowledgebase_ids: ["own-kb"],
      metadata_filters: { condition: "and", filters: [{ field: "doc_id", operator: "in", value: ["own-document"] }] },
      recall: { type: "hybrid", top_k: 50, vec_weight: 0.8 }, rerank: { enable: true, top_n: 6, model: "bce-reranker-base" },
      top_k: 6, score_threshold: 0.4, enable_graph: false, enable_expansion: false,
    } }]);
  });
  test("keeps source classifications and quote metadata from the reviewed manifest despite provider labels or later config edits", async () => {
    const local = structuredClone(config);
    const document = local.documents[0];
    if (!document) throw new Error("Fixture document missing");
    const reviewed: QianfanConfiguration = { ...local, documents: [{ ...document, kind: "RESEARCH", workTitle: null }] };
    const rag = new QianfanRAG({ configurations: { resolve: () => reviewed }, hasher,
      network: { request: async () => {
        reviewed.documents = [{ ...document, kind: "PRIMARY", workTitle: "Changed after dispatch" }];
        return { ok: true, status: 200, body: (async function* () { yield JSON.stringify({ ...payload, kind: "PRIMARY", edition: "invented", translator: "invented" }); })() };
      } },
    });
    expect(await rag.retrieve(request, cancellation)).toMatchObject({ ok: true, evidence: [{ kind: "RESEARCH", workTitle: null, edition: null, translator: null, locator: null }] });
  });
  test("rejects an invalid hash result instead of exposing it as an evidence identity", async () => {
    let hashes = 0;
    const rag = new QianfanRAG({ configurations: { resolve: () => config },
      hasher: { sha256: async () => ++hashes === 1 ? hash : "sensitive invalid hash result" },
      network: { request: async () => ({ ok: true, status: 200, body: (async function* () { yield JSON.stringify(payload); })() }) },
    });
    expect(await rag.retrieve(request, cancellation)).toEqual({ ok: false, code: "REJECTED" });
  });
  test("bounds accumulated response data, including whitespace before a valid JSON object", async () => {
    const rag = new QianfanRAG({ configurations: { resolve: () => config }, hasher,
      network: { request: async () => ({ ok: true, status: 200, body: (async function* () { yield " ".repeat(8_000_000); yield JSON.stringify(payload); })() }) },
    });
    expect(await rag.retrieve(request, cancellation)).toEqual({ ok: false, code: "OUTCOME_UNKNOWN" });
  });
  test.each(["headers", "body", "hash"])("cancels a stalled %s operation and never accepts its late evidence", async (phase) => {
    const token = new TestCancellation();
    let release = () => {};
    let entered = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const rag = new QianfanRAG({ configurations: { resolve: () => config },
      hasher: { sha256: async (text) => { if (phase === "hash") { entered = true; await gate; } return hasher.sha256(text); } },
      network: { request: async () => {
        if (phase === "headers") { entered = true; await gate; }
        return { ok: true, status: 200, body: (async function* () {
          if (phase === "body") { entered = true; await gate; }
          yield JSON.stringify(payload);
        })() };
      } },
    });
    let settled = false;
    const pending = rag.retrieve(request, token).then((value) => { settled = true; return value; });
    for (let index = 0; !entered && index < 50; index++) await Promise.resolve();
    expect(entered).toBe(true);
    token.cancel();
    for (let index = 0; !settled && index < 50; index++) await Promise.resolve();
    try { expect(settled).toBe(true); } finally { release(); }
    expect(await pending).toEqual({ ok: false, code: "OUTCOME_UNKNOWN" });
    expect(token.listeners.size).toBe(0);
  });
  test.each([
    { status: 403, interrupted: false, code: "REJECTED" },
    { status: 429, interrupted: false, code: "REJECTED" },
    { status: 403, interrupted: true, code: "OUTCOME_UNKNOWN" },
    { status: 503, interrupted: false, code: "OUTCOME_UNKNOWN" },
  ])("classifies HTTP $status interrupted=$interrupted without retaining supplier error text or retrying", async ({ status, interrupted, code }) => {
    let calls = 0;
    const rag = new QianfanRAG({ configurations: { resolve: () => config }, hasher,
      network: { request: async () => { calls++; return { ok: true, status, body: (async function* () {
        yield "sensitive supplier diagnostics"; if (interrupted) throw new Error("sensitive network diagnostics");
      })() }; } },
    });
    expect(await rag.retrieve(request, cancellation)).toEqual({ ok: false, code });
    expect(calls).toBe(1);
  });
  test.each([
    { label: "missing request identity", value: { ...payload, requestId: undefined } },
    { label: "incorrect result count", value: { ...payload, total_count: 2 } },
    { label: "duplicate chunk", value: { ...payload, total_count: 2, chunks: [...payload.chunks, ...payload.chunks] } },
    { label: "foreign KB marker", value: { ...payload, knowledgebase_id: "other-kb" } },
    { label: "graph chunk", value: { ...payload, chunks: [{ ...payload.chunks[0], meta: { ...payload.chunks[0]?.meta, chunk_type: "graph" } }] } },
    { label: "unreviewed neighbor", value: { ...payload, chunks: [{ ...payload.chunks[0], neighbors: [{ chunk_id: "unreviewed" }] }] } },
  ])("rejects $label without converting it into trusted evidence", async ({ value }) => {
    const { rag } = fixture(value);
    expect(await rag.retrieve(request, cancellation)).toEqual({ ok: false, code: "REJECTED" });
  });
  test.each([
    { label: "empty document scope", configuration: { ...config, documents: [] } },
    { label: "duplicate documents", configuration: { ...config, documents: [...config.documents, ...config.documents] } },
    { label: "oversized topK", configuration: { ...config, topK: 41 } },
    { label: "invalid threshold", configuration: { ...config, scoreThreshold: Number.NaN } },
    { label: "invalid recall budget", configuration: { ...config, recall: { ...config.recall, topK: 201 } } },
    { label: "invalid vector weight", configuration: { ...config, recall: { ...config.recall, vectorWeight: -0.1 } } },
  ])("rejects $label before sending an unscoped or invalid request", async ({ configuration }) => {
    const { rag, calls } = fixture(payload, configuration);
    expect(await rag.retrieve(request, cancellation)).toEqual({ ok: false, code: "REJECTED" });
    expect(calls).toEqual([]);
  });
  test.each(["connectionId", "corpusId", "corpusRevision", "retrievalConfigRevision"])("refuses a different frozen %s before calling the network", async (field) => {
    const { rag, calls } = fixture(payload, { ...config, binding: { ...binding, [field]: "changed" } });
    expect(await rag.retrieve(request, cancellation)).toEqual({ ok: false, code: "REJECTED" });
    expect(calls).toEqual([]);
  });
  test("returns the exact verified text snapshot with reviewed source metadata and a real SHA256", async () => {
    const rag = new QianfanRAG({
      configurations: { resolve: () => config },
      hasher: { sha256: async (text: string) => createHash("sha256").update(text, "utf8").digest("hex") },
      network: { request: async () => ({ ok: true, status: 200, body: (async function* () { yield JSON.stringify(payload); })() }) },
    });
    const result = await rag.retrieve(request, cancellation);
    expect(result).toMatchObject({ ok: true, evidence: [{
      corpusId: "own-corpus", corpusRevision: "corpus-v1", sourceId: "own-source", sourceRevision: "reviewed-v1",
      text: "abc", contentHash: `sha256:${hash}`, kind: "PRIMARY", workTitle: "Reviewed work", edition: null, translator: null, locator: null,
    }] });
  });
});
