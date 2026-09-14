import { expect, it } from "vitest";
import type { GenerationRequest, ModelInputSnapshot } from "@pchat/harness";
import { testEvidence, testRole, testSettings } from "../../testing/src/index";
import { DeepSeekModel } from "./deepseek";
import type { SecureNetworkRequest } from "./network";

const input: ModelInputSnapshot = {
  context: { question: { id: "question", text: "Current question" }, settings: testSettings, participant: testRole, history: [], executionPolicy: {
    binding: testSettings.model, windowTokens: 1000, outputReserveTokens: 17, policyVersion: "policy-v1", counterVersion: "test-tokens", promptVersion: "pchat-deepseek-prompt-v1", countMode: "UPPER_BOUND",
  } }, evidence: [testEvidence],
  checkpoint: { generatorVersion: "pchat-extractive-v1", sourceTurnIds: ["old-turn"], fromEventSeq: 1, toEventSeq: 3,
    userQuestions: [{ turnId: "old-turn", text: "An older question", start: 0, end: 17 }], userClaims: [], clarifiedConcepts: [], rolePositions: [], unresolvedDifferences: [] },
  audit: { assemblerVersion: "pchat-context-v1", policyVersion: "policy-v1", counterVersion: "test-tokens", promptVersion: "pchat-deepseek-prompt-v1", countMode: "UPPER_BOUND",
    windowTokens: 1000, outputReserveTokens: 17, baseInputTokens: 100, inputTokens: 150, retainedTurnIds: [], omittedTurnIds: ["old-turn"], checkpointStatus: "CAPTURED" },
};

it("renders the audited checkpoint and frozen output reserve in the actual network request", async () => {
  const calls: SecureNetworkRequest[] = [];
  const model = new DeepSeekModel({ configurations: { resolve: () => ({ binding: testSettings.model, maxOutputTokens: 2048 }) }, network: { request: async (request) => {
    calls.push(request);
    return { ok: false, code: "REJECTED" };
  } } });
  const request: GenerationRequest = { attemptId: "attempt", roleRunId: "role", context: input.context, evidence: input.evidence, input };
  for await (const _ of model.generate(request, { cancelled: false, subscribe: () => () => {} })) { /* consume */ }
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body.max_tokens).toBe(17);
  const messages = calls[0]!.body.messages;
  expect(Array.isArray(messages)).toBe(true);
  if (!Array.isArray(messages)) throw new Error("Missing messages");
  const user = messages[1];
  if (typeof user !== "object" || user === null || Array.isArray(user) || typeof user.content !== "string") throw new Error("Missing user content");
  expect(JSON.parse(user.content)).toMatchObject({ checkpoint: input.checkpoint, history: input.context.history, evidence: input.evidence });
});
