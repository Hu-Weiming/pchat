const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export interface DeepSeekFrame { content: string; finishReason: string | null }

/** Metadata is ignored; only one assistant choice, text and a known terminal
 * reason are admitted. No tool call or provider reasoning crosses ModelPort. */
export function parseDeepSeekFrame(data: string): DeepSeekFrame | null {
  const parsed: unknown = JSON.parse(data);
  if (!record(parsed) || "error" in parsed || !Array.isArray(parsed.choices)) throw new Error("Invalid provider frame");
  // Some compatible API versions emit a final usage-only frame.
  if (parsed.choices.length === 0 && record(parsed.usage)) return null;
  if (parsed.choices.length !== 1) throw new Error("Invalid choices");
  const choice: unknown = parsed.choices[0];
  if (!record(choice) || choice.index !== 0 || !record(choice.delta)) throw new Error("Invalid choice");
  const delta = choice.delta;
  if ((delta.role !== undefined && delta.role !== "assistant") || (delta.tool_calls !== undefined && delta.tool_calls !== null)) throw new Error("Unexpected capability");
  if (delta.content !== undefined && delta.content !== null && typeof delta.content !== "string") throw new Error("Invalid content");
  const finishReason = choice.finish_reason;
  if (finishReason !== null && (typeof finishReason !== "string" || !["stop", "length", "content_filter", "tool_calls", "insufficient_system_resource", "aborted"].includes(finishReason))) throw new Error("Invalid finish reason");
  return { content: typeof delta.content === "string" ? delta.content : "", finishReason };
}
