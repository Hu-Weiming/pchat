import type { Answer, Evidence, KnowledgeMode, ThoughtStagePackage } from "./ports";

export function validEvidence(participant: ThoughtStagePackage, evidence: readonly Evidence[]): boolean {
  return new Set(evidence.map((item) => item.id)).size === evidence.length
    && evidence.every((item) => item.corpusId === participant.corpusId && item.corpusRevision === participant.corpusRevision);
}

export function validAnswer(mode: KnowledgeMode, evidence: readonly Evidence[], answer: Answer): boolean {
  if (!answer.evidenceIds.every((id) => evidence.some((item) => item.id === id))) return false;
  if (answer.kind === "FICTION") return mode === "FICTION";
  if (answer.kind === "INFERENCE" && mode === "PRIMARY") return false;
  if (answer.kind === "INSUFFICIENT_EVIDENCE") return answer.evidenceIds.every((id) => evidence.some((item) => item.id === id));
  if (answer.kind === "QUOTE" && !answer.evidenceIds.every((id) => {
    const source = evidence.find((item) => item.id === id);
    return source && [source.locator, source.workTitle, source.edition, source.translator].every((value) => value !== null && value.trim().length > 0);
  })) return false;
  return answer.evidenceIds.length > 0 && answer.evidenceIds.every((id) => evidence.some((item) => item.id === id && item.kind === "PRIMARY"));
}

export function insufficientEvidenceAnswer(): Answer {
  return {
    text: "当前检索未找到足以支持回答的依据。你可以补充资料，或主动选择开放拟构模式。",
    kind: "INSUFFICIENT_EVIDENCE", evidenceIds: [],
  };
}
