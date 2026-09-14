import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { QianfanManifestCollector, snapshotQianfanConfiguration, type QianfanManifestDraft, type QianfanConfiguration, type SecureNetworkPort } from "@pchat/providers";
import { ThoughtStagePackageSchema } from "@pchat/contracts";

const text = z.string().trim().min(1).max(200);
const metadata = z.strictObject({ documentId: text, kind: z.enum(["PRIMARY", "RESEARCH"]), workTitle: z.string().max(500).nullable(), edition: z.string().max(500).nullable(), translator: z.string().max(500).nullable() });
const collectSchema = z.strictObject({ knowledgebaseId: text });
const confirmSchema = z.strictObject({ collectionId: z.uuid(), label: text, documents: z.array(metadata).min(1).max(100) });
export function createKnowledgeSetup(stateDirectory: string, network: SecureNetworkPort) {
  let cancelled = false;
  const listeners = new Set<() => void>();
  const cancellation = { get cancelled() { return cancelled; }, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const collector = new QianfanManifestCollector({ network, hasher: { sha256: async (value) => createHash("sha256").update(value, "utf8").digest("hex") } });
  const save = (path: string, value: unknown) => { const temporary = `${path}.${randomUUID()}.tmp`; writeFileSync(temporary, JSON.stringify(value)); renameSync(temporary, path); };
  return {
    accepts(message: unknown): message is { protocolVersion: number; requestId: string; method: string; params: unknown } {
      return !!message && typeof message === "object" && "method" in message && (message.method === "configuration.collect" || message.method === "configuration.confirm");
    },
    async handle(message: { protocolVersion: number; requestId: string; method: string; params: unknown }) {
      const base = { kind: "runtime.response", protocolVersion: 2, requestId: message.requestId };
      try {
        if (cancelled || message.protocolVersion !== 2 || !text.safeParse(message.requestId).success) throw new Error();
        const directory = join(stateDirectory, "knowledge-drafts");
        mkdirSync(directory, { recursive: true });
        if (message.method === "configuration.collect") {
          const { knowledgebaseId } = collectSchema.parse(message.params);
          const collectionId = randomUUID();
          const result = await collector.collect({ connectionId: "qianfan-personal", knowledgebaseId, collectionId }, cancellation);
          if (!result.ok || cancelled || !result.draft.documents.some((document) => document.chunks.length > 0)) throw new Error();
          save(join(directory, `${collectionId}.json`), result.draft);
          return { ...base, ok: true, result: { collectionId, knowledgebaseId, documents: result.draft.documents.filter((document) => document.chunks.length > 0).map((document) => ({ documentId: document.documentId, displayName: document.displayName, chunkCount: document.chunks.length, preview: document.chunks[0]?.text.slice(0, 240) ?? "" })) } };
        }
        const input = confirmSchema.parse(message.params);
        if (new Set(input.documents.map((document) => document.documentId)).size !== input.documents.length) throw new Error();
        const draft = JSON.parse(readFileSync(join(directory, `${input.collectionId}.json`), "utf8")) as QianfanManifestDraft;
        if (draft.status !== "DRAFT" || draft.collectionId !== input.collectionId) throw new Error();
        const path = join(stateDirectory, "configuration.json");
        const config = JSON.parse(readFileSync(path, "utf8"));
        const previous = (config.retrieval as QianfanConfiguration[]).find((entry) => entry.knowledgebaseId === draft.knowledgebaseId);
        const corpusId = previous?.binding.corpusId ?? randomUUID();
        const revision = randomUUID();
        const retrieval = snapshotQianfanConfiguration({ binding: { connectionId: draft.connectionId, corpusId, corpusRevision: revision, retrievalConfigRevision: revision }, knowledgebaseId: draft.knowledgebaseId,
          topK: 5, scoreThreshold: 0.3, recall: { type: "hybrid", topK: 20, vectorWeight: 0.8 }, rerank: { enabled: false, topN: 5, model: "bce-reranker-base" },
          documents: input.documents.map((document) => {
            const collected = draft.documents.find((entry) => entry.documentId === document.documentId);
            if (!collected || !collected.chunks.length) throw new Error();
            return { ...document, sourceId: document.documentId, sourceRevision: revision, chunks: collected.chunks.map((chunk) => ({ chunkId: chunk.chunkId, expectedUpdateTime: chunk.revision.raw, expectedSha256: chunk.sha256, revisionSource: "DETAIL", locator: null })) };
          }),
        });
        const oldRole = config.roles.find((role: { corpusId: string }) => role.corpusId === corpusId);
        const role = ThoughtStagePackageSchema.parse({ id: oldRole?.id ?? randomUUID(), revision, label: input.label, status: "CONFIRMED", corpusId, corpusRevision: revision, retrievalConfigRevision: revision, promptPolicyRevision: "pchat-role-v1" });
        config.roles = config.roles.filter((entry: { id: string }) => entry.id !== role.id);
        if (config.roles.length >= 20) throw new Error();
        config.roles.push(role); config.retrieval.push(retrieval);
        if (cancelled) throw new Error();
        save(path, config);
        return { ...base, ok: true, result: { confirmed: true, role } };
      } catch { return { ...base, ok: false, error: "RUNTIME_UNAVAILABLE" }; }
    },
    close() { cancelled = true; for (const listener of listeners) listener(); listeners.clear(); },
  };
}
