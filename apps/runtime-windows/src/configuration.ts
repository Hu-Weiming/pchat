import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ModelBindingSchema, ThoughtStagePackageSchema } from "@pchat/contracts";
import { DeepSeekModel, DeepSeekDiscussionModel, DEEPSEEK_DISCUSSION_PROMPT_VERSION, QianfanRAG, QianfanWorkflowRAG, snapshotWorkflowConfiguration, type QianfanWorkflowConfiguration, renderDeepSeekPrompt, DEEPSEEK_PROMPT_VERSION, snapshotQianfanConfiguration, type QianfanConfiguration, type SecureNetworkPort } from "@pchat/providers";
import type { RuntimePorts } from "./bootstrap";

const schema = z.strictObject({
  version: z.literal(1), connections: z.array(z.strictObject({ id: z.string(), provider: z.enum(["deepseek", "qianfan"]), revision: z.string() })),
  models: z.array(z.strictObject({ binding: ModelBindingSchema, windowTokens: z.number().int().min(2048).max(2000000), maxOutputTokens: z.number().int().min(256).max(128000) })),
  roles: z.array(ThoughtStagePackageSchema), retrieval: z.array(z.unknown()), maxCostUnits: z.number().min(0).max(100000),
  workflowRetrieval: z.array(z.unknown()).optional(),
});
export function configuredPorts(stateDirectory: string, network: SecureNetworkPort): RuntimePorts {
  let raw: unknown = { version: 1, connections: [], models: [], roles: [], retrieval: [], maxCostUnits: 100 };
  try { raw = JSON.parse(readFileSync(join(stateDirectory, "configuration.json"), "utf8")); }
  catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw new Error("Invalid runtime configuration"); }
  const config = schema.parse(raw);
  const retrieval = config.retrieval.map((value) => snapshotQianfanConfiguration(value as QianfanConfiguration));
  const workflow = (config.workflowRetrieval ?? []).map((value) => snapshotWorkflowConfiguration(value as QianfanWorkflowConfiguration));
  const configurations = { resolve: (binding: import("@pchat/contracts").ModelBinding) => config.models.find((model) => model.binding.connectionId === binding.connectionId && model.binding.modelId === binding.modelId && model.binding.configRevision === binding.configRevision) };
  const hasher = { sha256: async (text: string) => createHash("sha256").update(text, "utf8").digest("hex") };
  const workflowRag = new QianfanWorkflowRAG({ network, hasher, configurations: { resolve: (binding) => workflow.find((item) => Object.entries(binding).every(([key, value]) => item.binding[key as keyof typeof binding] === value)) } });
  const directRag = new QianfanRAG({ network, hasher, configurations: { resolve: (binding) => retrieval.find((item) => item.binding.connectionId === binding.connectionId && item.binding.corpusId === binding.corpusId && item.binding.corpusRevision === binding.corpusRevision && item.binding.retrievalConfigRevision === binding.retrievalConfigRevision) } });
  const counterVersion = "pchat-deepseek-utf8-bound-v1";
  return {
    roles: config.roles,
    model: new DeepSeekModel({ network, configurations }),
    ...(workflow.length ? { discussionModel: new DeepSeekDiscussionModel({ network, configurations }) } : {}),
    rag: { retrieve: (request, cancellation) => workflow.some((item) => item.binding.corpusId === request.corpusId) ? workflowRag.retrieve(request, cancellation) : directRag.retrieve(request, cancellation) },
    limits: { maxActiveTurns: 3, maxRoleRuns: 3, maxExternalCalls: workflow.length ? 1 : 3, maxCostUnits: config.maxCostUnits },
    attemptCostUnits: { MODEL: 1, RAG: Math.max(workflow.length ? 2 : 1, ...retrieval.map((item) => item.topK + 1)) }, draftCheckpointChars: 120,
    modelExecution: {
      policies: config.models.map((model) => ({ binding: model.binding, windowTokens: model.windowTokens, outputReserveTokens: model.maxOutputTokens, policyVersion: model.binding.configRevision, counterVersion, promptVersion: workflow.length ? DEEPSEEK_DISCUSSION_PROMPT_VERSION : DEEPSEEK_PROMPT_VERSION, countMode: "UPPER_BOUND" })),
      counter: { version: counterVersion, count: (input) => Buffer.byteLength(JSON.stringify(renderDeepSeekPrompt(input)), "utf8") + 1024 },
    },
  };
}
