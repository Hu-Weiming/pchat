import { z } from "zod";

export * from "./harness";
export * from "./client";

export const PCHAT_PROTOCOL_VERSION = 1 as const;

export const RuntimeMethodSchema = z.enum([
  "ping",
  "sqliteProbe",
  "streamProbe",
  "providerPolicyProbe",
  "shutdown",
]);

export const RuntimeRequestSchema = z.object({
  protocolVersion: z.literal(PCHAT_PROTOCOL_VERSION),
  requestId: z.string().min(1),
  method: RuntimeMethodSchema,
  params: z.record(z.string(), z.unknown()).optional(),
});

export type RuntimeRequest = z.infer<typeof RuntimeRequestSchema>;

export const RuntimeReadyMessageSchema = z.object({
  kind: z.literal("runtime.ready"),
  protocolVersion: z.literal(PCHAT_PROTOCOL_VERSION),
  pid: z.number().int().positive(),
  runtimeVersion: z.string(),
});

export const RuntimeResponseMessageSchema = z.object({
  kind: z.literal("runtime.response"),
  protocolVersion: z.literal(PCHAT_PROTOCOL_VERSION),
  requestId: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export const RuntimeEventMessageSchema = z.object({
  kind: z.literal("runtime.event"),
  protocolVersion: z.literal(PCHAT_PROTOCOL_VERSION),
  event: z.string().min(1),
  payload: z.unknown(),
});

export const HostRequestMessageSchema = z.object({
  kind: z.literal("host.request"),
  protocolVersion: z.literal(PCHAT_PROTOCOL_VERSION),
  requestId: z.string().min(1),
  method: z.literal("provider.send"),
  params: z.record(z.string(), z.unknown()),
});

export const HostResponseMessageSchema = z.object({
  kind: z.literal("host.response"),
  protocolVersion: z.literal(PCHAT_PROTOCOL_VERSION),
  requestId: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export const RuntimeWireMessageSchema = z.discriminatedUnion("kind", [
  RuntimeReadyMessageSchema,
  RuntimeResponseMessageSchema,
  RuntimeEventMessageSchema,
  HostRequestMessageSchema,
]);

export type RuntimeWireMessage = z.infer<typeof RuntimeWireMessageSchema>;
export type HostResponseMessage = z.infer<typeof HostResponseMessageSchema>;

export interface RuntimeStatus {
  state: "starting" | "running" | "stopped" | "failed";
  pid?: number;
  generation: number;
  protocolVersion: number;
  lastError?: string;
}
