import type { RuntimeState, RuntimeStore } from "@pchat/harness";
import { clone } from "./clone";

export class InMemoryStore implements RuntimeStore {
  private readonly listeners = new Set<() => void>();
  private state: RuntimeState = {
    epoch: 0, suspended: false, lastEventSeq: 0,
    conversations: [], turns: [], commands: [], events: [],
  };

  async read<T>(reader: (snapshot: Readonly<RuntimeState>) => T): Promise<T> {
    return clone(reader(clone(this.state)));
  }

  async transaction<T>(writer: (draft: RuntimeState) => T): Promise<T> {
    const draft = clone(this.state);
    const result = writer(draft);
    if (result && typeof result === "object" && "then" in result && typeof result.then === "function") {
      void Promise.resolve(result).catch(() => {});
      throw new Error("RuntimeStore transaction callbacks must be synchronous.");
    }
    const isolatedResult = clone(result);
    this.state = clone(draft);
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* Notifications cannot roll back a commit. */ }
    }
    return isolatedResult;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
