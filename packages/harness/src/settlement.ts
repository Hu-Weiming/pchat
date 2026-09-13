import type { Clock, RuntimeState, TurnRecord } from "./ports";
import { copy } from "./data";
import { emit } from "./journal";
import { transition } from "./transitions";

/** These columns quote existing answers. They do not infer a new conclusion,
 * premise, concept, or disagreement on behalf of the participating roles. */
export function captureComparison(turn: TurnRecord): void {
  const columns = turn.roleRuns.flatMap((role) => role.status === "COMPLETED" && role.answer && role.answer.kind !== "INSUFFICIENT_EVIDENCE"
    ? [{ roleRunId: role.id, participantId: role.context.participant.id, participantLabel: role.context.participant.label, answer: copy(role.answer) }]
    : []);
  turn.comparison = columns.length >= 2 ? {
    columns, excludedRoleRunIds: turn.roleRuns.filter((role) => !columns.some((column) => column.roleRunId === role.id)).map((role) => role.id),
  } : null;
}

export function pauseQueue(state: RuntimeState, turn: TurnRecord, clock: Clock): void {
  const conversation = state.conversations.find((item) => item.id === turn.conversationId)!;
  if (conversation.queueStatus === "PAUSED") return;
  conversation.queueStatus = "PAUSED";
  emit(state, clock, { type: "QueuePaused", conversationId: conversation.id });
}

export function settleTurn(state: RuntimeState, turn: TurnRecord, clock: Clock): void {
  if (turn.status !== "RUNNING" || turn.roleRuns.some((role) => role.status === "PENDING" || role.status === "RETRIEVING" || role.status === "GENERATING")) return;
  captureComparison(turn);
  const waiting = turn.roleRuns.some((role) => role.status === "WAITING_USER");
  const failed = turn.roleRuns.some((role) => role.status === "FAILED");
  const status = waiting ? "WAITING_USER" : failed ? "FAILED" : "COMPLETED";
  transition("turn", turn, status);
  const conversation = state.conversations.find((item) => item.id === turn.conversationId)!;
  transition("question", conversation.questions.find((item) => item.id === turn.questionId)!, status);
  if (!waiting) conversation.activeTurnId = null;
  emit(state, clock, { type: waiting ? "TurnWaiting" : failed ? "TurnFailed" : "TurnCompleted", conversationId: turn.conversationId, questionId: turn.questionId, turnId: turn.id });
  if (waiting || failed) pauseQueue(state, turn, clock);
}
