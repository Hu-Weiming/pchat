import type { Cancellation } from "./ports";

export class CancellationToken implements Cancellation {
  cancelled = false;
  private listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    if (this.cancelled) { listener(); return () => {} }
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const listener of this.listeners) { try { listener(); } catch { /* Adapter cancellation is best effort. */ } }
    this.listeners.clear();
  }
}
