import { z } from "zod";
import { ConversationProjectionSchema, DomainErrorSchema, EventCursorSchema, HarnessCommandSchema, HarnessEventSchema, HarnessQuerySchema, ThoughtStagePackageSchema, TurnProjectionSchema } from "./harness";

export const HARNESS_PROTOCOL_VERSION = 2;
const RequestId = z.string().min(1).max(200);
const envelope = { protocolVersion: z.literal(HARNESS_PROTOCOL_VERSION), requestId: RequestId };
export const ClientRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...envelope, type: z.literal("command"), command: HarnessCommandSchema }),
  z.strictObject({ ...envelope, type: z.literal("query"), query: HarnessQuerySchema }),
]);
export type ClientRequest = z.infer<typeof ClientRequestSchema>;
export const ClientResponseSchema = z.strictObject({ ...envelope, result: z.unknown() });
export const ClientEventSchema = z.strictObject({ protocolVersion: z.literal(HARNESS_PROTOCOL_VERSION), event: HarnessEventSchema });

const queryResult = <T extends z.ZodType>(data: T) => z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), lastEventSeq: EventCursorSchema, data }),
  z.strictObject({ ok: z.literal(false), lastEventSeq: EventCursorSchema, error: DomainErrorSchema }),
]);
export const QueryResultSchemas = {
  ListRoles: queryResult(z.array(ThoughtStagePackageSchema)),
  ListConversations: queryResult(z.array(ConversationProjectionSchema)),
  GetConversation: queryResult(ConversationProjectionSchema),
  GetTurn: queryResult(TurnProjectionSchema),
};
