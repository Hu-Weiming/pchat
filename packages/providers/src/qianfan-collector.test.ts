import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { QianfanManifestCollector } from "./qianfan-collector";
import type { QianfanCollectionOptions } from "./qianfan-collector";
import type { SecureNetworkRequest } from "./network";

const request = { connectionId: "qianfan-connection", knowledgebaseId: "own-kb", collectionId: "collection-1" };
const cancellation = { cancelled: false, subscribe: () => () => {} };
const hasher = { sha256: async (text: string) => createHash("sha256").update(text, "utf8").digest("hex") };
const document = { documentId: "doc-1", name: "Uploaded document.pdf", status: "available", meta: { source: "local", url: "https://untrusted.invalid/?secret=credential" } };
const chunk = { id: "chunk-1", type: "RAW", knowledgeBaseId: "own-kb", documentId: "doc-1", enabled: true, status: "indexed", updateTime: 1765519532, content: "truncated preview" };
const detail = { ...chunk, requestId: "provider-detail", content: "abc", row_line: [], imageUrls: [] };
const page = (data: unknown[], nextMarker = "", isTruncated = false) => ({ requestId: "provider-list", marker: "", maxKeys: 100, data, nextMarker, isTruncated });
function fixture(responses: unknown[] = [page([document]), page([chunk]), detail], overrides: Partial<QianfanCollectionOptions> = {}) {
  const calls: SecureNetworkRequest[] = [];
  const collector = new QianfanManifestCollector({ hasher, network: { request: async (call) => {
    calls.push(call);
    const value = responses[calls.length - 1];
    return { ok: true, status: 200, body: (async function* () { yield JSON.stringify(value); })() };
  } }, ...overrides });
  return { collector, calls };
}

describe("Qianfan read-only manifest collection", () => {
  test.each([
    { limits: { maxPages: 1 }, responses: [page([document])], calls: 1, code: "REJECTED" },
    { limits: { maxDocuments: 1 }, responses: [page([document, { ...document, documentId: "doc-2" }]), page([])], calls: 2, code: "REJECTED" },
    { limits: { maxChunks: 1 }, responses: [page([document]), page([chunk, { ...chunk, id: "chunk-2" }]), detail], calls: 3, code: "REJECTED" },
    { limits: { maxTotalTextChars: 2 }, responses: [page([document]), page([chunk]), detail], calls: 3, code: "REJECTED" },
    { limits: { maxResponseChars: 10 }, responses: [page([document])], calls: 1, code: "OUTCOME_UNKNOWN" },
  ])("enforces collection capacity $limits without returning a partial draft", async ({ limits, responses, calls: count, code }) => {
    const { collector, calls } = fixture(responses, { limits });
    expect(await collector.collect(request, cancellation)).toEqual({ ok: false, code });
    expect(calls).toHaveLength(count);
  });
  test("rejects a changed chunk type between list and detail", async () => {
    const { collector } = fixture([page([document]), page([chunk]), { ...detail, type: "NEW" }]);
    expect(await collector.collect(request, cancellation)).toEqual({ ok: false, code: "REJECTED" });
  });
  test("follows document and chunk pagination without treating list previews as full content", async () => {
    const chunk2 = { ...chunk, id: "chunk-2" };
    const { collector, calls } = fixture([
      page([document], "doc-1", true), page([chunk], "chunk-1", true), detail,
      page([chunk2]), { ...detail, id: "chunk-2", content: "  second\ntext  ", updateTime: "raw-time-label" },
      page([{ ...document, documentId: "doc-2" }]), page([]),
    ]);
    const result = await collector.collect(request, cancellation);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.documents.map((item) => item.documentId)).toEqual(["doc-1", "doc-2"]);
    expect(result.draft.documents[0]?.chunks[1]).toMatchObject({ text: "  second\ntext  ", revision: { source: "DescribeChunk.updateTime", raw: "raw-time-label" } });
    expect(calls[3]?.body).toEqual({ knowledgeBaseId: "own-kb", documentId: "doc-1", maxKeys: 100, marker: "chunk-1" });
    expect(calls[5]?.body).toEqual({ knowledgeBaseId: "own-kb", maxKeys: 100, marker: "doc-1" });
  });
  test("rejects legacy document metadata without the legacy enabled proof", async () => {
    const { collector, calls } = fixture([page([{ id: "doc-1", name: "old.txt", displayStatus: "available" }])]);
    expect(await collector.collect(request, cancellation)).toEqual({ ok: false, code: "REJECTED" });
    expect(calls).toHaveLength(1);
  });
  test("rejects duplicate chunks before fetching the same detail twice", async () => {
    const { collector, calls } = fixture([page([document]), page([chunk, chunk]), detail, detail]);
    expect(await collector.collect(request, cancellation)).toEqual({ ok: false, code: "REJECTED" });
    expect(calls).toHaveLength(3);
  });
  test("reads full detail text into a draft with exact SHA-256 and raw revision provenance", async () => {
    const { collector, calls } = fixture();
    expect(await collector.collect(request, cancellation)).toEqual({ ok: true, draft: {
      status: "DRAFT", ...request, documents: [{ documentId: "doc-1", displayName: "Uploaded document.pdf", remoteStatus: "available",
        chunks: [{ chunkId: "chunk-1", type: "RAW", remoteStatus: "indexed", text: "abc",
          sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
          revision: { source: "DescribeChunk.updateTime", raw: 1765519532 },
        }],
      }],
    } });
    expect(calls).toEqual([
      { connectionId: request.connectionId, attemptId: request.collectionId, operation: "qianfan.documents", body: { knowledgeBaseId: "own-kb", maxKeys: 100 } },
      { connectionId: request.connectionId, attemptId: request.collectionId, operation: "qianfan.chunks", body: { knowledgeBaseId: "own-kb", documentId: "doc-1", maxKeys: 100 } },
      { connectionId: request.connectionId, attemptId: request.collectionId, operation: "qianfan.chunk", body: { knowledgeBaseId: "own-kb", chunkId: "chunk-1" } },
    ]);
  });
});
