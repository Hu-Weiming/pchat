import type { QianfanConfiguration, QianfanDocumentManifest, QianfanChunkManifest } from "./qianfan";

export const validSha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 200;
const optionalText = (value: unknown) => value === null || (typeof value === "string" && value.trim().length > 0 && value.length <= 8_000);
const integer = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
const fraction = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** Freeze exactly the confirmed manifest used by this invocation; later edits to
 * the connection inventory cannot replace its scope, versions or source labels. */
export function snapshotQianfanConfiguration(config: QianfanConfiguration): QianfanConfiguration {
  if (!Object.values(config.binding).every(id) || !id(config.knowledgebaseId) ||
    !integer(config.topK, 40) || !fraction(config.scoreThreshold) ||
    !["fulltext", "semantic", "hybrid"].includes(config.recall.type) ||
    !integer(config.recall.topK, config.recall.type === "fulltext" ? 400 : 200) ||
    (config.recall.vectorWeight !== undefined && (config.recall.type !== "hybrid" || !fraction(config.recall.vectorWeight))) ||
    typeof config.rerank.enabled !== "boolean" || !integer(config.rerank.topN, 40) || !id(config.rerank.model) ||
    !Array.isArray(config.documents) || config.documents.length < 1) throw new Error("Invalid retrieval configuration");
  const documents = new Set<string>();
  const chunks = new Set<string>();
  for (const document of config.documents) {
    if (![document.documentId, document.sourceId, document.sourceRevision].every(id) || documents.has(document.documentId) ||
      (document.kind !== "PRIMARY" && document.kind !== "RESEARCH") || ![document.workTitle, document.edition, document.translator].every(optionalText) ||
      !Array.isArray(document.chunks) || document.chunks.length < 1) throw new Error("Invalid document manifest");
    documents.add(document.documentId);
    for (const chunk of document.chunks) {
      const time = chunk.expectedUpdateTime;
      if (!id(chunk.chunkId) || chunks.has(chunk.chunkId) || !validSha256(chunk.expectedSha256) || !optionalText(chunk.locator) ||
        !(id(time) || (typeof time === "number" && Number.isSafeInteger(time) && time >= 0))) throw new Error("Invalid chunk manifest");
      chunks.add(chunk.chunkId);
    }
  }
  return {
    binding: { ...config.binding }, knowledgebaseId: config.knowledgebaseId,
    topK: config.topK, scoreThreshold: config.scoreThreshold,
    recall: { ...config.recall }, rerank: { ...config.rerank },
    documents: config.documents.map((document: QianfanDocumentManifest) => ({ ...document, chunks: document.chunks.map((chunk: QianfanChunkManifest) => ({ ...chunk })) })),
  };
}
