import type { Cancellation, ProviderFailure } from "@pchat/harness";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue }
export interface SecureNetworkRequest {
  connectionId: string;
  /** Correlation and cancellation only; never promises supplier idempotency. */
  attemptId: string;
  operation: "deepseek.chat" | "qianfan.search";
  body: JsonObject;
}
export type SecureNetworkResponse =
  | { ok: true; status: number; body: AsyncIterable<string> }
  | ProviderFailure;

/** Host owns fixed endpoints, header/credential injection, strict operation-body
 * validation, streaming UTF-8 decoding, total/idle timeouts and byte limits.
 * body yields decoded fragments, not necessarily lines or complete events.
 * Cancellation must abort the transport and settle pending reads. The adapter
 * also fences late results. No redirects, arbitrary URLs, headers or keys cross
 * this port. Errors before proven delivery may be REJECTED; ambiguity is UNKNOWN. */
export interface SecureNetworkPort {
  request(request: SecureNetworkRequest, cancellation: Cancellation): Promise<SecureNetworkResponse>;
}
