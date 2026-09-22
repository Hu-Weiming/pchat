import type { Clock, RuntimeState, TurnRecord } from "./ports";
import { transition } from "./transitions";
import { emit } from "./journal";
import { captureComparison } from "./settlement";

export function stopTurn(state: RuntimeState, turn: TurnRecord, clock: Clock): void {
  if (turn.discussion) {
    for (const attempt of turn.discussion.attempts) {
      if (attempt.status === "PREPARED") transition("attempt", attempt, "CANCELLED");
      else if (attempt.status === "IN_FLIGHT") transition("attempt", attempt, "OUTCOME_UNKNOWN");
    }
    turn.discussion.status = "STOPPED";
  }
  for (const role of turn.roleRuns) {
    if (role.status === "COMPLETED" || role.status === "FAILED" || role.status === "STOPPED") continue;
    for (const attempt of role.attempts) {
      if (attempt.status === "PREPARED") transition("attempt", attempt, "CANCELLED");
      else if (attempt.status === "IN_FLIGHT") transition("attempt", attempt, "OUTCOME_UNKNOWN");
    }
    transition("role", role, "STOPPED");
    emit(state, clock, { type: "RoleStopped", conversationId: turn.conversationId, questionId: turn.questionId, turnId: turn.id, roleRunId: role.id });
  }
  transition("turn", turn, "STOPPED");
  captureComparison(turn);
  const conversation = state.conversations.find((item) => item.id === turn.conversationId)!;
  transition("question", conversation.questions.find((item) => item.id === turn.questionId)!, "STOPPED");
  conversation.activeTurnId = null;
  conversation.queueStatus = "PAUSED";
  emit(state, clock, { type: "TurnStopped", conversationId: conversation.id, questionId: turn.questionId, turnId: turn.id });
  emit(state, clock, { type: "QueuePaused", conversationId: conversation.id });
}

/** A persisted IN_FLIGHT attempt may have reached the provider. Recovery never
 * promotes it back to PREPARED or assumes that cancellation avoided a charge. */
export function interruptActiveTurns(state: RuntimeState, clock: Clock): void {
  for (const turn of state.turns) {
    if (turn.status !== "RUNNING") continue;
    if (turn.discussion) {
      for (const attempt of turn.discussion.attempts) {
        if (attempt.status === "PREPARED") transition("attempt", attempt, "CANCELLED");
        else if (attempt.status === "IN_FLIGHT") transition("attempt", attempt, "OUTCOME_UNKNOWN");
      }
      turn.discussion.status = "WAITING_USER";
    }
    for (const role of turn.roleRuns) {
      if (role.status !== "PENDING" && role.status !== "RETRIEVING" && role.status !== "GENERATING") continue;
      for (const attempt of role.attempts) {
        if (attempt.status === "PREPARED") transition("attempt", attempt, "CANCELLED");
        else if (attempt.status === "IN_FLIGHT") transition("attempt", attempt, "OUTCOME_UNKNOWN");
      }
      transition("role", role, "WAITING_USER");
      emit(state, clock, { type: "RoleWaiting", conversationId: turn.conversationId, questionId: turn.questionId, turnId: turn.id, roleRunId: role.id });
    }
    transition("turn", turn, "WAITING_USER");
    captureComparison(turn);
    const conversation = state.conversations.find((item) => item.id === turn.conversationId)!;
    transition("question", conversation.questions.find((item) => item.id === turn.questionId)!, "WAITING_USER");
    conversation.queueStatus = "PAUSED";
    emit(state, clock, { type: "TurnWaiting", conversationId: conversation.id, questionId: turn.questionId, turnId: turn.id });
    emit(state, clock, { type: "QueuePaused", conversationId: conversation.id });
  }
}
