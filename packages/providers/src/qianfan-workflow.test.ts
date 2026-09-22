import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { QianfanWorkflowRAG } from "./qianfan-workflow";
import type { SecureNetworkRequest } from "./network";

const binding = { connectionId: "qianfan-personal", corpusId: "sartre", corpusRevision: "confirmed-v1", retrievalConfigRevision: "workflow-v2" };
const config = { binding, appId: "app", group: "存在主义与现象学", person: "萨特", datasetId: "sartre-kb", maxEvidenceChars: 7000, maxPassages: 6 };
const request = { ...binding, attemptId: "attempt", roleRunId: "role", query: "自由与责任" };
const token = { cancelled: false, subscribe: () => () => {} };
const chunk = { segment_id: "seg", document_id: "doc", dataset_id: "sartre-kb", score: 0.6, content: "原始文本", document_name: "存在与虚无", original_chunk_id: "seg", original_chunk_offset: 0, url: "" };
function fixture(chunks: unknown[] = [chunk]) {
  const calls: SecureNetworkRequest[] = [];
  const code = JSON.stringify({ output: chunks, output1: null });
  const rag = new QianfanWorkflowRAG({ configurations: { resolve: () => config }, hasher: { sha256: async (text) => createHash("sha256").update(text).digest("hex") }, network: { request: async (r) => {
    calls.push(r);
    const body = r.operation === "qianfan.conversation" ? { request_id: "req1", conversation_id: "conversation" } : { request_id: "req2", conversation_id: "conversation", answer: code,
      content: [{ event_code: 0, event_type: "chatflow", content_type: "code", event_status: "done", outputs: { code, language: "json" } }, { event_code: 0, event_type: "chatflow", content_type: "status", event_status: "success", outputs: {} }] };
    return { ok: true, status: 200, body: (async function* () { yield JSON.stringify(body); })() };
  } } });
  return { rag, calls };
}
test("retrieves raw workflow output using an isolated conversation and exact group/person parameters", async () => {
  const { rag, calls } = fixture();
  expect(await rag.retrieve(request, token)).toMatchObject({ ok: true, evidence: [{ text: "原始文本", corpusId: "sartre", kind: "PRIMARY", locator: null, edition: null }] });
  expect(calls.map((r) => r.operation)).toEqual(["qianfan.conversation", "qianfan.workflow"]);
  expect(calls[1]?.body).toEqual({ app_id: "app", conversation_id: "conversation", query: "自由与责任", stream: false, parameters: { group: "存在主义与现象学", per: "萨特" } });
});
test("deduplicates expanded hits and keeps complete passages within the per-person budget", async () => {
  const { rag } = fixture([chunk, chunk, { ...chunk, segment_id: "giant", content: "字".repeat(8000) }, { ...chunk, segment_id: "second", content: "第二段" }]);
  const result = await rag.retrieve(request, token);
  expect(result).toMatchObject({ ok: true, evidence: [{ text: "原始文本" }, { text: "第二段" }] });
  if (result.ok) expect(result.evidence).toHaveLength(2);
});
test.each([
  { chunks: [{ ...chunk, dataset_id: "another-person" }] },
  { chunks: [chunk, { ...chunk, content: "同一编号的不同原文" }] },
  { chunks: [{ ...chunk, content: "" }] },
])("rejects foreign or inconsistent evidence without retry", async ({ chunks }) => {
  const { rag, calls } = fixture(chunks);
  expect(await rag.retrieve(request, token)).toEqual({ ok: false, code: "REJECTED" });
  expect(calls).toHaveLength(2);
});

test("omits signed editorial notes while retaining an exact original paragraph", async () => {
  const content = "「原典.pdf」\n\n这是解释作者的语言观点。——原编者注\n\n语言是社会力量的产物，同时处在时间之中。";
  const { rag } = fixture([{ ...chunk, content }]);
  const result = await rag.retrieve({ ...request, query: "语言和社会" }, token);
  expect(result).toMatchObject({ ok: true, evidence: [{ text: "语言是社会力量的产物，同时处在时间之中。" }] });
  if (result.ok) {
    const excerpt = result.evidence[0]!.sourceExcerpt!;
    expect(content.slice(excerpt.start, excerpt.end)).toBe(result.evidence[0]!.text);
  }
});

test("does not discard a relevant chapter just because two other chapters share its document", async () => {
  const { rag } = fixture([
    { ...chunk, segment_id: "interview-1", score: 0.9, content: "关于社会和生产关系的访谈。" },
    { ...chunk, segment_id: "interview-2", score: 0.8, content: "关于联合共事与革命的访谈。" },
    { ...chunk, segment_id: "essay", score: 0.7, content: "人既然是自由的，就必须为自己的选择承担责任。" },
  ]);
  const result = await rag.retrieve(request, token);
  expect(result).toMatchObject({ ok: true, evidence: [expect.anything(), expect.anything(), { text: "人既然是自由的，就必须为自己的选择承担责任。" }] });
});
test("returns a real empty result without invoking a fallback model", async () => {
  const { rag } = fixture([]);
  expect(await rag.retrieve(request, token)).toEqual({ ok: true, evidence: [] });
});
test("does not create a remote conversation after cancellation", async () => {
  const { rag, calls } = fixture();
  expect(await rag.retrieve(request, { ...token, cancelled: true })).toEqual({ ok: false, code: "REJECTED" });
  expect(calls).toHaveLength(0);
});
test("excludes translator introductions and extracts relevant original paragraphs from oversized chapters", async () => {
  const { rag } = fixture([
    { ...chunk, segment_id: "preface", score: 0.9, content: "# 译者序一\n\n译者对自由与责任的介绍。" },
    { ...chunk, segment_id: "toc", score: 0.8, content: "# 目录 Content\n\n[第一章](chapter.html)" },
    { ...chunk, segment_id: "chapter", score: 0.7, content: "# 原典正文\n\n" + "其他话题。\n\n".repeat(1600) + "人必须为自己的自由选择承担责任。\n\n不能以不选择来逃避责任。" },
  ]);
  const result = await rag.retrieve(request, token);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.evidence).toHaveLength(1);
  expect(result.evidence[0]?.text).toContain("人必须为自己的自由选择承担责任。");
  expect(result.evidence[0]?.text.length).toBeLessThanOrEqual(2400);
  expect(result.evidence[0]?.workTitle).toBe("存在与虚无");
});

test.each([
  "「原典.md」\n\nDigital Lab是上海译文出版社数字业务的实验部门。我们致力于将优质的资源送到读者手中。",
  "「规训与惩罚.pdf」\n\n这里仅对几个术语的译名做一简单的说明。福柯创用了这个新术语。",
])("excludes unheaded publisher and translator matter", async (content) => {
  const { rag } = fixture([{ ...chunk, content }]);
  expect(await rag.retrieve(request, token)).toEqual({ ok: true, evidence: [] });
});
