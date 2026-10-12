import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { EvidenceSchema, ModelBindingSchema, ThoughtStagePackageSchema } from "@pchat/contracts";
import { DeepSeekDiscussionModel, type SecureNetworkPort } from "@pchat/providers";
import type { Cancellation } from "@pchat/harness";
import { configuredPorts } from "./configuration";

const inputSchema = z.strictObject({ action: z.literal("GENERATE_DESCRIPTION"), roleId: z.string().min(1).max(200), expectedRevision: z.string().min(1).max(200) });
const storedSchema = z.object({
  connections: z.array(z.object({ id: z.string(), provider: z.string(), revision: z.string() })),
  models: z.array(z.object({ binding: ModelBindingSchema, windowTokens: z.number(), maxOutputTokens: z.number() })),
  roles: z.array(ThoughtStagePackageSchema), retrieval: z.array(z.unknown()), workflowRetrieval: z.array(z.unknown()).optional(),
}).passthrough();
const bindingSchema = z.object({ binding: z.object({ connectionId: z.string(), corpusId: z.string(), corpusRevision: z.string(), retrievalConfigRevision: z.string() }) });

/** 按已有角色绑定取得真实原文；自动启用的说明始终标明抽样边界。 */
export async function generateRoleDescription(stateDirectory: string, network: SecureNetworkPort, raw: unknown, cancellation: Cancellation) {
  const input = inputSchema.parse(raw);
  const configPath = join(stateDirectory, "configuration.json");
  const config = storedSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  const ports = configuredPorts(stateDirectory, network);
  const role = ports.roles.find((item) => item.id === input.roleId && item.status === "CONFIRMED" && item.revision === input.expectedRevision);
  const retrieval = bindingSchema.array().parse([...(config.workflowRetrieval ?? []), ...config.retrieval]).find((item) => item.binding.corpusId === role?.corpusId
    && item.binding.corpusRevision === role?.corpusRevision && item.binding.retrievalConfigRevision === role?.retrievalConfigRevision);
  const policy = ports.modelExecution.policies.find((item) => config.connections.some((connection) => connection.provider === "deepseek"
    && connection.id === item.binding.connectionId && connection.revision === item.binding.configRevision));
  if (!role || !retrieval || !policy || cancellation.cancelled) throw new Error("Description preparation unavailable");
  const directory = join(stateDirectory, "description-jobs");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${randomUUID()}.json`);
  const job = { roleId: role.id, roleRevision: role.revision, corpusRevision: role.corpusRevision, status: "IN_FLIGHT", stage: "RAG", evidence: [] as z.infer<typeof EvidenceSchema>[], description: "" };
  const save = (target: string, value: unknown) => { const temporary = `${target}.${randomUUID()}.tmp`; writeFileSync(temporary, JSON.stringify(value)); renameSync(temporary, target); };
  save(path, job);
  try {
    const result = await ports.rag.retrieve({ attemptId: randomUUID(), roleRunId: role.id, connectionId: retrieval.binding.connectionId,
      corpusId: role.corpusId, corpusRevision: role.corpusRevision, retrievalConfigRevision: role.retrievalConfigRevision,
      query: `${role.label}：请检索涉及不同哲学问题的原文片段，包含主要概念和适用情境。`,
    }, cancellation);
    if (!result.ok) { job.status = result.code; throw new Error("Retrieval unavailable"); }
    const evidence = EvidenceSchema.array().parse(result.evidence);
    if (evidence.some((item) => item.corpusId !== role.corpusId || item.corpusRevision !== role.corpusRevision)) throw new Error("Invalid description sources");
    // 不截断原文或重写哈希；只取符合输入上限的原典片段，并完整保存来源。
    let remaining = 12000;
    job.evidence = evidence.filter((item) => {
      if (item.kind !== "PRIMARY" || item.text.length > 2400 || item.text.length > remaining) return false;
      remaining -= item.text.length; return true;
    }).slice(0, 8);
    if (!job.evidence.length || cancellation.cancelled) throw new Error("No usable description sources");
    job.stage = "DESCRIPTION";
    save(path, job);
    const model = new DeepSeekDiscussionModel({ network, configurations: { resolve: (binding) => config.models.find((item) =>
      item.binding.connectionId === binding.connectionId && item.binding.modelId === binding.modelId && item.binding.configRevision === binding.configRevision) } });
    const generated = await model.describe({ attemptId: randomUUID(), role, evidence: job.evidence, policy }, cancellation);
    if (!generated.ok) { job.status = generated.code; throw new Error("Description generation unavailable"); }
    if (cancellation.cancelled) throw new Error("Cancelled description generation");
    // 网络等待期间重新读取配置，防止说明覆盖其他设置或绑定到已更新的资料。
    const current = storedSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
    const index = current.roles.findIndex((item) => item.id === role.id && item.revision === role.revision
      && item.corpusId === role.corpusId && item.corpusRevision === role.corpusRevision && item.retrievalConfigRevision === role.retrievalConfigRevision);
    if (index < 0) throw new Error("Role changed during description generation");
    const description = `根据检索原文抽样（不代表全库覆盖）：${generated.description}`;
    const updated = ThoughtStagePackageSchema.parse({ ...current.roles[index], revision: randomUUID(), retrievalDescription: description });
    current.roles[index] = updated;
    job.description = description;
    // 先保存来源审计再启用说明；原子替换失败时，原配置保持可读取。
    job.status = "GENERATED";
    save(path, job);
    save(configPath, current);
    job.status = "SUCCEEDED";
    // 配置已经成功启用后，审计状态补写失败不能把成功回执变成失败。
    try { save(path, job); } catch { /* 生成前保存的原文审计仍然存在。 */ }
    return { confirmed: true as const, role: updated };
  } catch {
    if (!["OUTCOME_UNKNOWN", "REJECTED"].includes(job.status)) job.status = cancellation.cancelled ? "OUTCOME_UNKNOWN" : "FAILED";
    save(path, job);
    throw new Error("Description preparation failed");
  }
}
