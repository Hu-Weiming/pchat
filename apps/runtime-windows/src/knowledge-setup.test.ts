import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { expect, it } from "vitest";
import { createKnowledgeSetup } from "./knowledge-setup";
import { configuredPorts } from "./configuration";
import { openWindowsRuntime } from "./bootstrap";
import type { SecureNetworkPort } from "@pchat/providers";

it("collects a draft then enables a reviewed role through persisted runtime configuration", async () => {
  const root = process.env.PCHAT_DEV_ROOT;
  if (!root || !isAbsolute(root)) throw new Error("Development root required");
  const parent = join(root, "temp", "pchat");
  const directory = mkdtempSync(join(parent, "knowledge-setup-"));
  const chunk = { id: "chunk", type: "RAW", knowledgeBaseId: "kb", documentId: "doc", enabled: true, status: "indexed", updateTime: 100 };
  const page = (data: unknown[]) => ({ requestId: "page", data, nextMarker: "", isTruncated: false });
  const network: SecureNetworkPort = { async request(request) { return { ok: true, status: 200, body: (async function* () { yield JSON.stringify(request.operation === "qianfan.documents" ? page([{ documentId: "doc", name: "Uploaded.txt", status: "available" }]) : request.operation === "qianfan.chunks" ? page([chunk]) : { ...chunk, requestId: "detail", content: "An actual captured passage.", row_line: [], imageUrls: [] }); })() }; } };
  const setup = createKnowledgeSetup(directory, network);
  let runtime: Awaited<ReturnType<typeof openWindowsRuntime>> | undefined;
  try {
    writeFileSync(join(directory, "configuration.json"), JSON.stringify({ version: 1, connections: [{ id: "qianfan-personal", provider: "qianfan", revision: "connection-v1" }], models: [], roles: [], retrieval: [], maxCostUnits: 100 }));
    const draft = await setup.handle({ protocolVersion: 2, requestId: "collect", method: "configuration.collect", params: { knowledgebaseId: "kb" } });
    expect(draft).toMatchObject({ ok: true, result: { documents: [{ documentId: "doc", chunkCount: 1 }] } });
    if (!("result" in draft) || !("collectionId" in draft.result)) throw new Error("Missing draft");
    expect(JSON.parse(readFileSync(join(directory, "configuration.json"), "utf8")).roles).toEqual([]);
    expect(await setup.handle({ protocolVersion: 2, requestId: "confirm", method: "configuration.confirm", params: { collectionId: draft.result.collectionId, label: "Reviewed thought stage", documents: [{ documentId: "doc", kind: "PRIMARY", workTitle: "Reviewed work", edition: null, translator: null }] } })).toMatchObject({ ok: true, result: { confirmed: true } });
    runtime = await openWindowsRuntime({ stateDirectory: directory, dependencies: configuredPorts(directory, network) });
    expect(await runtime.harness.query({ type: "ListRoles" })).toMatchObject({ ok: true, data: [{ label: "Reviewed thought stage", status: "CONFIRMED" }] });
    expect(JSON.parse(readFileSync(join(directory, "configuration.json"), "utf8")).retrieval[0].documents[0].chunks[0]).toMatchObject({ revisionSource: "DETAIL", expectedUpdateTime: 100 });
  } finally {
    setup.close(); await runtime?.close();
    const target = resolve(directory), within = relative(resolve(parent), target);
    if (!within || within.startsWith("..") || isAbsolute(within)) throw new Error("Unsafe cleanup");
    rmSync(target, { recursive: true, force: true });
  }
});
