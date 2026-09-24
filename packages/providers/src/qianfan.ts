import { EvidenceSchema } from "@pchat/contracts";
import type { Evidence } from "@pchat/contracts";
import type { Cancellation, RAGPort, RetrievalRequest, RetrievalResult } from "@pchat/harness";
import type { JsonObject, SecureNetworkPort } from "./network";
import { snapshotQianfanConfiguration, validSha256 } from "./qianfan-configuration";
import { CancellationScope, closeStream } from "./cancellation";
import { readCollectionObject } from "./qianfan-collector-io";

export interface QianfanBinding {
  connectionId: string;
  corpusId: string;
  corpusRevision: string;
  retrievalConfigRevision: string;
}
export interface QianfanChunkManifest {
  chunkId: string;
  expectedUpdateTime: string | number;
  revisionSource?: "SEARCH" | "DETAIL";
  expectedSha256: string;
  locator: string | null;
}
export interface QianfanDocumentManifest {
  documentId: string;
  sourceId: string;
  sourceRevision: string;
  kind: "PRIMARY" | "RESEARCH";
  workTitle: string | null;
  edition: string | null;
  translator: string | null;
  sourceForm?: "INTERVIEW";
  speakerLabel?: string;
  chunks: readonly QianfanChunkManifest[];
}
export interface QianfanConfiguration {
  binding: QianfanBinding;
  knowledgebaseId: string;
  documents: readonly QianfanDocumentManifest[];
  topK: number;
  scoreThreshold: number;
  recall: { type: "fulltext" | "semantic" | "hybrid"; topK: number; vectorWeight?: number };
  rerank: { enabled: boolean; topN: number; model: string };
}
export interface QianfanConfigurationResolver { resolve(binding: QianfanBinding): QianfanConfiguration | undefined }
/** SHA-256 of exact UTF-8 text, returned as 64 lowercase hexadecimal characters. */
export interface ContentHasher { sha256(text: string): Promise<string> }
export interface QianfanOptions { network: SecureNetworkPort; configurations: QianfanConfigurationResolver; hasher: ContentHasher }

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const wrongKnowledgebase = (value: Record<string, unknown>, expected: string) =>
  ["knowledgebase_id", "knowledgeBaseId"].some((key) => value[key] !== undefined && value[key] !== expected) ||
  (value.knowledgebase_ids !== undefined && (!Array.isArray(value.knowledgebase_ids) || value.knowledgebase_ids.length !== 1 || value.knowledgebase_ids[0] !== expected));

export class QianfanRAG implements RAGPort {
  constructor(private readonly options: QianfanOptions) {}

  async retrieve(request: RetrievalRequest, cancellation: Cancellation): Promise<RetrievalResult> {
    let sent = false;
    const scope = new CancellationScope(cancellation);
    let responseStream: AsyncIterator<string> | undefined;
    let closed = false;
    const releaseResponse = () => { closeStream(responseStream); responseStream = undefined; };
    try {
      scope.check();
      const binding: QianfanBinding = { connectionId: request.connectionId, corpusId: request.corpusId, corpusRevision: request.corpusRevision, retrievalConfigRevision: request.retrievalConfigRevision };
      const resolved = this.options.configurations.resolve({ ...binding });
      if (!resolved || resolved.binding.connectionId !== binding.connectionId || resolved.binding.corpusId !== binding.corpusId || resolved.binding.corpusRevision !== binding.corpusRevision || resolved.binding.retrievalConfigRevision !== binding.retrievalConfigRevision) return { ok: false, code: "REJECTED" };
      const config = snapshotQianfanConfiguration(resolved);
      const body: JsonObject = {
        query: request.query, knowledgebase_ids: [config.knowledgebaseId],
        metadata_filters: { condition: "and", filters: [{ field: "doc_id", operator: "in", value: config.documents.map((document) => document.documentId) }] },
        recall: { type: config.recall.type, top_k: config.recall.topK, ...(config.recall.vectorWeight !== undefined ? { vec_weight: config.recall.vectorWeight } : {}) },
        rerank: { enable: config.rerank.enabled, top_n: config.rerank.topN, model: config.rerank.model },
        top_k: config.topK, score_threshold: config.scoreThreshold, enable_graph: false, enable_expansion: false,
      };
      scope.check();
      sent = true;
      const pendingResponse = this.options.network.request({ operation: "qianfan.search", connectionId: binding.connectionId, attemptId: request.attemptId, body }, cancellation).then((response) => {
        if (response.ok) {
          responseStream = response.body[Symbol.asyncIterator]();
          if (closed || cancellation.cancelled) releaseResponse();
        }
        return response;
      });
      void pendingResponse.catch(() => {});
      const response = await scope.wait(pendingResponse);
      if (!response.ok) return { ok: false, code: response.code === "REJECTED" ? "REJECTED" : "OUTCOME_UNKNOWN" };
      if (!responseStream) throw new Error("Missing response stream");
      let buffer = "";
      let responseChars = 0;
      while (true) {
        const next = await scope.wait(responseStream.next());
        if (next.done) break;
        responseChars += next.value.length;
        if (responseChars > 8_000_000) throw new Error("Response limit");
        if (response.status === 200) buffer += next.value;
      }
      if (response.status !== 200) return { ok: false, code: Number.isInteger(response.status) && response.status >= 400 && response.status < 500 ? "REJECTED" : "OUTCOME_UNKNOWN" };
      const result: unknown = JSON.parse(buffer);
      if (!record(result) || !string(result.requestId) || !Number.isSafeInteger(result.created_at) || !Array.isArray(result.chunks) ||
        result.total_count !== result.chunks.length || result.chunks.length > config.topK || "code" in result || "error" in result || wrongKnowledgebase(result, config.knowledgebaseId)) return { ok: false, code: "REJECTED" };
      const evidence: Evidence[] = [];
      const returned = new Set<string>();
      for (const chunk of result.chunks) {
        if (!record(chunk) || !string(chunk.chunk_id) || !record(chunk.meta) || chunk.meta.chunk_type !== "text" || !record(chunk.meta.doc_info) ||
          !Array.isArray(chunk.content) || !Array.isArray(chunk.neighbors) || chunk.neighbors.length !== 0 || returned.has(chunk.chunk_id) ||
          [chunk, chunk.meta, chunk.meta.doc_info].some((value) => wrongKnowledgebase(value, config.knowledgebaseId))) return { ok: false, code: "REJECTED" };
        returned.add(chunk.chunk_id);
        const documentId = chunk.meta.doc_info.doc_id;
        const document = config.documents.find((document) => document.documentId === documentId);
        const expected = document?.chunks.find((item) => item.chunkId === chunk.chunk_id);
        if (!document || !expected || (expected.revisionSource !== "DETAIL" && chunk.meta.update_time !== expected.expectedUpdateTime)) return { ok: false, code: "REJECTED" };
        const parts: string[] = [];
        for (const part of chunk.content) {
          if (!record(part) || part.type !== "text" || !string(part.text)) return { ok: false, code: "REJECTED" };
          parts.push(part.text);
        }
        const text = parts.join("\n");
        const digest = await scope.wait(this.options.hasher.sha256(text));
        if (!validSha256(digest) || digest !== expected.expectedSha256) return { ok: false, code: "REJECTED" };
        if (expected.revisionSource === "DETAIL") {
          const detail = await readCollectionObject(this.options.network, { operation: "qianfan.chunk", connectionId: binding.connectionId, attemptId: request.attemptId, body: { knowledgeBaseId: config.knowledgebaseId, chunkId: expected.chunkId } }, cancellation, scope, 8_000_000);
          if (detail.id !== expected.chunkId || detail.documentId !== document.documentId || detail.knowledgeBaseId !== config.knowledgebaseId || detail.enabled !== true || !["Indexed", "indexed"].includes(String(detail.status)) || detail.updateTime !== expected.expectedUpdateTime || detail.content !== text) return { ok: false, code: "REJECTED" };
        }
        if (document.sourceForm === "INTERVIEW") {
          const speakers = [...text.matchAll(/(?:^|\r?\n)\s*(?:\*\*)?([^\r\n：:]{1,30})\s*[：:](?:\*\*)?/gu)]
            .map((match) => match[1]!.trim().normalize("NFKC"));
          if (speakers.length === 0 || speakers.some((speaker) => speaker !== document.speakerLabel!.normalize("NFKC"))) continue;
        }
        const id = await scope.wait(this.options.hasher.sha256(JSON.stringify([binding.connectionId, config.knowledgebaseId, document.documentId, chunk.chunk_id, document.sourceRevision, digest])));
        if (!validSha256(id)) return { ok: false, code: "REJECTED" };
        evidence.push(EvidenceSchema.parse({
          id: `qf-${id}`, corpusId: binding.corpusId, corpusRevision: binding.corpusRevision,
          sourceId: document.sourceId, sourceRevision: document.sourceRevision, text, contentHash: `sha256:${digest}`,
          kind: document.kind, workTitle: document.workTitle, edition: document.edition, translator: document.translator, locator: expected.locator,
          ...(document.sourceForm ? { sourceForm: document.sourceForm } : {}),
        }));
      }
      return { ok: true, evidence };
    } catch {
      return { ok: false, code: sent ? "OUTCOME_UNKNOWN" : "REJECTED" };
    } finally {
      closed = true;
      scope.close();
      releaseResponse();
    }
  }
}
