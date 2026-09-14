import type { ConversationCheckpoint } from "@pchat/contracts";
import type { ContextSnapshot, Evidence, ModelInputContent, ModelInputSnapshot, RuntimeState, TokenCounter } from "./ports";
import { copy } from "./data";

export class ContextFailure extends Error {
  constructor(readonly outcome: "CONTEXT_BUDGET_EXCEEDED" | "CONTEXT_UNAVAILABLE") { super(outcome) }
}

/** The source IDs come only from the frozen discussion view. Terminal role
 * answers and their journal entries remain immutable, even after recovery. */
function checkpoint(history: ContextSnapshot["history"], state: Readonly<RuntimeState>): ConversationCheckpoint {
  const sourceTurnIds = history.map((entry) => entry.turnId);
  const events = state.events.filter((event) => "turnId" in event && sourceTurnIds.includes(event.turnId));
  if (!events.length || sourceTurnIds.some((id) => !events.some((event) => "turnId" in event && event.turnId === id))) throw new Error("Missing checkpoint provenance");
  return {
    generatorVersion: "pchat-extractive-v1", sourceTurnIds,
    fromEventSeq: events[0]!.seq, toEventSeq: events.at(-1)!.seq,
    userQuestions: history.map((entry) => ({ turnId: entry.turnId, text: entry.question, start: 0, end: entry.question.length })),
    userClaims: [], clarifiedConcepts: [], unresolvedDifferences: [],
    rolePositions: history.flatMap((entry) => {
      const turn = state.turns.find((turn) => turn.id === entry.turnId);
      if (!turn || turn.context.question.text !== entry.question) throw new Error("Missing checkpoint source");
      return turn.roleRuns.flatMap((role) => {
        if (role.status !== "COMPLETED" || !role.answer || role.answer.kind === "INSUFFICIENT_EVIDENCE") return [];
        // Quote the complete opening paragraph, never a reconstructed claim.
        // The range and EXCERPT marker disclose that qualifications may follow.
        const text = role.answer.text.split(/\r?\n\s*\r?\n/, 1)[0]!;
        return [{ turnId: turn.id, roleRunId: role.id, participantId: role.context.participant.id, kind: "EXCERPT" as const, text, start: 0, end: text.length }];
      });
    }),
  };
}

export function assembleContext(context: ContextSnapshot, evidence: Evidence[], counter: TokenCounter, state: Readonly<RuntimeState>): ModelInputSnapshot {
  const policy = context.executionPolicy;
  if (!policy || counter.version !== policy.counterVersion) throw new ContextFailure("CONTEXT_UNAVAILABLE");
  const input: ModelInputContent = { context: { ...copy(context), history: [] }, evidence: copy(evidence), checkpoint: null };
  const count = () => {
    let value: number;
    try { value = counter.count(copy(input), copy(policy)); } catch { throw new ContextFailure("CONTEXT_UNAVAILABLE") }
    if (!Number.isSafeInteger(value) || value < 0) throw new ContextFailure("CONTEXT_UNAVAILABLE");
    return value;
  };
  const available = policy.windowTokens - policy.outputReserveTokens;
  const baseInputTokens = count();
  if (baseInputTokens > available) throw new ContextFailure("CONTEXT_BUDGET_EXCEEDED");
  let inputTokens = baseInputTokens;
  for (let index = context.history.length - 1; index >= 0; index--) {
    input.context.history.unshift(copy(context.history[index]!));
    const next = count();
    if (next > available) { input.context.history.shift(); break }
    inputTokens = next;
  }
  const retainedTurnIds = input.context.history.map((entry) => entry.turnId);
  const omittedTurnIds = context.history.filter((entry) => !retainedTurnIds.includes(entry.turnId)).map((entry) => entry.turnId);
  let checkpointStatus: ModelInputSnapshot["audit"]["checkpointStatus"] = omittedTurnIds.length ? "NO_SPACE" : "NOT_NEEDED";
  const earlier = context.history.slice(0, omittedTurnIds.length);
  for (let index = earlier.length - 1; index >= 0; index--) {
    const previous = input.checkpoint;
    try {
      input.checkpoint = checkpoint(earlier.slice(index), state);
      const next = count();
      if (next > available) { input.checkpoint = previous; break }
      inputTokens = next;
      checkpointStatus = "CAPTURED";
    } catch {
      input.checkpoint = previous;
      if (!previous) checkpointStatus = "UNAVAILABLE";
      break;
    }
  }
  return { ...input, audit: {
    assemblerVersion: "pchat-context-v1", policyVersion: policy.policyVersion, counterVersion: policy.counterVersion,
    promptVersion: policy.promptVersion, countMode: policy.countMode, windowTokens: policy.windowTokens, outputReserveTokens: policy.outputReserveTokens,
    baseInputTokens, inputTokens, retainedTurnIds, omittedTurnIds, checkpointStatus,
  } };
}
