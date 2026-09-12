import { EventCursorSchema, type HarnessEvent } from "@pchat/contracts";
import type { RuntimeStore } from "./ports";

/** Subscribe before reading. Store notifications wake readers; the journal is
 * authoritative even when an event was committed before subscription existed.
 * A future cursor rejects the first next() with RangeError; query a fresh
 * projection and subscribe again instead of skipping unobserved changes. */
export function eventStream(store: RuntimeStore, after = 0): AsyncIterable<HarnessEvent> {
  const initial = EventCursorSchema.parse(after);
  return {
    [Symbol.asyncIterator]() {
      let cursor = initial;
      let closed = false;
      let wake: (() => void) | undefined;
      let changed = false;
      let cancelRead: (() => void) | undefined;
      const unsubscribe = store.subscribe(() => { changed = true; wake?.() });
      const close = () => {
        if (closed) return;
        closed = true;
        cancelRead?.();
        cancelRead = undefined;
        unsubscribe();
        wake?.();
        wake = undefined;
      };
      let serial = Promise.resolve();
      const take = async (): Promise<IteratorResult<HarnessEvent>> => {
        while (!closed) {
          changed = false;
          // Each read owns its cancellation promise. A long-lived shared
          // promise would retain a race callback for every delivered event.
          const readCancelled = new Promise<void>((resolve) => { cancelRead = resolve; });
          const event = await Promise.race([
            store.read((state) => {
              if (cursor > state.lastEventSeq) {
                throw new RangeError("Event cursor is ahead of the committed journal; query a fresh projection.");
              }
              return state.events.find((item) => item.seq > cursor);
            }),
            readCancelled,
          ]);
          cancelRead = undefined;
          if (closed) break;
          if (event) { cursor = event.seq; return { done: false, value: event } }
          if (!changed) await new Promise<void>((resolve) => { wake = resolve; if (changed || closed) resolve() });
          wake = undefined;
        }
        return { done: true, value: undefined };
      };
      return {
        next() {
          const result = serial.then(take).catch((error: unknown) => { close(); throw error; });
          serial = result.then(() => undefined, () => undefined);
          return result;
        },
        async return() {
          close();
          return { done: true as const, value: undefined };
        },
      };
    },
  };
}
