import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import type { SecureNetworkPort, SecureNetworkRequest } from "@pchat/providers";
import { testRole, testSettings } from "../../../packages/testing/src/index";
import { createKnowledgeSetup } from "./knowledge-setup";
import { configuredPorts } from "./configuration";

function fixture(options: { empty?: boolean; unknown?: boolean; onModel?: (path: string) => void } = {}) {
  const parent = join(process.env.PCHAT_DEV_ROOT!, "temp", "pchat");
  const directory = mkdtempSync(join(parent, "description-setup-"));
  const config = { version: 1, maxCostUnits: 100, retrieval: [], roles: [{ ...testRole, retrievalDescription: "原说明" }],
    connections: [{ id: testSettings.model.connectionId, provider: "deepseek", revision: testSettings.model.configRevision }, { id: "qianfan-personal", provider: "qianfan", revision: "v1" }],
    models: [{ binding: testSettings.model, windowTokens: 65536, maxOutputTokens: 4096 }],
    workflowRetrieval: [{ binding: { connectionId: "qianfan-personal", corpusId: testRole.corpusId, corpusRevision: testRole.corpusRevision, retrievalConfigRevision: testRole.retrievalConfigRevision }, appId: "app", group: "group", person: "人物", datasetId: "dataset", maxEvidenceChars: 7000, maxPassages: 6 }],
  };
  const path = join(directory, "configuration.json");
  writeFileSync(path, JSON.stringify(config));
  const calls: SecureNetworkRequest[] = [];
  const network: SecureNetworkPort = { request: async (request) => {
    calls.push(request);
    if (request.operation === "deepseek.chat") {
      options.onModel?.(path);
      if (options.unknown) return { ok: false, code: "OUTCOME_UNKNOWN" };
      const content = JSON.stringify({ description: "抽样文本涉及欲望满足后的无聊与消遣，可查找闲下来为何难受等问题的相关讨论。" });
      return { ok: true, status: 200, body: (async function* () { yield `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`; })() };
    }
    const code = JSON.stringify({ output: options.empty ? [] : [{ dataset_id: "dataset", document_id: "doc", segment_id: "seg", document_name: "实际作品", content: "欲望满足以后，人也可能感到无聊，而不断寻求消遣。", score: 0.8 }] });
    const body = request.operation === "qianfan.conversation" ? { request_id: "request", conversation_id: "conversation" }
      : { request_id: "request", conversation_id: "conversation", answer: code, content: [{ event_code: 0, event_type: "chatflow", content_type: "code", event_status: "done", outputs: { code } }, { event_code: 0, event_type: "chatflow", event_status: "success" }] };
    return { ok: true, status: 200, body: (async function* () { yield JSON.stringify(body); })() };
  } };
  const setup = createKnowledgeSetup(directory, network);
  return { directory, path, config, calls, network, setup, request: { protocolVersion: 2, requestId: "description", method: "configuration.collect", params: { action: "GENERATE_DESCRIPTION", roleId: testRole.id, expectedRevision: testRole.revision } },
    close() { setup.close(); const target = resolve(directory), within = relative(resolve(parent), target); if (!within || within.startsWith("..") || isAbsolute(within)) throw new Error("Unsafe cleanup"); rmSync(target, { recursive: true, force: true }); },
  };
}

test("automatically enables a sampled description for an existing workflow role without replacing its binding", async () => {
  const f = fixture();
  try {
    expect(await f.setup.handle(f.request)).toMatchObject({ ok: true, result: { confirmed: true, role: { id: testRole.id, retrievalDescription: expect.stringContaining("不代表全库覆盖") } } });
    const loaded = configuredPorts(f.directory, f.network);
    expect(loaded.roles[0]?.retrievalDescription).toContain("无聊与消遣");
    expect(loaded.roles[0]?.revision).not.toBe(testRole.revision);
    const stored = JSON.parse(readFileSync(f.path, "utf8"));
    expect(stored.workflowRetrieval).toEqual(f.config.workflowRetrieval);
    expect(stored.retrieval).toEqual([]);
    expect(f.calls.map((call) => call.operation)).toEqual(["qianfan.conversation", "qianfan.workflow", "deepseek.chat"]);
    const job = JSON.parse(readFileSync(join(f.directory, "description-jobs", readdirSync(join(f.directory, "description-jobs"))[0]!), "utf8"));
    expect(job).toMatchObject({ status: "SUCCEEDED", corpusRevision: testRole.corpusRevision, evidence: [{ workTitle: "实际作品", text: "欲望满足以后，人也可能感到无聊，而不断寻求消遣。" }] });
    expect(await f.setup.handle(f.request)).toMatchObject({ ok: false });
    expect(f.calls).toHaveLength(3);
  } finally { f.close(); }
});

test.each([{ empty: true }, { unknown: true }])("keeps the original description when source retrieval or generation is unavailable: %j", async (options) => {
  const f = fixture(options);
  try {
    expect(await f.setup.handle(f.request)).toMatchObject({ ok: false });
    expect(JSON.parse(readFileSync(f.path, "utf8"))).toEqual(f.config);
    expect(f.calls.filter((call) => call.operation === "deepseek.chat")).toHaveLength(options.empty ? 0 : 1);
    const job = JSON.parse(readFileSync(join(f.directory, "description-jobs", readdirSync(join(f.directory, "description-jobs"))[0]!), "utf8"));
    expect(job.status).toBe(options.unknown ? "OUTCOME_UNKNOWN" : "FAILED");
  } finally { f.close(); }
});

test("does not overwrite a role whose confirmed revision changes during generation", async () => {
  const f = fixture({ onModel(path) {
    const updated = JSON.parse(readFileSync(path, "utf8"));
    updated.roles[0].revision = "new-revision";
    writeFileSync(path, JSON.stringify(updated));
  } });
  try {
    expect(await f.setup.handle(f.request)).toMatchObject({ ok: false });
    expect(configuredPorts(f.directory, f.network).roles[0]).toMatchObject({ revision: "new-revision", retrievalDescription: "原说明" });
    expect(f.calls).toHaveLength(3);
  } finally { f.close(); }
});

test("preserves other settings changed while the description request is in flight", async () => {
  const f = fixture({ onModel(path) {
    const updated = JSON.parse(readFileSync(path, "utf8"));
    updated.maxCostUnits = 42;
    writeFileSync(path, JSON.stringify(updated));
  } });
  try {
    expect(await f.setup.handle(f.request)).toMatchObject({ ok: true });
    expect(configuredPorts(f.directory, f.network).limits.maxCostUnits).toBe(42);
  } finally { f.close(); }
});

test("rejects zero or exhausted preparation allowance before sending any paid request", async () => {
  const f = fixture();
  try {
    writeFileSync(f.path, JSON.stringify({ ...f.config, maxCostUnits: 0 }));
    expect(await f.setup.handle(f.request)).toMatchObject({ ok: false });
    expect(f.calls).toHaveLength(0);
    writeFileSync(f.path, JSON.stringify({ ...f.config, maxCostUnits: 3 }));
    expect(await f.setup.handle(f.request)).toMatchObject({ ok: true });
    const role = configuredPorts(f.directory, f.network).roles[0]!;
    expect(await f.setup.handle({ ...f.request, params: { ...f.request.params, expectedRevision: role.revision } })).toMatchObject({ ok: false });
    expect(f.calls).toHaveLength(3);
  } finally { f.close(); }
});

test("saves a manual correction without provider calls and refuses an outdated revision", async () => {
  const f = fixture();
  try {
    const input = { action: "SAVE_DESCRIPTION", roleId: testRole.id, expectedRevision: testRole.revision, description: "抽样原文讨论无聊与消遣，不涉及手机使用建议。" };
    expect(await f.setup.handle({ ...f.request, method: "configuration.confirm", params: input })).toMatchObject({ ok: true, result: { role: { retrievalDescription: expect.stringContaining(input.description) } } });
    expect(f.calls).toHaveLength(0);
    expect(await f.setup.handle({ ...f.request, method: "configuration.confirm", params: input })).toMatchObject({ ok: false });
    expect(JSON.parse(readFileSync(f.path, "utf8")).workflowRetrieval).toEqual(f.config.workflowRetrieval);
  } finally { f.close(); }
});

test("cancels a stalled preparation before the host timeout and fences late activation", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let started = false;
  let release!: (value: Awaited<ReturnType<SecureNetworkPort["request"]>>) => void;
  f.network.request = async () => { started = true; return new Promise((resolve) => { release = resolve; }); };
  try {
    const pending = f.setup.handle(f.request);
    for (let i = 0; i < 100 && !started; i++) await Promise.resolve();
    expect(started).toBe(true);
    // 同一个 Runtime 不并发准备第二份说明，避免重复计费与配置覆盖。
    expect(await f.setup.handle(f.request)).toMatchObject({ ok: false });
    await vi.advanceTimersByTimeAsync(120000);
    expect(await pending).toMatchObject({ ok: false });
    release({ ok: false, code: "OUTCOME_UNKNOWN" });
    expect(JSON.parse(readFileSync(f.path, "utf8"))).toEqual(f.config);
  } finally { f.close(); vi.useRealTimers(); }
});
