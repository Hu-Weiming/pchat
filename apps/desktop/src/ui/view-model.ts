import type { Answer, ConversationSettings, KnowledgeMode, RoleStatus, ThoughtStagePackage } from "@pchat/contracts";
import type { ModelOption, RagOption } from "./types";
export function connectionReadiness(settings: ConversationSettings, roles: readonly ThoughtStagePackage[], models: readonly ModelOption[], rag: readonly RagOption[]) {
  const model = models.find((option) => option.binding.connectionId === settings.model.connectionId && option.binding.modelId === settings.model.modelId && option.binding.configRevision === settings.model.configRevision);
  if (!model?.ready) return { ready: false, message: "请先配置本会话使用的模型连接。" };
  const selected = settings.participantIds.length ? settings.participantIds.map((id) => roles.find((role) => role.id === id && role.status === "CONFIRMED")) : roles.filter((role) => role.status === "CONFIRMED");
  const retrieval = rag.find((option) => option.connectionId === settings.ragConnectionId);
  if (!selected.length || selected.some((role) => !role || !retrieval?.readyCorpusIds.includes(role.corpusId))) {
    return { ready: false, message: "所选人物的资料尚未准备就绪，请检查知识库绑定。" };
  }
  return { ready: true, message: "" };
}
export const modeLabels: Record<KnowledgeMode, string> = { PRIMARY: "原典", INFERENCE: "推演", FICTION: "开放拟构" };
export const modeDescriptions: Record<KnowledgeMode, string> = {
  PRIMARY: "只表达原典资料能直接支持的内容。",
  INFERENCE: "基于原典原则推导，并明确标记推演性质。",
  FICTION: "主动允许超出原典依据的创作性回答。",
};
export const roleLabels: Record<RoleStatus, string> = { PENDING: "等待开始", RETRIEVING: "查阅资料", GENERATING: "正在回答", WAITING_USER: "等待你的决定", COMPLETED: "已完成", STOPPED: "已停止", FAILED: "未能完成" };
export const answerLabels: Record<Answer["kind"], string> = { PARAPHRASE: "原典概述", QUOTE: "原典引文", INFERENCE: "受约束推演", FICTION: "创作拟构", INSUFFICIENT_EVIDENCE: "依据不足" };
