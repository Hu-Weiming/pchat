import type { PchatClient } from "@pchat/client";
import { ThoughtStagePackageSchema, type ThoughtStagePackage } from "@pchat/contracts";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import styles from "./ui/Workspace.module.css";

export function RoleDescriptions({ client, disabled, onBusyChange, onSaved }: {
  client: PchatClient; disabled: boolean; onBusyChange(busy: boolean): void; onSaved(): void;
}) {
  const [roles, setRoles] = useState<ThoughtStagePackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadMessage, setLoadMessage] = useState("");
  const [message, setMessage] = useState("");
  const [busyRoleId, setBusyRoleId] = useState<string | null>(null);
  const [queryRevision, setQueryRevision] = useState(0);
  const mounted = useRef(false);
  const generating = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setLoadMessage("");
    // 只读取公共投影；客户端切换或组件关闭后，旧查询不得覆盖新资料。
    void client.query({ type: "ListRoles" }).then((result) => {
      if (cancelled) return;
      if (!result.ok) throw new Error("Role query failed");
      setRoles(result.data.filter((role) => role.status === "CONFIRMED"));
    }).catch(() => {
      if (!cancelled) setLoadMessage("暂时无法读取已确认人物，请刷新资料说明后再操作。");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, queryRevision]);

  async function generate(role: ThoughtStagePackage) {
    // 同步锁阻止连续点击产生第二次付费请求；失败后只允许用户主动再次操作。
    if (generating.current || disabled || loading) return;
    generating.current = true; setBusyRoleId(role.id); setMessage(""); onBusyChange(true);
    try {
      const received = await invoke<unknown>("pchat_confirm_corpus", {
        input: { action: "GENERATE_DESCRIPTION", roleId: role.id, expectedRevision: role.revision },
      });
      if (typeof received !== "object" || received === null || !("confirmed" in received) || received.confirmed !== true || !("role" in received)) throw new Error("Generation result unconfirmed");
      const parsed = ThoughtStagePackageSchema.safeParse(received.role);
      if (!parsed.success || parsed.data.id !== role.id || parsed.data.status !== "CONFIRMED" || !parsed.data.retrievalDescription) throw new Error("Generation result unconfirmed");
      if (!mounted.current) return;
      // 成功后先更新可见说明，再刷新客户端；重新读取期间保留这次已确认的结果。
      setRoles((current) => current.map((item) => item.id === role.id ? parsed.data : item));
      setMessage(`${parsed.data.label}的资料说明已生成并启用。`); onSaved();
    } catch {
      if (mounted.current) setMessage("未能确认生成结果，可能已产生费用；原说明保留。不会自动重试。");
    } finally {
      generating.current = false;
      if (mounted.current) { setBusyRoleId(null); onBusyChange(false); }
    }
  }
  const blocked = disabled || busyRoleId !== null;
  return <section className={styles.newForm} aria-labelledby="role-descriptions-title" aria-busy={loading || busyRoleId !== null}>
    <h3 id="role-descriptions-title">人物资料说明</h3>
    <p className={styles.muted}>让 DeepSeek 根据检索到的原文抽样生成选路说明，并直接启用。说明只帮助匹配讨论方向，不代表完整资料覆盖，也不作为回答依据。每次生成最多调用一次检索和一次模型，请按需要点击。</p>
    <button type="button" className={styles.secondaryButton} disabled={blocked || loading} onClick={() => setQueryRevision((value) => value + 1)}>刷新资料说明</button>
    {loading && <p className={styles.muted} role="status">正在读取人物资料说明…</p>}
    {loadMessage && <p className={styles.muted} role="status">{loadMessage}</p>}
    {!loading && !loadMessage && roles.length === 0 && <p className={styles.muted}>尚未配置已确认人物，请先准备人物资料。</p>}
    {roles.map((role) => <article className={styles.evidenceItem} key={role.id}>
      <h4>{role.label}</h4>
      <p className={styles.muted}>{role.retrievalDescription ?? "尚未生成资料说明"}</p>
      <button type="button" className={styles.secondaryButton} disabled={blocked || loading || !!loadMessage} onClick={() => { void generate(role); }}>
        {busyRoleId === role.id ? "正在生成，请稍候…" : "自动生成并启用说明"}
      </button>
    </article>)}
    {message && <p className={styles.muted} role="status">{message}</p>}
  </section>;
}
