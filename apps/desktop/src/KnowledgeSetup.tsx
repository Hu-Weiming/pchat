import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import styles from "./ui/Workspace.module.css";

interface Document { documentId: string; displayName: string; chunkCount: number; preview: string; kind: "PRIMARY" | "RESEARCH"; workTitle: string; edition: string; translator: string }
export function KnowledgeSetup({ onSaved }: { onSaved(): void }) {
  const [knowledgebaseId, setKnowledgebaseId] = useState("");
  const [label, setLabel] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [documents, setDocuments] = useState<Document[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  async function collect() {
    setBusy(true); setMessage(""); setCollectionId(""); setDocuments([]); setConfirmed(false);
    try {
      const draft = await invoke<{ collectionId: string; documents: Omit<Document, "kind" | "workTitle" | "edition" | "translator">[] }>("pchat_collect_corpus", { input: { knowledgebaseId: knowledgebaseId.trim() } });
      setCollectionId(draft.collectionId); setDocuments(draft.documents.map((document) => ({ ...document, kind: "RESEARCH", workTitle: "", edition: "", translator: "" })));
      setMessage("资料清单已读取。请确认人物阶段及每份文档的来源类型，原典资料需要你明确选择。");
    } catch { setMessage("资料读取未完成。请检查千帆密钥、知识库 ID、文档索引状态及只读 API 权限。不会自动重试。"); }
    finally { setBusy(false); }
  }
  const change = (id: string, field: keyof Document, value: string) => setDocuments((current) => current.map((document) => document.documentId === id ? { ...document, [field]: value } : document));
  async function confirm() {
    setBusy(true); setMessage("");
    try {
      await invoke("pchat_confirm_corpus", { input: { collectionId, label: label.trim(), documents: documents.map(({ documentId, kind, workTitle, edition, translator }) => ({ documentId, kind, workTitle: workTitle.trim() || null, edition: edition.trim() || null, translator: translator.trim() || null })) } });
      setMessage("资料范围已确认，可以在新会话中选择这个思想阶段。"); setCollectionId(""); setDocuments([]); onSaved();
    } catch { setMessage("资料确认未完成，原有会话与资料版本仍保留。请检查填写内容后再操作。"); }
    finally { setBusy(false); }
  }
  return <section className={styles.newForm} aria-label="准备人物知识库">
    <h3>准备人物资料</h3><p className={styles.muted}>先在千帆上传文档并等待索引完成。每个思想阶段使用独立知识库；再次读取同一知识库可确认新版本，旧回答保留原依据。</p>
    <label className={styles.field}>千帆知识库 ID<input value={knowledgebaseId} onChange={(event) => setKnowledgebaseId(event.target.value)} placeholder="knowledgeBaseId" maxLength={200} disabled={busy} /></label>
    <button className={styles.secondaryButton} disabled={busy || !knowledgebaseId.trim()} onClick={() => { void collect(); }}>{busy ? "正在处理，请稍候…" : "读取资料清单"}</button>
    {collectionId && <><label className={styles.field}>人物与思想阶段<input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={200} placeholder="填写这份资料对应的人物及思想阶段" /></label>
      {documents.map((document) => <article className={styles.evidenceItem} key={document.documentId}><h4>{document.displayName}</h4><p className={styles.muted}>{document.chunkCount} 个可检索片段</p><details><summary>预览首个片段</summary><p className={styles.muted}>{document.preview}</p></details><div className={styles.newForm}>
        <label className={styles.field}>资料类型<select value={document.kind} onChange={(event) => change(document.documentId, "kind", event.target.value)}><option value="RESEARCH">二手研究资料</option><option value="PRIMARY">原典资料（本人作品）</option></select></label>
        <label className={styles.field}>作品名称<input value={document.workTitle} onChange={(event) => change(document.documentId, "workTitle", event.target.value)} /></label><div className={styles.connectionFields}><label className={styles.field}>版本（可留空）<input value={document.edition} onChange={(event) => change(document.documentId, "edition", event.target.value)} /></label><label className={styles.field}>译者（可留空）<input value={document.translator} onChange={(event) => change(document.documentId, "translator", event.target.value)} /></label></div>
      </div></article>)}
      <label className={styles.muted}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> 我已核对人物阶段、资料范围与来源类型。</label>
      <button className={styles.primaryButton} disabled={busy || !confirmed || !label.trim()} onClick={() => { void confirm(); }}>确认资料并启用人物</button></>}
    {message && <p className={styles.muted} role="status">{message}</p>}
  </section>;
}
