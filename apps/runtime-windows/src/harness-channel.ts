import { ClientEventSchema, WINDOWS_PROTOCOL_VERSION, WindowsRequestIdSchema, WindowsRuntimeRequestSchema, type WindowsRuntimeEvent, type WindowsRuntimeResponse } from "@pchat/contracts";
import { inProcessTransport, type PchatClient } from "@pchat/client";

export function createHarnessChannel(harness: PchatClient, emit: (event: WindowsRuntimeEvent) => Promise<void>) {
  const transport = inProcessTransport(harness);
  let closed = false;
  const subscriptions = new Map<string, { after: number; iterator: AsyncIterator<unknown>; stopped: boolean }>();
  const stop = (id: string) => {
    const subscription = subscriptions.get(id);
    if (!subscription) return;
    subscription.stopped = true;
    subscriptions.delete(id);
    try { void Promise.resolve(subscription.iterator.return?.()).catch(() => {}); } catch { /* Cleanup is best effort. */ }
  };
  const pump = async (id: string, subscription: NonNullable<ReturnType<typeof subscriptions.get>>) => {
    try {
      while (!closed && !subscription.stopped) {
        const item = await subscription.iterator.next();
        if (closed || subscription.stopped) return;
        if (item.done) throw new Error("Event stream closed");
        await emit({ kind: "runtime.event", protocolVersion: WINDOWS_PROTOCOL_VERSION, event: "harness", payload: { subscriptionId: id, envelope: ClientEventSchema.parse(item.value) } });
      }
    } catch {
      if (!closed && !subscription.stopped) {
        try { await emit({ kind: "runtime.event", protocolVersion: WINDOWS_PROTOCOL_VERSION, event: "harness.closed", payload: { subscriptionId: id, error: "REFRESH_REQUIRED" } }); } catch { /* The host connection is unavailable. */ }
      }
    } finally { if (subscriptions.get(id) === subscription) stop(id); }
  };
  return {
    async handle(input: unknown): Promise<WindowsRuntimeResponse> {
      const candidate = input && typeof input === "object" && "requestId" in input ? WindowsRequestIdSchema.safeParse(input.requestId) : null;
      const requestId = candidate?.success ? candidate.data : "invalid-request";
      const base = { kind: "runtime.response", protocolVersion: WINDOWS_PROTOCOL_VERSION, requestId } as const;
      const parsed = WindowsRuntimeRequestSchema.safeParse(input);
      if (!parsed.success) return { ...base, ok: false, error: "INVALID_REQUEST" };
      if (closed) return { ...base, ok: false, error: "RUNTIME_UNAVAILABLE" };
      try {
        const request = parsed.data;
        if (request.method === "harness.request") return { ...base, ok: true, result: await transport.request(request.params) };
        const { subscriptionId } = request.params;
        if (request.method === "harness.unsubscribe") {
          stop(subscriptionId);
          return { ...base, ok: true, result: { unsubscribed: true } };
        }
        const existing = subscriptions.get(subscriptionId);
        if (existing && existing.after !== request.params.after) return { ...base, ok: false, error: "INVALID_REQUEST" };
        if (!existing) {
          if (subscriptions.size >= 32) return { ...base, ok: false, error: "RUNTIME_UNAVAILABLE" };
          const subscription = { after: request.params.after, iterator: transport.events(request.params.after)[Symbol.asyncIterator](), stopped: false };
          subscriptions.set(subscriptionId, subscription);
          void pump(subscriptionId, subscription);
        }
        return { ...base, ok: true, result: { subscribed: true } };
      }
      catch { return { ...base, ok: false, error: "RUNTIME_UNAVAILABLE" }; }
    },
    async close() { closed = true; for (const id of subscriptions.keys()) stop(id); },
  };
}
