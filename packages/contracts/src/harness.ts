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
  error("PROVIDER_FAILED"), error("INVALID_PROVIDER_RESULT"), error("CAPACITY_EXCEEDED"),
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

export const ThoughtStagePackageSchema = z.strictObject({
  id: Id, revision: Id, label: z.string().min(1), status: z.enum(["CONFIRMED", "DRAFT"]),
  corpusId: Id, corpusRevision: Id, retrievalConfigRevision: Id, promptPolicyRevision: Id,
});
export const EvidenceSchema = z.strictObject({
  id: Id, corpusId: Id, corpusRevision: Id, sourceId: Id, sourceRevision: Id,
  text: z.string().min(1), contentHash: Id, locator: z.string().nullable(), workTitle: z.string().nullable(),
  edition: z.string().nullable(), translator: z.string().nullable(), kind: z.enum(["PRIMARY", "RESEARCH"]),
});
export const AnswerSchema = z.strictObject({
  text: z.string().min(1), kind: z.enum(["PARAPHRASE", "QUOTE", "INFERENCE", "FICTION", "INSUFFICIENT_EVIDENCE"]), evidenceIds: z.array(Id),
});
export const ContextSnapshotSchema = z.strictObject({
  question: z.strictObject({ id: Id, text: z.string() }), settings: ConversationSettingsSchema,
  participant: ThoughtStagePackageSchema,
  history: z.array(z.strictObject({ turnId: Id, question: z.string(), answer: z.string() })),
});
export const ExternalAttemptSchema = z.strictObject({
  id: Id, kind: z.enum(["RAG", "MODEL"]), status: AttemptStatusSchema,
  previousAttemptId: Id.nullable(), reservedCostUnits: z.number().min(0), draft: z.string(),
});
export const RoleRunProjectionSchema = z.strictObject({
  id: Id, status: RoleStatusSchema, textSoFar: z.string(), revision: EventCursorSchema,
  evidence: z.array(EvidenceSchema), answer: AnswerSchema.nullable(),
  attempts: z.array(ExternalAttemptSchema), errorCode: z.string().nullable(),
});
export const TurnProjectionSchema = z.strictObject({
  id: Id, conversationId: Id, questionId: Id, status: TurnStatusSchema,
  context: ContextSnapshotSchema, roleRuns: z.array(RoleRunProjectionSchema),
});
export type ThoughtStagePackage = z.infer<typeof ThoughtStagePackageSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Answer = z.infer<typeof AnswerSchema>;
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;
export type ExternalAttempt = z.infer<typeof ExternalAttemptSchema>;
export type RoleRunProjection = z.infer<typeof RoleRunProjectionSchema>;
export type TurnProjection = z.infer<typeof TurnProjectionSchema>;

export const RetrievalResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), evidence: z.array(EvidenceSchema) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(["REJECTED", "OUTCOME_UNKNOWN"]) }),
]);
export const ModelChunkSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("delta"), text: z.string() }),
  z.strictObject({ type: z.literal("complete"), answer: AnswerSchema }),
  z.strictObject({ type: z.literal("failure"), code: z.enum(["REJECTED", "OUTCOME_UNKNOWN"]) }),
]);

export const HarnessQuerySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ListConversations") }),
  z.strictObject({ type: z.literal("GetConversation"), conversationId: Id }),
  z.strictObject({ type: z.literal("GetTurn"), turnId: Id }),
]);
export interface QueryMap {
  ListConversations: { request: { type: "ListConversations" }; response: ConversationProjection[] };
  GetConversation: { request: { type: "GetConversation"; conversationId: string }; response: ConversationProjection };
  GetTurn: { request: { type: "GetTurn"; turnId: string }; response: TurnProjection };
}
export type HarnessQuery = QueryMap[keyof QueryMap]["request"];
export type QueryResult<T> = { ok: true; data: T; lastEventSeq: EventCursor } | { ok: false; error: DomainError; lastEventSeq: EventCursor };

const eventBase = { seq: EventCursorSchema, at: z.number() };
const conversationEvent = <T extends string>(type: T) => z.strictObject({ ...eventBase, type: z.literal(type), conversationId: Id });
const questionEvent = <T extends string>(type: T) => conversationEvent(type).extend({ questionId: Id });
const turnEvent = <T extends string>(type: T) => questionEvent(type).extend({ turnId: Id });
const roleEvent = <T extends string>(type: T) => turnEvent(type).extend({ roleRunId: Id });
export const HarnessEventSchema = z.discriminatedUnion("type", [
  conversationEvent("ConversationCreated"), conversationEvent("ConversationChanged"),
  conversationEvent("QueuePaused"), conversationEvent("QueueResumed"),
  questionEvent("QuestionAccepted"), questionEvent("QuestionWithdrawn"),
  turnEvent("TurnStarted"), turnEvent("TurnCompleted"), turnEvent("TurnStopped"), turnEvent("TurnFailed"), turnEvent("TurnWaiting"),
  roleEvent("RoleStarted"), roleEvent("EvidenceCaptured"), roleEvent("RoleCheckpoint"),
  roleEvent("RoleCompleted"), roleEvent("RoleStopped"), roleEvent("RoleFailed"), roleEvent("RoleWaiting"),
  z.strictObject({ ...eventBase, type: z.literal("RuntimeSuspended") }),
]);
export type HarnessEvent = z.infer<typeof HarnessEventSchema>;
