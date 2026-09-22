import type { Cancellation, ProviderFailure } from "@pchat/harness";
import { CancellationScope, closeStream } from "./cancellation";
import type { SecureNetworkPort, SecureNetworkRequest } from "./network";

export class CollectionFailure extends Error {
  constructor(readonly code: ProviderFailure["code"]) { super("Collection failed"); }
}
export function requireCollection(condition: unknown): asserts condition {
  if (!condition) throw new CollectionFailure("REJECTED");
}
export const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const nonblank = (value: unknown, maximum = 200): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
export const rawTime = (value: unknown): value is string | number => nonblank(value) || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

/** A complete response is consumed before interpreting its status. This also
 * limits discarded error bodies and fences resources arriving after cancel. */
export async function readCollectionObject(network: SecureNetworkPort, request: SecureNetworkRequest, cancellation: Cancellation, scope: CancellationScope, maximum: number, requestIdField = "requestId"): Promise<Record<string, unknown>> {
  let stream: AsyncIterator<string> | undefined;
  let closed = false;
  const release = () => { closeStream(stream); stream = undefined; };
  try {
    scope.check();
    const pending = network.request(request, cancellation).then((response) => {
      if (response.ok) {
        stream = response.body[Symbol.asyncIterator]();
        if (closed || cancellation.cancelled) release();
      }
      return response;
    });
    void pending.catch(() => {});
    const response = await scope.wait(pending);
    if (!response.ok) throw new CollectionFailure(response.code === "REJECTED" ? "REJECTED" : "OUTCOME_UNKNOWN");
    if (!stream) throw new Error("Missing stream");
    let body = "";
    let count = 0;
    while (true) {
      const next = await scope.wait(stream.next());
      if (next.done) break;
      count += next.value.length;
      if (count > maximum) throw new Error("Response limit");
      if (response.status === 200) body += next.value;
    }
    if (response.status !== 200) throw new CollectionFailure(Number.isInteger(response.status) && response.status >= 400 && response.status < 500 ? "REJECTED" : "OUTCOME_UNKNOWN");
    const value: unknown = JSON.parse(body);
    requireCollection(object(value) && nonblank(value[requestIdField]) && !("code" in value) && !("error" in value));
    return value;
  } finally {
    closed = true;
    release();
  }
}
