import type { ConversationSettings } from "@pchat/contracts";
import type { Evidence, ThoughtStagePackage } from "@pchat/harness";

export const testRole: ThoughtStagePackage = {
  id: "test-role", revision: "role-v1", label: "Test thought stage", status: "CONFIRMED",
  corpusId: "test-corpus", corpusRevision: "corpus-v1",
  retrievalConfigRevision: "retrieval-v1", promptPolicyRevision: "prompt-v1",
};

export const testSettings: ConversationSettings = {
  participantIds: [testRole.id], knowledgeMode: "PRIMARY",
  model: { connectionId: "model-test", modelId: "fake-model", configRevision: "model-v1" },
  ragConnectionId: "rag-test",
};

export const testEvidence: Evidence = {
  id: "test-evidence", corpusId: testRole.corpusId, corpusRevision: testRole.corpusRevision,
  sourceId: "test-source", sourceRevision: "source-v1", text: "A test passage about freedom.",
  contentHash: "test-content-hash", locator: "section 1", workTitle: "Test work",
  edition: "Test edition", translator: null, kind: "PRIMARY",
};
