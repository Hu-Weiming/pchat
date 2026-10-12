import type { PchatClient } from "@pchat/client";
import { ThoughtStagePackageSchema, type ThoughtStagePackage } from "@pchat/contracts";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import styles from "./ui/Workspace.module.css";

const descriptionPrefix = "根据检索原文抽样（不代表全库覆盖）：";
const editableBody = (role: ThoughtStagePackage) => {
  const description = role.retrievalDescription ?? "";
  return description.startsWith(descriptionPrefix) ? description.slice(descriptionPrefix.length) : description;
};
function confirmedRole(received: unknown, role: ThoughtStagePackage) {
  if (typeof received !== "object" || received === null || !("confirmed" in received) || received.confirmed !== true || !("role" in received)) throw new Error("Description result unconfirmed");
  const parsed = ThoughtStagePackageSchema.safeParse(received.role);
  if (!parsed.success || parsed.data.id !== role.id || parsed.data.status !== "CONFIRMED" || !parsed.data.retrievalDescription) throw new Error("Description result unconfirmed");
  return parsed.data;
}

export function RoleDescriptions({ client, disabled, onBusyChange, onSaved }: {
  client: PchatClient; disabled: boolean; onBusyChange(busy: boolean): void; onSaved(): void;
}) {
  const [roles, setRoles] = useState<ThoughtStagePackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadMessage, setLoadMessage] = useState("");
  const [message, setMessage] = useState("");
  const [busyAction, setBusyAction] = useState<{ roleId: string; type: "generate" | "save" } | null>(null);
  const [edits, setEdits] = useState<Record<string, { revision: string; body: string }>>({});
  const [queryRevision, setQueryRevision] = useState(0);
  const mounted = useRef(false);
  const operating = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setLoadMessage("");
    // 只读取公共投影；客户端切换或组件关闭后，旧查询不得覆盖新资料。
    void client.query({ type: "ListRoles" }).then((result) => {
      if (cancelled) return;
      if (!result.ok) throw new Error("Role query failed");
      const confirmed = result.data.filter((role) => role.status === "CONFIRMED");
      setRoles(confirmed);
      setEdits((current) => Object.fromEntries(confirmed.map((role) => {
        const previous = current[role.id];
        return [role.id, previous?.revision === role.revision ? previous : { revision: role.revision, body: editableBody(role) }];
      })));
    }).catch(() => {
      if (!cancelled) setLoadMessage("暂时无法读取已确认人物，请刷新资料说明后再操作。");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, queryRevision]);

  async function updateDescription(role: ThoughtStagePackage, type: "generate" | "save") {
    // 同步锁阻止连续点击产生第二次付费请求；失败后只允许用户主动再次操作。
    if (operating.current || disabled || loading || loadMessage) return;
    const description = edits[role.id]?.body.trim() ?? "";
    if (type === "save" && (!description || description.length > 750)) return;
    operating.current = true; setBusyAction({ roleId: role.id, type }); setMessage(""); onBusyChange(true);
    let requestStarted = false;
    try {
      // 重载配置前确认没有进行中的讨论，避免中断已开始的付费调用。
      const conversations = await client.query({ type: "ListConversations" });
      if (!conversations.ok) { if (mounted.current) setMessage("暂时无法确认讨论状态，请刷新后再准备资料说明。"); return; }
      if (conversations.data.some((conversation) => conversation.activeTurnId !== null)) {
        if (mounted.current) setMessage("请先完成或停止当前讨论，再准备资料说明。");
        return;
      }
      requestStarted = true;
      const received = await invoke<unknown>(type === "generate" ? "pchat_collect_corpus" : "pchat_confirm_corpus", {
        input: { action: type === "generate" ? "GENERATE_DESCRIPTION" : "SAVE_DESCRIPTION", roleId: role.id, expectedRevision: role.revision,
          ...(type === "save" ? { description } : {}) },
      });
      const updated = confirmedRole(received, role);
      if (mounted.current) {
        // 回执已确认持久化，即使后续重启失败，也保留可读结果供用户检查。
        setRoles((current) => current.map((item) => item.id === role.id ? updated : item));
        setEdits((current) => ({ ...current, [role.id]: { revision: updated.revision, body: editableBody(updated) } }));
      }
      if (type === "generate") {
        // 生成使用可等待较长时间的资料命令；持久化成功后再重启以加载新说明。
        await invoke("p0_runtime_stop");
        await invoke("p0_runtime_start");
      }
      if (!mounted.current) return;
      setMessage(`${updated.label}的资料说明已${type === "generate" ? "生成" : "保存"}并启用。`); onSaved();
    } catch {
      if (mounted.current) {
        setMessage(!requestStarted ? "暂时无法确认讨论状态，请刷新后再准备资料说明。" : type === "generate"
          ? "尚未确认说明是否启用，可能已产生费用；请刷新查看，不会自动重试。"
          : "尚未确认说明是否启用；请刷新查看，不会自动重试。手工保存不调用模型或知识库。");
        if (requestStarted) onSaved();
      }
    } finally {
      operating.current = false;
      if (mounted.current) { setBusyAction(null); onBusyChange(false); }
    }
  }
  const blocked = disabled || busyAction !== null;
  return <section className={styles.newForm} aria-labelledby="role-descriptions-title" aria-busy={loading || busyAction !== null}>
    <h3 id="role-descriptions-title">人物资料说明</h3>
    <p className={styles.muted}>让 DeepSeek 根据检索到的原文抽样生成选路说明，并直接启用。说明只帮助匹配讨论方向，不代表完整资料覆盖，也不作为回答依据。每次生成最多调用一次检索和一次模型，请按需要点击。</p>
    <p className={styles.muted}>说明准备有独立的累计调用额度上限 20，按内部调用单位累计，不是人民币金额；禁用外部调用时不会生成。手工修改并保存不调用模型或知识库。</p>
    <button type="button" className={styles.secondaryButton} disabled={blocked || loading} onClick={() => setQueryRevision((value) => value + 1)}>刷新资料说明</button>
    {loading && <p className={styles.muted} role="status">正在读取人物资料说明…</p>}
    {loadMessage && <p className={styles.muted} role="status">{loadMessage}</p>}
    {!loading && !loadMessage && roles.length === 0 && <p className={styles.muted}>尚未配置已确认人物，请先准备人物资料。</p>}
    {roles.map((role) => <article className={styles.evidenceItem} key={role.id}>
      <h4>{role.label}</h4>
      <p className={styles.muted}>{role.retrievalDescription ?? "尚未生成资料说明"}</p>
      <label className={styles.field}>修改资料说明
        <span className={styles.muted}>{descriptionPrefix}</span>
        <textarea value={edits[role.id]?.body ?? ""} maxLength={750} rows={5} disabled={blocked || loading || !!loadMessage}
          style={{ width: "100%", border: "1px solid #e5dfd3", borderRadius: 4, background: "#fffdf8", padding: 12, color: "inherit", font: "inherit", resize: "vertical" }}
          onChange={(event) => setEdits((current) => ({ ...current, [role.id]: { revision: role.revision, body: event.target.value } }))} />
      </label>
      <p className={styles.muted}>仅填写已核对的资料范围与适用问题，最多 750 字。抽样范围提示会保留。</p>
      <button type="button" className={styles.secondaryButton} disabled={blocked || loading || !!loadMessage || !edits[role.id]?.body.trim() || edits[role.id]?.body.trim() === editableBody(role).trim()}
        onClick={() => { void updateDescription(role, "save"); }}>
        {busyAction?.roleId === role.id && busyAction.type === "save" ? "正在保存，请稍候…" : "保存修改并启用"}
      </button>
      <button type="button" className={styles.secondaryButton} disabled={blocked || loading || !!loadMessage} onClick={() => { void updateDescription(role, "generate"); }}>
        {busyAction?.roleId === role.id && busyAction.type === "generate" ? "正在生成，请稍候…" : "自动生成并启用说明"}
      </button>
    </article>)}
    {message && <p className={styles.muted} role="status">{message}</p>}
  </section>;
}
