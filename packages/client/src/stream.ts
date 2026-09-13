import { ClientError } from "./errors";

/** Close must be able to interrupt next(); an async generator alone queues
 * return() behind the pending read and can leave a UI subscription attached. */
export function mapStream<T, U>(source: () => AsyncIterable<T>, project: (value: T) => U): AsyncIterable<U> {
  return {
    [Symbol.asyncIterator]() {
      const done: IteratorReturnResult<undefined> = { done: true, value: undefined };
      let iterator: AsyncIterator<T> | undefined;
      let closed = false;
      let signalClose = () => {};
      const cancellation = new Promise<IteratorReturnResult<undefined>>((resolve) => { signalClose = () => resolve(done); });
      let pending = Promise.resolve();
      const close = () => {
        if (!closed) {
          closed = true;
          signalClose();
          try { void Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* Cleanup never exposes transport errors. */ }
        }
        return done;
      };
      return {
        next(): Promise<IteratorResult<U>> {
          const result = pending.then(async (): Promise<IteratorResult<U>> => {
            if (closed) return done;
            try {
              iterator ??= source()[Symbol.asyncIterator]();
              const item = await Promise.race([iterator.next(), cancellation]);
              if (closed || item.done) return close();
              return { done: false, value: project(item.value) };
            } catch (error) {
              close();
              throw error instanceof ClientError ? error : new ClientError("UNAVAILABLE");
            }
          });
          pending = result.then(() => {}, () => {});
          return result;
        },
        async return() { return close(); },
        async throw() { close(); throw new ClientError("UNAVAILABLE"); },
      };
    },
  };
}
