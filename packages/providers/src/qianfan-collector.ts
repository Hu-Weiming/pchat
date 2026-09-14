import type { Cancellation, ProviderFailure } from "@pchat/harness";
import { CancellationScope } from "./cancellation";
import type { JsonObject, SecureNetworkPort, SecureNetworkRequest } from "./network";
import type { ContentHasher } from "./qianfan";
import { validSha256 } from "./qianfan-configuration";
import { CollectionFailure, nonblank, object, rawTime, readCollectionObject, requireCollection } from "./qianfan-collector-io";

export interface QianfanCollectionRequest { connectionId: string; knowledgebaseId: string; collectionId: string }
export interface QianfanCollectedChunk {
  chunkId: string;
  type: "RAW" | "NEW" | "COPY";
  remoteStatus: "Indexed" | "indexed";
  text: string;
  sha256: string;
  /** Preserved verbatim; no inferred seconds/milliseconds or string conversion. */
  revision: { source: "DescribeChunk.updateTime"; raw: string | number };
}
export interface QianfanCollectedDocument {
  documentId: string;
  /** Untrusted uploaded filename; never an authoritative work title. */
  displayName: string;
  remoteStatus: "available";
  chunks: QianfanCollectedChunk[];
}
/** Per-chunk observations for review, not an atomic or immutable remote corpus. */
export interface QianfanManifestDraft extends QianfanCollectionRequest { status: "DRAFT"; documents: QianfanCollectedDocument[] }
export type QianfanCollectionResult = { ok: true; draft: QianfanManifestDraft } | ProviderFailure;
export interface QianfanCollectionLimits {
  maxDocuments: number;
  maxChunks: number;
  maxPages: number;
  /** UTF-16 code units across collected detail text, preserving whitespace. */
  maxTotalTextChars: number;
  maxResponseChars: number;
}
export interface QianfanCollectionOptions { network: SecureNetworkPort; hasher: ContentHasher; limits?: Partial<QianfanCollectionLimits> }

const defaultLimits: QianfanCollectionLimits = { maxDocuments: 100, maxChunks: 2_000, maxPages: 100, maxTotalTextChars: 8_000_000, maxResponseChars: 8_000_000 };

const indexed = (value: unknown): value is "Indexed" | "indexed" => value === "Indexed" || value === "indexed";
const chunkType = (value: unknown): value is "RAW" | "NEW" | "COPY" => value === "RAW" || value === "NEW" || value === "COPY";
const inScope = (value: Record<string, unknown>, knowledgebaseId: string) => value.knowledgeBaseId === undefined || value.knowledgeBaseId === knowledgebaseId;
function alias(value: Record<string, unknown>, current: string, legacy: string): unknown {
  requireCollection(value[current] === undefined || value[legacy] === undefined || value[current] === value[legacy]);
  return value[current] ?? value[legacy];
}

export class QianfanManifestCollector {
  constructor(private readonly options: QianfanCollectionOptions) {}

  async collect(request: QianfanCollectionRequest, cancellation: Cancellation): Promise<QianfanCollectionResult> {
    const scope = new CancellationScope(cancellation);
    let sent = false;
    try {
      scope.check();
      const input = { connectionId: request.connectionId, knowledgebaseId: request.knowledgebaseId, collectionId: request.collectionId };
      requireCollection(Object.values(input).every((value) => nonblank(value)));
      const limits = { ...defaultLimits, ...this.options.limits };
      requireCollection(Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0));
      let pages = 0;
      let textChars = 0;
      const read = async (operation: SecureNetworkRequest["operation"], body: JsonObject) => {
        scope.check();
        sent = true;
        const result = await readCollectionObject(this.options.network, { connectionId: input.connectionId, attemptId: input.collectionId, operation, body }, cancellation, scope, limits.maxResponseChars);
        requireCollection(inScope(result, input.knowledgebaseId));
        return result;
      };
      async function* list(operation: "qianfan.documents" | "qianfan.chunks", body: JsonObject): AsyncGenerator<unknown> {
        let marker: string | undefined;
        const markers = new Set<string>();
        while (true) {
          requireCollection(++pages <= limits.maxPages);
          const page = await read(operation, { ...body, maxKeys: 100, ...(marker === undefined ? {} : { marker }) });
          requireCollection(Array.isArray(page.data) && page.data.length <= 100 && typeof page.isTruncated === "boolean" && typeof page.nextMarker === "string" && page.nextMarker.length <= 200);
          for (const item of page.data) yield item;
          if (!page.isTruncated) return;
          requireCollection(nonblank(page.nextMarker) && !markers.has(page.nextMarker));
          markers.add(page.nextMarker);
          marker = page.nextMarker;
        }
      }
      const draft: QianfanManifestDraft = { status: "DRAFT", ...input, documents: [] };
      const documentIds = new Set<string>();
      const chunkIds = new Set<string>();
      for await (const document of list("qianfan.documents", { knowledgeBaseId: input.knowledgebaseId })) {
        requireCollection(object(document) && inScope(document, input.knowledgebaseId));
        const documentId = alias(document, "documentId", "id");
        requireCollection(nonblank(documentId) && !documentIds.has(documentId) && nonblank(document.name, 8_000) && alias(document, "status", "displayStatus") === "available" &&
          (document.enabled === true || (document.enabled === undefined && document.status === "available" && nonblank(document.documentId))));
        documentIds.add(documentId);
        requireCollection(documentIds.size <= limits.maxDocuments);
        const collected: QianfanCollectedDocument = { documentId, displayName: document.name, remoteStatus: "available", chunks: [] };
        for await (const chunk of list("qianfan.chunks", { knowledgeBaseId: input.knowledgebaseId, documentId })) {
          requireCollection(object(chunk) && nonblank(chunk.id) && !chunkIds.has(chunk.id) && chunk.knowledgeBaseId === input.knowledgebaseId && chunk.documentId === documentId && chunk.enabled === true && indexed(chunk.status) && chunkType(chunk.type));
          chunkIds.add(chunk.id);
          requireCollection(chunkIds.size <= limits.maxChunks);
          const detail = await read("qianfan.chunk", { knowledgeBaseId: input.knowledgebaseId, chunkId: chunk.id });
          requireCollection(detail.id === chunk.id && detail.knowledgeBaseId === input.knowledgebaseId && detail.documentId === documentId && detail.enabled === true && indexed(detail.status) && chunkType(detail.type) && detail.type === chunk.type &&
            nonblank(detail.content, limits.maxTotalTextChars) && rawTime(detail.updateTime) && Array.isArray(detail.row_line) && detail.row_line.length === 0 && Array.isArray(detail.imageUrls) && detail.imageUrls.length === 0);
          textChars += detail.content.length;
          requireCollection(textChars <= limits.maxTotalTextChars);
          const sha256 = await scope.wait(this.options.hasher.sha256(detail.content));
          requireCollection(validSha256(sha256));
          collected.chunks.push({ chunkId: chunk.id, type: detail.type, remoteStatus: detail.status, text: detail.content, sha256, revision: { source: "DescribeChunk.updateTime", raw: detail.updateTime } });
        }
        draft.documents.push(collected);
      }
      return { ok: true, draft };
    } catch (error) {
      return { ok: false, code: error instanceof CollectionFailure ? error.code : sent ? "OUTCOME_UNKNOWN" : "REJECTED" };
    } finally { scope.close(); }
  }
}
