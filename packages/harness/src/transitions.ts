import type { AttemptStatus, QuestionStatus, RoleStatus, TurnStatus } from "@pchat/contracts";

const question: Record<QuestionStatus, readonly QuestionStatus[]> = {
  QUEUED: ["RUNNING", "WITHDRAWN"], RUNNING: ["COMPLETED", "FAILED", "STOPPED", "WAITING_USER"],
  WAITING_USER: ["RUNNING", "STOPPED"], COMPLETED: [], FAILED: [], STOPPED: [], WITHDRAWN: [],
};
const turn: Record<TurnStatus, readonly TurnStatus[]> = {
  RUNNING: ["COMPLETED", "FAILED", "STOPPED", "WAITING_USER"], WAITING_USER: ["RUNNING", "STOPPED"], COMPLETED: [], FAILED: [], STOPPED: [],
};
const role: Record<RoleStatus, readonly RoleStatus[]> = {
  PENDING: ["RETRIEVING", "GENERATING", "STOPPED", "WAITING_USER"],
  RETRIEVING: ["GENERATING", "FAILED", "STOPPED", "WAITING_USER"], GENERATING: ["COMPLETED", "FAILED", "STOPPED", "WAITING_USER"],
  WAITING_USER: ["PENDING", "STOPPED"], COMPLETED: [], FAILED: [], STOPPED: [],
};
const attempt: Record<AttemptStatus, readonly AttemptStatus[]> = {
  PREPARED: ["IN_FLIGHT", "CANCELLED"], IN_FLIGHT: ["SUCCEEDED", "FAILED", "OUTCOME_UNKNOWN"],
  SUCCEEDED: [], FAILED: [], CANCELLED: [], OUTCOME_UNKNOWN: [],
};
export function transition<T extends "question" | "turn" | "role" | "attempt">(
  kind: T,
  entity: { status: ({ question: QuestionStatus; turn: TurnStatus; role: RoleStatus; attempt: AttemptStatus })[T] },
  next: ({ question: QuestionStatus; turn: TurnStatus; role: RoleStatus; attempt: AttemptStatus })[T],
): void {
  const table = { question, turn, role, attempt }[kind] as Record<string, readonly string[]>;
  if (!table[entity.status]?.includes(next)) throw new Error(`Illegal ${kind} transition: ${entity.status} -> ${next}`);
  entity.status = next;
}
