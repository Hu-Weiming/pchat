import { ClientError, type ClientTransport } from "@pchat/client";
import { WINDOWS_PROTOCOL_VERSION, WindowsRuntimeEventSchema, WindowsRuntimeResponseSchema } from "@pchat/contracts";

/** The only platform surface needed by the desktop client. */
export interface WindowsBridge {
  request(input: unknown): Promise<unknown>;
  listen(handler: (event: unknown) => void): Promise<() => void>;
}

export function createWindowsTransport(bridge: WindowsBridge, ids: { next(): string }): ClientTransport {
  const request = async (method: string, params: unknown) => {
    const requestId = ids.next();
    let received: unknown;
    try { received = await bridge.request({ protocolVersion: WINDOWS_PROTOCOL_VERSION, requestId, method, params }); }
    catch { throw new ClientError("UNAVAILABLE"); }
    const parsed = WindowsRuntimeResponseSchema.safeParse(received);
    if (!parsed.success || parsed.data.requestId !== requestId) throw new ClientError("PROTOCOL_ERROR");
    if (!parsed.data.ok) throw new ClientError("UNAVAILABLE");
    return parsed.data.result;
  };
  return {
    request: (input) => request("harness.request", input),
    events(after) {
      return { [Symbol.asyncIterator]() {
        const subscriptionId = ids.next();
        const done: IteratorReturnResult<undefined> = { done: true, value: undefined };
        const queued: unknown[] = [];
        const readers: { resolve(item: IteratorResult<unknown>): void; reject(error: ClientError): void }[] = [];
        let started = false;
        let closed = false;
        let error: ClientError | null = null;
        let unlisten: (() => void) | undefined;
        let subscribed = false;
        let unsubscribing = false;
        const cleanup = () => {
          const dispose = unlisten;
          unlisten = undefined;
          try { dispose?.(); } catch { /* Do not expose native errors. */ }
          if (subscribed && !unsubscribing) {
            unsubscribing = true;
            void request("harness.unsubscribe", { subscriptionId }).catch(() => {});
          }
        };
        const close = (failure?: ClientError) => {
          if (!closed) {
            closed = true;
            error = failure ?? null;
            queued.length = 0;
            for (const reader of readers.splice(0)) failure ? reader.reject(failure) : reader.resolve(done);
          }
          cleanup();
          return done;
        };
        const receive = (input: unknown) => {
          if (closed) return;
          const event = WindowsRuntimeEventSchema.safeParse(input);
          if (!event.success) { close(new ClientError("PROTOCOL_ERROR")); return; }
          if (event.data.payload.subscriptionId !== subscriptionId) return;
          if (event.data.event === "harness.closed") { close(new ClientError("UNAVAILABLE")); return; }
          const reader = readers.shift();
          if (reader) reader.resolve({ done: false, value: event.data.payload.envelope });
          else if (queued.length >= 1024) close(new ClientError("UNAVAILABLE"));
          else queued.push(event.data.payload.envelope);
        };
        const start = async () => {
          try {
            unlisten = await bridge.listen(receive);
            if (closed) { cleanup(); return; }
            let acknowledgment: unknown;
            try { acknowledgment = await request("harness.subscribe", { subscriptionId, after }); }
            finally { subscribed = true; }
            if (!acknowledgment || typeof acknowledgment !== "object" || !("subscribed" in acknowledgment) || acknowledgment.subscribed !== true || Object.keys(acknowledgment).length !== 1) throw new ClientError("PROTOCOL_ERROR");
            if (closed) cleanup();
          } catch { close(new ClientError("UNAVAILABLE")); }
        };
        return {
          next(): Promise<IteratorResult<unknown>> {
            if (error) return Promise.reject(error);
            if (closed) return Promise.resolve(done);
            if (queued.length) return Promise.resolve({ done: false, value: queued.shift() });
            const result = new Promise<IteratorResult<unknown>>((resolve, reject) => readers.push({ resolve, reject }));
            if (!started) { started = true; void start(); }
            return result;
          },
          async return() { return close(); },
        };
      } };
    },
  };
}
