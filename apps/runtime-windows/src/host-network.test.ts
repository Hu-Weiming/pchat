import { expect, it } from "vitest";
import { createHostNetwork } from "./host-network";

it("decodes split UTF-8 bytes through the private network RPC without moving credentials into Runtime", async () => {
  const sent: Record<string, unknown>[] = [];
  const encoded = Buffer.from("自由");
  let read = 0;
  const network = createHostNetwork(async (raw) => {
    const request = raw as Record<string, unknown>;
    sent.push(request);
    const result = request.method === "network.open" ? { streamId: "stream", status: 200 } : request.method === "network.read"
      ? read++ === 0 ? { done: false, bytes: [...encoded.subarray(0, 2)] } : read === 2 ? { done: false, bytes: [...encoded.subarray(2)] } : { done: true }
      : { closed: true };
    network.receive({ kind: "host.response", protocolVersion: 2, requestId: request.requestId, ok: true, result });
  });
  try {
    const response = await network.port.request({ connectionId: "connection", attemptId: "attempt", operation: "deepseek.chat", body: { model: "configured-model" } }, { cancelled: false, subscribe: () => () => {} });
    if (!response.ok) throw new Error("RPC failed");
    let text = "";
    for await (const part of response.body) text += part;
    expect(text).toBe("自由");
    expect(sent[0]).toMatchObject({ method: "network.open", params: { connectionId: "connection", attemptId: "attempt" } });
    expect(JSON.stringify(sent)).not.toMatch(/authorization|apiKey|bearer/i);
  } finally { network.close(); }
});
