import type { Readable, Writable } from "node:stream";
import { TextDecoder } from "node:util";
import type { PchatClient } from "@pchat/client";
import { WINDOWS_PROTOCOL_VERSION, WindowsShutdownRequestSchema } from "@pchat/contracts";
import { createHarnessChannel } from "./harness-channel";
import type { createKnowledgeSetup } from "./knowledge-setup";

type SessionReason = "SHUTDOWN" | "INPUT_CLOSED" | "INVALID_FRAME" | "IO_ERROR";
export interface RuntimeSessionOptions { harness: PchatClient; input: Readable; output: Writable; nextId(): string; host?: { receive(message: unknown): boolean; close(): void }; setup?: ReturnType<typeof createKnowledgeSetup> }

/** Private NDJSON over inherited pipes. No ports or provider credentials. */
export async function runRuntimeSession({ harness, input, output, nextId, host, setup }: RuntimeSessionOptions): Promise<{ reason: SessionReason; suspended: boolean }> {
  let writes = Promise.resolve();
  const emit = (message: unknown) => {
    const line = JSON.stringify(message) + "\n";
    const result = writes.then(() => new Promise<void>((resolve, reject) => {
      output.write(line, (error) => error ? reject(error) : resolve());
    }));
    writes = result.catch(() => {});
    return result;
  };
  const channel = createHarnessChannel(harness, emit);
  const pending = new Set<Promise<void>>();
  let stopping = false;
  let frame = Buffer.alloc(0);
  let finish!: (result: { reason: SessionReason; suspended: boolean }) => void;
  const completed = new Promise<{ reason: SessionReason; suspended: boolean }>((resolve) => { finish = resolve; });
  const stop = (reason: SessionReason, requestId?: string) => {
    if (stopping) return;
    stopping = true;
    setup?.close();
    input.pause();
    input.off("data", receive);
    void (async () => {
      let suspended = false;
      try {
        const receipt = await harness.dispatch({ type: "SuspendRuntime", commandId: nextId() });
        suspended = receipt.ok;
      } catch { /* Host treats an unconfirmed shutdown as failed. */ }
      await channel.close();
      host?.close();
      await Promise.allSettled(pending);
      if (requestId) {
        try {
          await emit(suspended
            ? { kind: "runtime.response", protocolVersion: WINDOWS_PROTOCOL_VERSION, requestId, ok: true, result: { suspended: true } }
            : { kind: "runtime.response", protocolVersion: WINDOWS_PROTOCOL_VERSION, requestId, ok: false, error: "RUNTIME_UNAVAILABLE" });
        } catch { reason = "IO_ERROR"; }
      }
      await writes;
      input.off("end", ended);
      input.off("error", failed);
      output.off("error", failed);
      finish({ reason, suspended });
    })();
  };
  const failed = () => stop("IO_ERROR");
  const ended = () => stop(frame.length ? "INVALID_FRAME" : "INPUT_CLOSED");
  const receive = (chunk: Buffer | string) => {
    if (stopping) return;
    frame = Buffer.concat([frame, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let newline: number;
    while (!stopping && (newline = frame.indexOf(10)) >= 0) {
      if (newline > 1_048_576) { stop("INVALID_FRAME"); return; }
      const line = frame.subarray(0, newline);
      frame = frame.subarray(newline + 1);
      let message: unknown;
      try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); }
      catch { stop("INVALID_FRAME"); return; }
      if (host?.receive(message)) continue;
      const shutdown = WindowsShutdownRequestSchema.safeParse(message);
      if (shutdown.success) { stop("SHUTDOWN", shutdown.data.requestId); return; }
      if (pending.size >= 64) { stop("INVALID_FRAME"); return; }
      const work = (setup?.accepts(message) ? setup.handle(message) : channel.handle(message)).then(emit).catch(() => { stop("IO_ERROR"); });
      pending.add(work);
      void work.finally(() => { pending.delete(work); });
    }
    if (frame.length > 1_048_576) stop("INVALID_FRAME");
  };
  output.on("error", failed);
  input.on("error", failed);
  try { await emit({ kind: "runtime.ready", protocolVersion: WINDOWS_PROTOCOL_VERSION, runtimeVersion: "0.1.1", pid: process.pid }); }
  catch { stop("IO_ERROR"); }
  if (!stopping) {
    input.on("end", ended);
    input.on("data", receive);
    if (input.readableEnded) ended();
  }
  return completed;
}
