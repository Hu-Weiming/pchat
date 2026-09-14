import type { DomainError } from "@pchat/contracts";

/** All persisted/transport data is JSON. Also keeps adapter inputs isolated. */
export function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }

const messages: Record<DomainError["code"], string> = {
  INVALID_INPUT: "The request does not match the contract.",
  NOT_FOUND: "The requested item was not found.",
  COMMAND_CONFLICT: "This commandId already belongs to a different command.",
  INVALID_TRANSITION: "This action is not valid in the current state.",
  QUEUE_BLOCKED: "Resolve or stop the current turn before resuming the queue.",
  RUNTIME_REPLACED: "This runtime is no longer the store owner.",
  RUNTIME_UNAVAILABLE: "Persistence failed; reopen the runtime to recover safely.",
  BUDGET_EXCEEDED: "The configured call budget is exhausted.",
  CONTEXT_BUDGET_EXCEEDED: "The required question, identity and evidence exceed the model input budget.",
  CONTEXT_UNAVAILABLE: "The frozen model input policy or token counter is unavailable.",
  CAPACITY_EXCEEDED: "The configured execution capacity is currently occupied.",
  PROVIDER_FAILED: "The provider did not complete the request.",
  INVALID_PROVIDER_RESULT: "The provider response failed validation.",
};
export function failure(code: DomainError["code"]): DomainError { return { code, message: messages[code] } }
