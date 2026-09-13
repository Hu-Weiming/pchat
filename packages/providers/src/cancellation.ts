import type { Cancellation } from "@pchat/harness";

/** Fences a misbehaving transport while the Host performs physical cancellation. */
export class CancellationScope {
  private reject!: (reason: Error) => void;
  private readonly interrupted = new Promise<never>((_resolve, reject) => { this.reject = reject; });
  private readonly unsubscribe: () => void;
  constructor(private readonly token: Cancellation) {
    // An idle generator may have no pending race when cancellation arrives.
    void this.interrupted.catch(() => {});
    this.unsubscribe = token.subscribe(() => this.reject(new Error("Cancelled")));
  }
  check() { if (this.token.cancelled) throw new Error("Cancelled"); }
  async wait<T>(pending: Promise<T>): Promise<T> {
    this.check();
    const value = await Promise.race([pending, this.interrupted]);
    this.check();
    return value;
  }
  close() { this.unsubscribe(); }
}

export function closeStream(iterator: AsyncIterator<string> | undefined) {
  try { void Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* Cleanup cannot expose transport errors. */ }
}
