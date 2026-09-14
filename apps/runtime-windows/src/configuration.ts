import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ModelBindingSchema, ThoughtStagePackageSchema } from "@pchat/contracts";
import { DeepSeekModel, QianfanRAG, renderDeepSeekPrompt, DEEPSEEK_PROMPT_VERSION, snapshotQianfanConfiguration, type QianfanConfiguration, type SecureNetworkPort } from "@pchat/providers";
import type { RuntimePorts } from "./bootstrap";

const schema = z.strictObject({
  version: z.literal(1), connections: z.array(z.strictObject({ id: z.string(), provider: z.enum(["deepseek", "qianfan"]), revision: z.string() })),
  models: z.array(z.strictObject({ binding: ModelBindingSchema, windowTokens: z.number().int().min(2048).max(2000000), maxOutputTokens: z.number().int().min(256).max(128000) })),
  roles: z.array(ThoughtStagePackageSchema), retrieval: z.array(z.unknown()), maxCostUnits: z.number().min(0).max(100000),
});
export function configuredPorts(stateDirectory: string, network: SecureNetworkPort): RuntimePorts {
  let raw: unknown = { version: 1, connections: [], models: [], roles: [], retrieval: [], maxCostUnits: 100 };
  try { raw = JSON.parse(readFileSync(join(stateDirectory, "configuration.json"), "utf8")); }
  catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw new Error("Invalid runtime configuration"); }
  const config = schema.parse(raw);
  const retrieval = config.retrieval.map((value) => snapshotQianfanConfiguration(value as QianfanConfiguration));
  const counterVersion = "pchat-deepseek-utf8-bound-v1";
  return {
    roles: config.roles,
    model: new DeepSeekModel({ network, configurations: { resolve: (binding) => config.models.find((model) => model.binding.connectionId === binding.connectionId && model.binding.modelId === binding.modelId && model.binding.configRevision === binding.configRevision) } }),
    rag: new QianfanRAG({ network, hasher: { sha256: async (text) => createHash("sha256").update(text, "utf8").digest("hex") }, configurations: { resolve: (binding) => retrieval.find((item) => item.binding.connectionId === binding.connectionId && item.binding.corpusId === binding.corpusId && item.binding.corpusRevision === binding.corpusRevision && item.binding.retrievalConfigRevision === binding.retrievalConfigRevision) } }),
    limits: { maxActiveTurns: 3, maxRoleRuns: 3, maxExternalCalls: 3, maxCostUnits: config.maxCostUnits },
    attemptCostUnits: { MODEL: 1, RAG: Math.max(1, ...retrieval.map((item) => item.topK + 1)) }, draftCheckpointChars: 120,
    modelExecution: {
      policies: config.models.map((model) => ({ binding: model.binding, windowTokens: model.windowTokens, outputReserveTokens: model.maxOutputTokens, policyVersion: model.binding.configRevision, counterVersion, promptVersion: DEEPSEEK_PROMPT_VERSION, countMode: "UPPER_BOUND" })),
      counter: { version: counterVersion, count: (input) => Buffer.byteLength(JSON.stringify(renderDeepSeekPrompt(input)), "utf8") + 1024 },
    },
  };
}
