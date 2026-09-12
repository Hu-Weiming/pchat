import { z } from "zod";

const Id = z.string().min(1).max(200);
export const KnowledgeModeSchema = z.enum(["PRIMARY", "INFERENCE", "FICTION"]);
export const ModelBindingSchema = z.strictObject({
  connectionId: Id,
  modelId: Id,
  configRevision: Id,
});
export const ConversationSettingsSchema = z.strictObject({
  participantId: Id,
  knowledgeMode: KnowledgeModeSchema,
  model: ModelBindingSchema,
  ragConnectionId: Id,
});
export const HarnessCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("CreateConversation"), commandId: Id,
    title: z.string().min(1).max(500), settings: ConversationSettingsSchema,
  }),
  z.strictObject({
    type: z.literal("SubmitQuestion"), commandId: Id, conversationId: Id,
    text: z.string().min(1).max(32_000).refine((value) => value.trim().length > 0),
  }),
  z.strictObject({ type: z.literal("StopTurn"), commandId: Id, turnId: Id }),
  z.strictObject({ type: z.literal("ResumeQueue"), commandId: Id, conversationId: Id }),
  z.strictObject({ type: z.literal("RegenerateRole"), commandId: Id, roleRunId: Id }),
  z.strictObject({ type: z.literal("SuspendRuntime"), commandId: Id }),
  z.strictObject({ type: z.literal("WithdrawQuestion"), commandId: Id, questionId: Id }),
]);
export type KnowledgeMode = z.infer<typeof KnowledgeModeSchema>;
export type ModelBinding = z.infer<typeof ModelBindingSchema>;
export type ConversationSettings = z.infer<typeof ConversationSettingsSchema>;
export type HarnessCommand = z.infer<typeof HarnessCommandSchema>;

export const EventCursorSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export type EventCursor = z.infer<typeof EventCursorSchema>;
export const QuestionStatusSchema = z.enum(["QUEUED", "RUNNING", "WAITING_USER", "COMPLETED", "STOPPED", "FAILED", "WITHDRAWN"]);
export const TurnStatusSchema = z.enum(["RUNNING", "WAITING_USER", "COMPLETED", "STOPPED", "FAILED"]);
export const RoleStatusSchema = z.enum(["RETRIEVING", "GENERATING", "WAITING_USER", "COMPLETED", "STOPPED", "FAILED"]);
export const AttemptStatusSchema = z.enum(["PREPARED", "IN_FLIGHT", "SUCCEEDED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"]);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;
export type TurnStatus = z.infer<typeof TurnStatusSchema>;
export type RoleStatus = z.infer<typeof RoleStatusSchema>;
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;

const error = <T extends string>(code: T) => z.strictObject({ code: z.literal(code), message: z.string() });
export const DomainErrorSchema = z.discriminatedUnion("code", [
  error("INVALID_INPUT"), error("NOT_FOUND"), error("COMMAND_CONFLICT"), error("INVALID_TRANSITION"),
  error("QUEUE_BLOCKED"), error("RUNTIME_REPLACED"), error("BUDGET_EXCEEDED"),
  error("PROVIDER_FAILED"), error("INVALID_PROVIDER_RESULT"),
]);
export type DomainError = z.infer<typeof DomainErrorSchema>;
export const CommandReceiptSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), commandId: Id, lastEventSeq: EventCursorSchema,
    conversationId: Id.optional(), questionId: Id.optional(), turnId: Id.optional(), roleRunId: Id.optional() }),
  z.strictObject({ ok: z.literal(false), commandId: z.string(), lastEventSeq: EventCursorSchema, error: DomainErrorSchema }),
]);
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;

export const QuestionProjectionSchema = z.strictObject({
  id: Id, text: z.string(), status: QuestionStatusSchema, turnId: Id.nullable(), submittedAt: z.number(),
});
export const ConversationProjectionSchema = z.strictObject({
  id: Id, title: z.string(), queueStatus: z.enum(["RUNNING", "PAUSED"]), activeTurnId: Id.nullable(),
  questions: z.array(QuestionProjectionSchema), turnIds: z.array(Id),
});
export type ConversationProjection = z.infer<typeof ConversationProjectionSchema>;

export const HarnessQuerySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ListConversations") }),
  z.strictObject({ type: z.literal("GetConversation"), conversationId: Id }),
]);
export interface QueryMap {
  ListConversations: { request: { type: "ListConversations" }; response: ConversationProjection[] };
  GetConversation: { request: { type: "GetConversation"; conversationId: string }; response: ConversationProjection };
}
export type HarnessQuery = QueryMap[keyof QueryMap]["request"];
export type QueryResult<T> = { ok: true; data: T; lastEventSeq: EventCursor } | { ok: false; error: DomainError; lastEventSeq: EventCursor };

const eventBase = { seq: EventCursorSchema, at: z.number() };
const conversationEvent = <T extends string>(type: T) => z.strictObject({ ...eventBase, type: z.literal(type), conversationId: Id });
export const HarnessEventSchema = z.discriminatedUnion("type", [
  conversationEvent("ConversationCreated"),
]);
export type HarnessEvent = z.infer<typeof HarnessEventSchema>;
