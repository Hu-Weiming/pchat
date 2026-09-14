import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import type { SecureNetworkPort } from "@pchat/providers";

export function createHostNetwork(send: (message: unknown) => Promise<void>) {
  let active = true;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const call = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (!active) { reject(new Error("OUTCOME_UNKNOWN")); return; }
    const requestId = randomUUID();
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("OUTCOME_UNKNOWN")); }, 185_000);
    pending.set(requestId, { resolve, reject, timer });
    void send({ kind: "host.request", protocolVersion: 2, requestId, method, params }).catch(() => {
      clearTimeout(timer); pending.delete(requestId); reject(new Error("OUTCOME_UNKNOWN"));
    });
  });
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const port: SecureNetworkPort = { async request(request, cancellation) {
    if (cancellation.cancelled) return { ok: false, code: "REJECTED" };
    let streamId: string | undefined;
    let closed = false;
    let signal = () => {};
    const cancelled = new Promise<never>((_, reject) => { signal = () => reject(new Error("OUTCOME_UNKNOWN")); });
    void cancelled.catch(() => {});
    const detach = cancellation.subscribe(() => { signal(); void call("network.cancel", { attemptId: request.attemptId }).catch(() => {}); });
    const close = () => { if (closed) return; closed = true; detach(); if (streamId) void call("network.close", { streamId }).catch(() => {}); };
    try {
      const opening = call("network.open", request).then((response) => {
        if (!object(response) || typeof response.streamId !== "string" || !Number.isInteger(response.status)) throw new Error("OUTCOME_UNKNOWN");
        streamId = response.streamId;
        if (closed) void call("network.close", { streamId }).catch(() => {});
        return response;
      });
      const response = await Promise.race([opening, cancelled]);
      return { ok: true, status: response.status as number, body: { async *[Symbol.asyncIterator]() {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        try {
          while (!closed) {
            const item = await Promise.race([call("network.read", { streamId }), cancelled]);
            if (!object(item) || typeof item.done !== "boolean") throw new Error("OUTCOME_UNKNOWN");
            if (item.done) { const tail = decoder.decode(); if (tail) yield tail; return; }
            if (!Array.isArray(item.bytes) || item.bytes.length > 65536 || !item.bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error("OUTCOME_UNKNOWN");
            const text = decoder.decode(new Uint8Array(item.bytes), { stream: true });
            if (text) yield text;
          }
        } finally { close(); }
      } } };
    } catch (error) { close(); return { ok: false, code: error instanceof Error && error.message === "REJECTED" ? "REJECTED" : "OUTCOME_UNKNOWN" }; }
  } };
  return {
    port,
    receive(message: unknown) {
      if (!object(message) || message.kind !== "host.response") return false;
      if (message.protocolVersion !== 2 || typeof message.requestId !== "string") return true;
      const entry = pending.get(message.requestId);
      if (!entry) return true;
      pending.delete(message.requestId); clearTimeout(entry.timer);
      if (message.ok === true) entry.resolve(message.result);
      else entry.reject(new Error(message.error === "REJECTED" ? "REJECTED" : "OUTCOME_UNKNOWN"));
      return true;
    },
    close() { active = false; for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("OUTCOME_UNKNOWN")); } pending.clear(); },
  };
}
