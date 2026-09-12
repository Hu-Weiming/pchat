import { EventCursorSchema, type HarnessEvent } from "@pchat/contracts";
import type { RuntimeStore } from "./ports";

/** Subscribe before reading. Store notifications wake readers; the journal is
 * authoritative even when an event was committed before subscription existed. */
export function eventStream(store: RuntimeStore, after = 0): AsyncIterable<HarnessEvent> {
  const initial = EventCursorSchema.parse(after);
  return {
    [Symbol.asyncIterator]() {
      let cursor = initial;
      let closed = false;
      let wake: (() => void) | undefined;
      let changed = false;
      const unsubscribe = store.subscribe(() => { changed = true; wake?.() });
      let serial = Promise.resolve();
      const take = async (): Promise<IteratorResult<HarnessEvent>> => {
        while (!closed) {
          changed = false;
          const event = await store.read((state) => state.events.find((item) => item.seq > cursor));
          if (closed) break;
          if (event) { cursor = event.seq; return { done: false, value: event } }
          if (!changed) await new Promise<void>((resolve) => { wake = resolve; if (changed || closed) resolve() });
          wake = undefined;
        }
        return { done: true, value: undefined };
      };
      return {
        next() { const result = serial.then(take); serial = result.then(() => undefined, () => undefined); return result },
        async return() { closed = true; unsubscribe(); wake?.(); return { done: true as const, value: undefined } },
      };
    },
  };
}
