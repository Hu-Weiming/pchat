import { useState, type FormEvent } from "react";
import type { ConversationSettings, KnowledgeMode, ThoughtStagePackage } from "@pchat/contracts";
import type { ModelOption, RagOption } from "./types";
import { ParticipantPicker } from "./ParticipantPicker";
import { modeDescriptions, modeLabels } from "./view-model";
import styles from "./Workspace.module.css";

export function NewConversation({ roles, models, retrieval, disabled, onCreate, onConfigure }: {
  roles: readonly ThoughtStagePackage[]; models: readonly ModelOption[]; retrieval: readonly RagOption[]; disabled: boolean;
  onCreate(title: string, settings: ConversationSettings): Promise<void>; onConfigure(): void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<KnowledgeMode>("INFERENCE");
  const [title, setTitle] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [ragId, setRagId] = useState("");
  const model = models.find((option) => JSON.stringify(option.binding) === modelKey) ?? models[0];
  const rag = retrieval.find((option) => option.connectionId === ragId) ?? retrieval[0];
  const hasParticipants = roles.some((role) => role.status === "CONFIRMED") && selected.every((id) => roles.some((role) => role.id === id && role.status === "CONFIRMED"));
  const canCreate = hasParticipants && model && rag && !disabled;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canCreate || !model || !rag) return;
    await onCreate(title.trim() || "新的讨论", { participantIds: selected, knowledgeMode: mode, model: model.binding, ragConnectionId: rag.connectionId });
  }
  return <div className={styles.newPage}>
    <div className={styles.eyebrow}>思想之间 <span>PHILOSOPHICAL ATELIER</span></div>
    <h1>从一个好问题开始。</h1>
    <p className={styles.introduction}>邀请不同的思想立场，查阅它们各自的文本依据，慢慢看清问题的分歧。</p>
    <form onSubmit={(event) => { void submit(event); }} className={styles.newForm}>
      <label className={styles.field}>会话名称<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={500} placeholder="给这段讨论起个名字（可选）" /></label>
      <ParticipantPicker roles={roles} selected={selected} disabled={disabled} onChange={setSelected} />
      <p className={styles.muted}>{selected.length ? "按你选择的人物查阅资料。" : "未手动选人：根据每个问题，从已确认目录中选择1至3位人物。"}</p>
      <fieldset className={styles.modePicker}><legend>回答依据</legend><div className={styles.modeOptions}>
        {(["PRIMARY", "INFERENCE", "FICTION"] as const).map((value) => <label key={value} className={mode === value ? styles.modeSelected : ""}>
          <input type="radio" name="knowledge-mode" value={value} checked={mode === value} onChange={() => setMode(value)} />
          <strong>{modeLabels[value]}</strong><span>{modeDescriptions[value]}</span>
        </label>)}
      </div></fieldset>
      <div className={styles.connectionFields}>
        <label className={styles.field}>生成模型<select value={model ? JSON.stringify(model.binding) : ""} onChange={(event) => setModelKey(event.target.value)}>
          {models.length === 0 && <option value="">尚未配置模型连接</option>}
          {models.map((option) => <option key={JSON.stringify(option.binding)} value={JSON.stringify(option.binding)}>{option.label}{option.ready ? "" : "（待配置）"}</option>)}
        </select></label>
        <label className={styles.field}>知识库连接<select value={rag?.connectionId ?? ""} onChange={(event) => setRagId(event.target.value)}>
          {retrieval.length === 0 && <option value="">尚未配置知识库连接</option>}
          {retrieval.map((option) => <option key={option.connectionId} value={option.connectionId}>{option.label}</option>)}
        </select></label>
      </div>
      {(!model || !rag || !hasParticipants) && <div className={styles.setupNotice}><p>准备好模型连接与已确认的人物资料，就可以开始讨论。已有的对话仍可随时阅读。</p><button type="button" className={styles.textButton} onClick={onConfigure}>打开连接与资料设置 →</button></div>}
      <div className={styles.newActions}><span className={styles.muted}>人物是依据资料构建的思想立场模型。</span><button className={styles.primaryButton} disabled={!canCreate} type="submit">创建会话 <span aria-hidden="true">→</span></button></div>
    </form>
  </div>;
}
