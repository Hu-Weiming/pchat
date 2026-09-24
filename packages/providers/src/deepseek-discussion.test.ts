import { expect, test } from "vitest";
import { DeepSeekDiscussionModel, DEEPSEEK_DISCUSSION_PROMPT_VERSION } from "./deepseek-discussion";
import { createTestDependencies, testEvidence, testRole, testSettings } from "../../testing/src/index";
import type { SecureNetworkRequest } from "./network";
test("uses one bounded structured planning request without exposing corpus identifiers to the model", async () => {
  const calls: SecureNetworkRequest[] = [];
  const plan = { philosophicalQuestion: "自由的条件是什么？", userClaims: [], targets: [{ roleId: testRole.id, searchQuery: "自由的条件" }] };
  const model = new DeepSeekDiscussionModel({ configurations: { resolve: () => ({ binding: testSettings.model, maxOutputTokens: 4096 }) }, network: { request: async (call) => {
    calls.push(call);
    return { ok: true, status: 200, body: (async function* () { yield `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify(plan) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`; })() };
  } } });
  const input = { question: { id: "q", text: "自由是什么？" }, settings: testSettings, catalog: [testRole], executionPolicy: { ...createTestDependencies().modelExecution.policies[0]!, promptVersion: DEEPSEEK_DISCUSSION_PROMPT_VERSION } };
  expect(await model.plan({ attemptId: "plan", input }, { cancelled: false, subscribe: () => () => {} })).toEqual({ ok: true, plan });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body.max_tokens).toBeLessThanOrEqual(1024);
  expect(JSON.stringify(calls[0]?.body.messages)).not.toContain(testRole.corpusId);
});

test.each(["pchat-discussion-prompt-v1", "pchat-discussion-prompt-v2", "pchat-discussion-prompt-v3", DEEPSEEK_DISCUSSION_PROMPT_VERSION])("streams escaped drafts with frozen prompt %s and resolves citations", async (promptVersion) => {
  const text = '自由中的"选择"与责任。\n特殊字符：\\和{括号}。[E1]';
  const answer = { answers: [{ roleId: testRole.id, answer: { text, kind: "PARAPHRASE", evidenceIds: ["E1"] } }], commentary: { text: "", claimIndexes: [] }, summary: { text: "", roleIds: [] } };
  const drafts: string[] = [];
  const calls: SecureNetworkRequest[] = [];
  const model = new DeepSeekDiscussionModel({ configurations: { resolve: () => ({ binding: testSettings.model, maxOutputTokens: 4096 }) }, network: { request: async (call) => {
    calls.push(call);
    return { ok: true, status: 200, body: (async function* () {
      // One character per frame splits JSON escapes and structural boundaries.
      for (const char of JSON.stringify(answer)) yield `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: char }, finish_reason: null }] })}\n\n`;
      yield `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    })() };
  } } });
  const input = {
    question: { id: "q", text: "自由是什么？" }, settings: testSettings,
    plan: { philosophicalQuestion: "自由", userClaims: [], targets: [{ roleId: testRole.id, searchQuery: "自由" }] },
    history: [], participants: [{ participant: testRole, evidence: [{ ...testEvidence, sourceForm: "INTERVIEW" as const }] }], executionPolicy: { ...createTestDependencies().modelExecution.policies[0]!, promptVersion },
  };
  const result = await model.discuss({ attemptId: "final", input, onDraft: async (draft) => { expect(draft.roleId).toBe(testRole.id); drafts.push(draft.text); } }, { cancelled: false, subscribe: () => () => {} });
  expect(result).toMatchObject({ ok: true, answer: { answers: [{ answer: { text: text.replace("E1", testEvidence.id), evidenceIds: [testEvidence.id] } }] } });
  expect(drafts).toContain("自由");
  expect(drafts.at(-1)).toBe(text.replace("E1", testEvidence.id));
  expect(JSON.stringify(calls[0]!.body.messages)).not.toContain(testEvidence.id);
  expect(model.countInput(input)).toBe(JSON.stringify(calls[0]!.body.messages).length * 3 + 1024);
  const sent = JSON.stringify(calls[0]!.body.messages);
  expect(sent.includes("即使原典检索为空，也可以返回明确标为FICTION的创作")).toBe(promptVersion !== "pchat-discussion-prompt-v1");
  expect(sent.includes("保留原文的主语、否定、条件、范围和语气强度")).toBe(promptVersion === "pchat-discussion-prompt-v3" || promptVersion === DEEPSEEK_DISCUSSION_PROMPT_VERSION);
  expect(sent.includes("总结中的每个判断都必须能在上述有效回答中找到同等强度的表述")).toBe(promptVersion === "pchat-discussion-prompt-v3" || promptVersion === DEEPSEEK_DISCUSSION_PROMPT_VERSION);
  expect(sent.includes("sourceForm")).toBe(promptVersion === DEEPSEEK_DISCUSSION_PROMPT_VERSION);
  expect(sent.includes("须明确说明这是访谈发言")).toBe(promptVersion === DEEPSEEK_DISCUSSION_PROMPT_VERSION);
});
