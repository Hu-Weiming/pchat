import { z } from "zod";
import { ClientEventSchema, ClientRequestSchema } from "./client";
import { EventCursorSchema } from "./harness";

export const WINDOWS_PROTOCOL_VERSION = 2;
export const WindowsRequestIdSchema = z.string().min(1).max(200);
const requestBase = { protocolVersion: z.literal(WINDOWS_PROTOCOL_VERSION), requestId: WindowsRequestIdSchema };
export const WindowsRuntimeRequestSchema = z.discriminatedUnion("method", [
  z.strictObject({ ...requestBase, method: z.literal("harness.request"), params: ClientRequestSchema }),
  z.strictObject({ ...requestBase, method: z.literal("harness.subscribe"), params: z.strictObject({ subscriptionId: WindowsRequestIdSchema, after: EventCursorSchema }) }),
  z.strictObject({ ...requestBase, method: z.literal("harness.unsubscribe"), params: z.strictObject({ subscriptionId: WindowsRequestIdSchema }) }),
]);
const eventBase = { kind: z.literal("runtime.event"), protocolVersion: z.literal(WINDOWS_PROTOCOL_VERSION) };
export const WindowsRuntimeEventSchema = z.discriminatedUnion("event", [
  z.strictObject({ ...eventBase, event: z.literal("harness"), payload: z.strictObject({ subscriptionId: WindowsRequestIdSchema, envelope: ClientEventSchema }) }),
  z.strictObject({ ...eventBase, event: z.literal("harness.closed"), payload: z.strictObject({ subscriptionId: WindowsRequestIdSchema, error: z.literal("REFRESH_REQUIRED") }) }),
]);
export type WindowsRuntimeEvent = z.infer<typeof WindowsRuntimeEventSchema>;
export const WindowsRuntimeResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ kind: z.literal("runtime.response"), protocolVersion: z.literal(WINDOWS_PROTOCOL_VERSION),
    requestId: WindowsRequestIdSchema, ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ kind: z.literal("runtime.response"), protocolVersion: z.literal(WINDOWS_PROTOCOL_VERSION),
    requestId: WindowsRequestIdSchema, ok: z.literal(false), error: z.enum(["INVALID_REQUEST", "RUNTIME_UNAVAILABLE"]) }),
]);
export type WindowsRuntimeResponse = z.infer<typeof WindowsRuntimeResponseSchema>;
