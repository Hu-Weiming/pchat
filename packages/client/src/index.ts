import { HARNESS_PROTOCOL_VERSION, ClientEventSchema, ClientRequestSchema, ClientResponseSchema, CommandReceiptSchema, EventCursorSchema, QueryResultSchemas, type ClientRequest, type CommandReceipt, type HarnessCommand, type HarnessEvent, type QueryMap, type QueryResult } from "@pchat/contracts";
import { ClientError } from "./errors";
import { mapStream } from "./stream";
export { ClientError } from "./errors";
export type { ClientRequest } from "@pchat/contracts";

export interface PchatClient {
  dispatch(command: HarnessCommand): Promise<CommandReceipt>;
  query<K extends keyof QueryMap>(query: QueryMap[K]["request"] & { type: K }): Promise<QueryResult<QueryMap[K]["response"]>>;
  events(after?: number): AsyncIterable<HarnessEvent>;
}
export interface ClientTransport {
  request(request: ClientRequest): Promise<unknown>;
  events(after: number): AsyncIterable<unknown>;
}
export function createClient(dependencies: { transport: ClientTransport; ids: { next(): string } }): PchatClient {
  const { transport, ids } = dependencies;
  const responseResult = async (request: ClientRequest) => {
    const input = ClientRequestSchema.safeParse(request);
    if (!input.success) throw new ClientError("INVALID_INPUT");
    let received: unknown;
    try { received = await transport.request(input.data); }
    catch { throw new ClientError("UNAVAILABLE"); }
    const response = ClientResponseSchema.safeParse(received);
    if (!response.success || response.data.requestId !== request.requestId) throw new ClientError("PROTOCOL_ERROR");
    return response.data.result;
  };
  return {
    async dispatch(command) {
      const commandId = command.commandId;
      const result = CommandReceiptSchema.safeParse(await responseResult({ protocolVersion: HARNESS_PROTOCOL_VERSION, requestId: ids.next(), type: "command", command }));
      if (!result.success || result.data.commandId !== commandId) throw new ClientError("PROTOCOL_ERROR");
      return result.data;
    },
    async query<K extends keyof QueryMap>(query: QueryMap[K]["request"] & { type: K }): Promise<QueryResult<QueryMap[K]["response"]>> {
      const queryType = query.type;
      const received = await responseResult({ protocolVersion: HARNESS_PROTOCOL_VERSION, requestId: ids.next(), type: "query", query });
      const result = QueryResultSchemas[queryType].safeParse(received);
      if (!result.success) throw new ClientError("PROTOCOL_ERROR");
      return result.data as QueryResult<QueryMap[K]["response"]>;
    },
    events(after = 0) {
      if (!EventCursorSchema.safeParse(after).success) throw new ClientError("INVALID_INPUT");
      return { [Symbol.asyncIterator]() {
        let cursor = after;
        return mapStream(() => transport.events(after), (input) => {
          const envelope = ClientEventSchema.safeParse(input);
          if (!envelope.success || envelope.data.event.seq !== cursor + 1) throw new ClientError("PROTOCOL_ERROR");
          cursor = envelope.data.event.seq;
          return envelope.data.event;
        })[Symbol.asyncIterator]();
      } };
    },
  };
}

/** Structural input keeps the client independent of the Harness implementation. */
export function inProcessTransport(harness: PchatClient): ClientTransport {
  return {
    async request(input) {
      const parsed = ClientRequestSchema.safeParse(input);
      if (!parsed.success) throw new ClientError("INVALID_INPUT");
      const request = parsed.data;
      return { protocolVersion: HARNESS_PROTOCOL_VERSION, requestId: request.requestId, result: request.type === "command" ? await harness.dispatch(request.command) : await harness.query(request.query) };
    },
    events(after) {
      return mapStream(() => harness.events(after), (event) => ({ protocolVersion: HARNESS_PROTOCOL_VERSION, event }));
    },
  };
}
