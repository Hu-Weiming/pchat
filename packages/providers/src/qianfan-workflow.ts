import { EvidenceSchema } from "@pchat/contracts";
import type { Cancellation, Evidence, RAGPort, RetrievalRequest, RetrievalResult } from "@pchat/harness";
import type { ContentHasher, QianfanBinding } from "./qianfan";
import type { SecureNetworkPort } from "./network";
import { CancellationScope } from "./cancellation";
import { CollectionFailure, nonblank, object, readCollectionObject, requireCollection } from "./qianfan-collector-io";
import { primaryExcerpt } from "./primary-excerpt";

export interface QianfanWorkflowConfiguration {
  binding: QianfanBinding; appId: string; group: string; person: string; datasetId: string;
  maxEvidenceChars: number; maxPassages: number;
}
export function snapshotWorkflowConfiguration(value: QianfanWorkflowConfiguration): QianfanWorkflowConfiguration {
  requireCollection(object(value) && object(value.binding) && [value.appId, value.group, value.person, value.datasetId, ...Object.values(value.binding)].every((s) => nonblank(s))
    && Number.isSafeInteger(value.maxEvidenceChars) && value.maxEvidenceChars >= 100 && value.maxEvidenceChars <= 32000
    && Number.isSafeInteger(value.maxPassages) && value.maxPassages >= 1 && value.maxPassages <= 12);
  return { ...value, binding: { ...value.binding } };
}

/** The confirmed application is a retrieval workflow. Neither a free-form
 * answer nor a model fallback can become evidence. A fresh remote conversation
 * for each invocation prevents earlier persons/questions leaking into retrieval. */
export class QianfanWorkflowRAG implements RAGPort {
  constructor(private readonly options: { network: SecureNetworkPort; hasher: ContentHasher;
    configurations: { resolve(binding: QianfanBinding): QianfanWorkflowConfiguration | undefined } }) {}

  async retrieve(request: RetrievalRequest, cancellation: Cancellation): Promise<RetrievalResult> {
    const scope = new CancellationScope(cancellation);
    let sent = false;
    try {
      scope.check();
      const binding = { connectionId: request.connectionId, corpusId: request.corpusId, corpusRevision: request.corpusRevision, retrievalConfigRevision: request.retrievalConfigRevision };
      const resolved = this.options.configurations.resolve(binding);
      requireCollection(resolved && Object.entries(binding).every(([key, value]) => resolved.binding[key as keyof QianfanBinding] === value));
      const config = snapshotWorkflowConfiguration(resolved);
      requireCollection(nonblank(request.query, 32000));
      const read = (operation: "qianfan.conversation" | "qianfan.workflow", body: import("./network").JsonObject) => {
        scope.check(); sent = true;
        return readCollectionObject(this.options.network, { operation, connectionId: binding.connectionId, attemptId: request.attemptId, body }, cancellation, scope, 8_000_000, "request_id");
      };
      const conversation = await read("qianfan.conversation", { app_id: config.appId });
      requireCollection(nonblank(conversation.conversation_id));
      const result = await read("qianfan.workflow", { app_id: config.appId, conversation_id: conversation.conversation_id,
        query: request.query, stream: false, parameters: { group: config.group, per: config.person } });
      requireCollection(result.conversation_id === conversation.conversation_id && Array.isArray(result.content));
      requireCollection(result.content.every((event) => object(event) && event.event_code === 0));
      requireCollection(result.content.some((event) => object(event) && event.event_type === "chatflow" && event.event_status === "success"));
      const outputs = result.content.filter((event) => object(event) && event.event_type === "chatflow" && event.content_type === "code" && event.event_status === "done");
      requireCollection(outputs.length === 1);
      const output: unknown = outputs[0];
      requireCollection(object(output) && object(output.outputs) && typeof output.outputs.code === "string" && output.outputs.code === result.answer);
      const data: unknown = JSON.parse(output.outputs.code);
      requireCollection(object(data) && Object.keys(data).length > 0 && Object.keys(data).every((key) => /^output(?:[1-9]|1[0-2])?$/.test(key)));
      const branches = Object.values(data).filter((value) => value !== null);
      requireCollection(branches.length === 1 && Array.isArray(branches[0]) && branches[0].length <= 256);
      const unique = new Map<string, { text: string; document: string; segment: string; title: string; score: number; original: string | null; offset: number | null }>();
      for (const raw of branches[0]) {
        requireCollection(object(raw) && raw.dataset_id === config.datasetId && nonblank(raw.document_id) && nonblank(raw.segment_id)
          && nonblank(raw.document_name, 8000) && nonblank(raw.content, 2_000_000) && typeof raw.score === "number" && Number.isFinite(raw.score));
        const key = JSON.stringify([raw.document_id, raw.segment_id]);
        const prior = unique.get(key);
        requireCollection(!prior || (prior.text === raw.content && prior.title === raw.document_name));
        if (!prior || raw.score > prior.score) unique.set(key, { text: raw.content, document: raw.document_id, segment: raw.segment_id, title: raw.document_name, score: raw.score,
          original: nonblank(raw.original_chunk_id) ? raw.original_chunk_id : null, offset: typeof raw.original_chunk_offset === "number" && Number.isFinite(raw.original_chunk_offset) ? raw.original_chunk_offset : null });
      }
      const evidence: Evidence[] = [];
      let remaining = config.maxEvidenceChars;
      const excerpts = new Set<string>();
      for (const chunk of [...unique.values()].sort((a, b) => b.score - a.score)) {
        if (evidence.length >= config.maxPassages) break;
        const excerpt = primaryExcerpt(chunk.text, request.query, Math.min(2400, remaining));
        if (!excerpt) continue;
        const interview = /访谈|interview/i.test(chunk.title);
        const speakers = [...excerpt.text.matchAll(/(?:^|\r?\n)\s*(?:\*\*)?([^\r\n：:]{1,30})\s*[：:](?:\*\*)?/gu)]
          .map((match) => match[1]!.trim().normalize("NFKC"));
        const namedSpeech = speakers[0] === config.person.normalize("NFKC")
          || /^\s*\*\*[^\r\n：:]{1,30}[：:]\*\*/u.test(excerpt.text);
        // A speaker label in a mixed anthology does not establish interview
        // provenance; an interview document must identify this role's speech.
        if (interview ? speakers.length === 0 || speakers.some((speaker) => speaker !== config.person.normalize("NFKC")) : namedSpeech) continue;
        const sourceDigest = await scope.wait(this.options.hasher.sha256(chunk.text));
        const digest = await scope.wait(this.options.hasher.sha256(excerpt.text));
        const excerptKey = JSON.stringify([chunk.document, digest]);
        if (excerpts.has(excerptKey)) continue;
        const id = await scope.wait(this.options.hasher.sha256(JSON.stringify([config.datasetId, chunk.document, chunk.segment, sourceDigest, excerpt.start, excerpt.end])));
        requireCollection(/^[a-f0-9]{64}$/.test(digest) && /^[a-f0-9]{64}$/.test(id));
        evidence.push(EvidenceSchema.parse({ id: `qfw-${id}`, corpusId: binding.corpusId, corpusRevision: binding.corpusRevision,
          sourceId: chunk.document, sourceRevision: `sha256:${sourceDigest}`, text: excerpt.text, contentHash: `sha256:${digest}`,
          kind: "PRIMARY", workTitle: chunk.title, edition: null, translator: null, locator: null,
          ...(interview ? { sourceForm: "INTERVIEW" } : {}),
          sourceExcerpt: { datasetId: config.datasetId, segmentId: chunk.segment, originalChunkId: chunk.original, originalChunkOffset: chunk.offset, sourceContentHash: `sha256:${sourceDigest}`, start: excerpt.start, end: excerpt.end } }));
        remaining -= excerpt.text.length;
        excerpts.add(excerptKey);
      }
      return { ok: true, evidence };
    } catch (error) {
      return { ok: false, code: error instanceof CollectionFailure ? error.code : sent ? "OUTCOME_UNKNOWN" : "REJECTED" };
    } finally { scope.close(); }
  }
}
