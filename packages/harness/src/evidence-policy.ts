import type { Answer, Evidence, KnowledgeMode, ThoughtStagePackage } from "./ports";

export function validEvidence(participant: ThoughtStagePackage, evidence: readonly Evidence[]): boolean {
  return new Set(evidence.map((item) => item.id)).size === evidence.length
    && evidence.every((item) => item.kind === "PRIMARY" && item.corpusId === participant.corpusId && item.corpusRevision === participant.corpusRevision);
}

export function validAnswer(mode: KnowledgeMode, evidence: readonly Evidence[], answer: Answer): boolean {
  if (!answer.evidenceIds.every((id) => evidence.some((item) => item.id === id))) return false;
  if (answer.kind === "FICTION") return mode === "FICTION";
  if (answer.kind === "INFERENCE" && mode === "PRIMARY") return false;
  if (answer.kind === "INSUFFICIENT_EVIDENCE") return answer.evidenceIds.every((id) => evidence.some((item) => item.id === id));
  const cited = evidence.filter((source) => answer.evidenceIds.includes(source.id));
  if (answer.kind === "QUOTE" && !cited.every(canQuote)) return false;
  // A provider's answer label is not proof that its prose is a paraphrase.
  // Recognize copied quoted passages, while leaving short concept labels alone.
  // This catches literal copying, not every possible semantic misattribution.
  for (const match of answer.text.matchAll(/“([^”]+)”|「([^」]+)」|『([^』]+)』|"([^"\n]+)"/g)) {
    const text = match[1] ?? match[2] ?? match[3] ?? match[4]!;
    if ([...text].length < 12 && !/[。！？.!?]/.test(text)) continue;
    const sources = cited.filter((source) => source.text.includes(text));
    if (sources.length > 0 && !sources.some(canQuote)) return false;
  }
  if (cited.some((source) => !canQuote(source) && copiesLongPassage(answer.text, source.text))) return false;
  return answer.evidenceIds.length > 0 && answer.evidenceIds.every((id) => evidence.some((item) => item.id === id && item.kind === "PRIMARY"));
}

function copiesLongPassage(answer: string, source: string): boolean {
  // A missing quote mark does not turn verbatim source text into a paraphrase.
  // Ignore punctuation/spacing changes but require a substantial exact span.
  const plain = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, "");
  const sourceText = plain(source);
  const answerChars = Array.from(plain(answer));
  for (const length of [24, 64]) {
    if (answerChars.length < length || sourceText.length < length) continue;
    for (let start = 0; start <= answerChars.length - length; start++) {
      const fragment = answerChars.slice(start, start + length).join("");
      if (length === 24 && (fragment.match(/\p{Script=Han}/gu)?.length ?? 0) < 16) continue;
      if (sourceText.includes(fragment)) return true;
    }
  }
  return false;
}

function canQuote(source: Evidence): boolean {
  return [source.locator, source.workTitle, source.edition, source.translator].every((value) => value !== null && value.trim().length > 0);
}

export function insufficientEvidenceAnswer(): Answer {
  return {
    text: "当前检索依据不足以在所选知识模式下回答。你可以补充更具体的问题或原典资料。",
    kind: "INSUFFICIENT_EVIDENCE", evidenceIds: [],
  };
}
