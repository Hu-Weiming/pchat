import { useEffect, useRef } from "react";
import type { RoleRunProjection } from "@pchat/contracts";
import styles from "./Workspace.module.css";

export function EvidenceDrawer({ role, onClose }: { role: RoleRunProjection; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => { element?.close(); }; }, []);
  return <dialog ref={dialog} className={styles.evidenceDialog} aria-labelledby="evidence-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className={styles.drawerHeader}><div><span className={styles.eyebrow}>阅读依据</span><h2 id="evidence-title">{role.context.participant.label}</h2></div><button autoFocus type="button" className={styles.iconButton} aria-label="关闭依据视图" onClick={onClose}>×</button></header>
    <p className={styles.drawerIntro}>这里保存的是本次回答实际使用的资料，不随后续知识库更新改写。</p>
    <div className={styles.evidenceList}>{role.evidence.length === 0 ? <p className={styles.muted}>本回答尚无可展示的资料片段。</p> : role.evidence.map((evidence, index) => <article key={evidence.id} className={styles.evidenceItem}>
      <div className={styles.evidenceTop}><span className={styles.sourceNumber}>{String(index + 1).padStart(2, "0")}</span><span className={styles.smallTag}>{evidence.kind === "PRIMARY" ? "原典资料" : "研究资料"}</span></div>
      <h3>{evidence.workTitle ?? "未提供作品名称"}</h3><p className={styles.locator}>{evidence.locator ?? "未提供稳定定位"}</p>
      <blockquote>{evidence.text}</blockquote>
      <dl className={styles.sourceDetails}><div><dt>版本</dt><dd>{evidence.edition ?? "未提供"}</dd></div><div><dt>译者</dt><dd>{evidence.translator ?? "未提供"}</dd></div></dl>
      <details className={styles.auditDetails}><summary>查看来源记录</summary><dl><dt>资料版本</dt><dd>{evidence.sourceRevision}</dd><dt>内容校验值</dt><dd>{evidence.contentHash}</dd></dl></details>
    </article>)}</div>
  </dialog>;
}
