import { invoke } from "@tauri-apps/api/core";
import type { PchatClient } from "@pchat/client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import styles from "./ui/Workspace.module.css";
import { KnowledgeSetup } from "./KnowledgeSetup";
import { RoleDescriptions } from "./RoleDescriptions";

export function SettingsDialog({ client, onClose, onSaved }: { client: PchatClient; onClose(): void; onSaved(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [provider, setProvider] = useState("deepseek");
  const [key, setKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [windowTokens, setWindowTokens] = useState(65536);
  const [outputTokens, setOutputTokens] = useState(4096);
  const [busy, setBusy] = useState(false);
  const [descriptionBusy, setDescriptionBusy] = useState(false);
  const [knowledgeBusy, setKnowledgeBusy] = useState(false);
  const [message, setMessage] = useState("");
  const blocked = busy || descriptionBusy || knowledgeBusy;
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); if (blocked) return; setBusy(true); setMessage("");
    try {
      await invoke("pchat_save_connection", { input: { provider, apiKey: key, modelId: provider === "deepseek" ? modelId.trim() : null, windowTokens, maxOutputTokens: outputTokens } });
      setKey(""); setMessage("连接已保存。未完成的讨论会保留，重新生成需要你确认。"); onSaved();
    } catch { setMessage("连接未能保存。请确认已在 Pchat 桌面程序中打开，并检查填写内容。"); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className={styles.evidenceDialog} onCancel={(event) => { event.preventDefault(); if (!blocked) onClose(); }} aria-labelledby="settings-title">
    <header className={styles.drawerHeader}><div><span className={styles.eyebrow}>准备工作</span><h2 id="settings-title">连接与资料设置</h2></div><button className={styles.iconButton} disabled={blocked} onClick={onClose} aria-label="关闭设置">×</button></header>
    <p className={styles.drawerIntro}>密钥在本机安全保存。人物资料由你在百度千帆上传和管理，Pchat 读取已确认的资料范围。</p>
    <p className={styles.muted}>当前安装使用累计调用额度上限 100；每轮为模型和检索预留额度。这不是人民币账单上限，请同时在供应商控制台设置消费限额。</p>
    <form className={styles.newForm} onSubmit={(event) => { void save(event); }}>
      <fieldset disabled={blocked} className={styles.newForm} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <label className={styles.field}>服务<select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="deepseek">DeepSeek · 生成模型</option><option value="qianfan">百度千帆 · 知识库</option></select></label>
      <label className={styles.field}>API Key<input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} required maxLength={4096} placeholder="粘贴你的密钥" /></label>
      {provider === "deepseek" && <><label className={styles.field}>模型 ID<input value={modelId} onChange={(event) => setModelId(event.target.value)} required placeholder="填写供应商提供的模型 ID" /></label><div className={styles.connectionFields}><label className={styles.field}>模型上下文窗口<input type="number" min={2048} max={2000000} value={windowTokens} onChange={(event) => setWindowTokens(Number(event.target.value))} /></label><label className={styles.field}>单次输出上限<input type="number" min={256} max={128000} value={outputTokens} onChange={(event) => setOutputTokens(Number(event.target.value))} /></label></div><p className={styles.muted}>窗口与输出上限以所选模型支持的值为准。更大的输出上限可能增加费用。</p></>}
      <button className={styles.primaryButton} disabled={blocked} type="submit">{busy ? "正在保存…" : "安全保存连接"}</button>
      {message && <p className={styles.muted} role="status">{message}</p>}
      </fieldset>
    </form>
    {/* 生成说明会重启 Runtime；等待期间暂停其他配置操作，避免重启相互干扰。 */}
    {provider === "qianfan" && <KnowledgeSetup disabled={busy || descriptionBusy} onBusyChange={setKnowledgeBusy} onSaved={onSaved} />}
    <RoleDescriptions client={client} disabled={busy || knowledgeBusy} onBusyChange={setDescriptionBusy} onSaved={onSaved} />
  </dialog>;
}
