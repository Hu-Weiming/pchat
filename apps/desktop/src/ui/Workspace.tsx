import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { RoleRunProjection } from "@pchat/contracts";
import { createWorkspaceController } from "./workspace-controller";
import { connectionReadiness, modeLabels } from "./view-model";
import { NewConversation } from "./NewConversation";
import { ParticipantPicker } from "./ParticipantPicker";
import { TurnView } from "./TurnView";
import { EvidenceDrawer } from "./EvidenceDrawer";
import type { WorkspaceProps } from "./types";
import styles from "./Workspace.module.css";
export type { WorkspaceProps, ModelOption, RagOption } from "./types";

export function Workspace({ client, modelOptions, ragOptions, onConfigureConnections }: WorkspaceProps) {
  const controller = useMemo(() => createWorkspaceController(client, () => crypto.randomUUID()), [client]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<RoleRunProjection | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  useEffect(() => { void controller.start(); return () => { controller.stop(); }; }, [controller]);
  useEffect(() => { nearBottom.current = true; }, [state.selectedConversationId]);
  useEffect(() => { if (nearBottom.current && scroll.current) scroll.current.scrollTo({ top: scroll.current.scrollHeight }); }, [state.turns]);
  const selected = state.conversations.find((conversation) => conversation.id === state.selectedConversationId);
  const activeTurn = state.turns.find((turn) => turn.id === selected?.activeTurnId);
  const pending = selected?.questions.filter((question) => question.status === "QUEUED") ?? [];
  const withdrawn = selected?.questions.filter((question) => question.status === "WITHDRAWN") ?? [];
  const blocked = state.busy || state.pendingCommand !== null || state.status !== "ready";
  const readiness = selected ? connectionReadiness(selected.settings, state.roles, modelOptions, ragOptions) : { ready: false, message: "" };
  const draft = selected ? drafts[selected.id] ?? "" : "";
  const choose = (id: string | null) => { controller.selectConversation(id); setSidebarOpen(false); setEvidence(null); };
  const clearSentDraft = (id: string, text: string) => setDrafts((current) => current[id] === text ? { ...current, [id]: "" } : current);
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!selected || blocked || !readiness.ready || !draft.trim()) return;
    const receipt = await controller.execute({ type: "SubmitQuestion", conversationId: selected.id, text: draft.trim() });
    if (receipt?.ok) clearSentDraft(selected.id, draft);
  }
  async function retry() {
    const command = state.pendingCommand;
    const receipt = await controller.retryPending();
    if (receipt?.ok && command?.type === "SubmitQuestion") {
      setDrafts((current) => current[command.conversationId]?.trim() === command.text ? { ...current, [command.conversationId]: "" } : current);
    }
  }
  return <div className={styles.workspace}>
    {sidebarOpen && <button className={styles.sidebarBackdrop} aria-label="收起会话列表" onClick={() => setSidebarOpen(false)} />}
    <aside className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarShown : ""}`} aria-label="会话导航">
      <div className={styles.brand}><span className={styles.brandSeal} aria-hidden="true">思</span><div><strong>Pchat</strong><span>思想之间</span></div><button type="button" className={`${styles.iconButton} ${styles.mobileOnly}`} aria-label="收起会话列表" onClick={() => setSidebarOpen(false)}>×</button></div>
      <div className={styles.sidebarTools}><button type="button" className={styles.newButton} onClick={() => choose(null)}><span aria-hidden="true">＋</span> 新的讨论</button><label className={styles.search}><span className={styles.srOnly}>搜索会话</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="查找会话…" /></label></div>
      <div className={styles.archiveHeading}>会话档案 <span>{state.conversations.length}</span></div>
      <nav className={styles.conversationList}>{[...state.conversations].reverse().filter((conversation) => conversation.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((conversation) => <button key={conversation.id} type="button" aria-current={selected?.id === conversation.id ? "page" : undefined} className={selected?.id === conversation.id ? styles.conversationSelected : ""} onClick={() => choose(conversation.id)}>
        <span className={styles.conversationTitle}>{conversation.title}</span><span className={styles.conversationMeta}>{modeLabels[conversation.settings.knowledgeMode]} · {conversation.questions.length} 个问题{conversation.queueStatus === "PAUSED" && <span className={styles.pausedDot}>已暂停</span>}</span>
      </button>)}{state.conversations.length === 0 && <p className={styles.archiveEmpty}>{state.status === "loading" ? "正在读取会话…" : "从新的讨论开始，历史会保存在这里。"}</p>}</nav>
      <footer className={styles.sidebarFooter}><button type="button" onClick={onConfigureConnections}>连接与资料设置 <span aria-hidden="true">↗</span></button><span>哲学研讨工坊</span></footer>
    </aside>
    <main className={styles.main}>
      <header className={styles.topbar}><div className={styles.topbarTitle}><button type="button" className={`${styles.iconButton} ${styles.mobileOnly}`} aria-label="展开会话列表" onClick={() => setSidebarOpen(true)}>☰</button><span>{selected ? "会话档案" : "研讨工坊"}</span>{selected && <><i aria-hidden="true">/</i><strong>{selected.title}</strong></>}</div>
        <div className={styles.connectionStatus}><span className={state.status === "ready" ? styles.readyDot : styles.offlineDot} />{state.status === "ready" ? "对话已同步" : state.status === "loading" ? "正在连接" : "连接中断"}{state.status === "offline" && <button type="button" className={styles.textButton} onClick={() => { void controller.start(); }}>重新连接</button>}</div></header>
      {(state.error || state.pendingCommand) && <div className={styles.errorBanner} role="status"><span>{state.error ?? (state.busy ? "正在保存这次操作…" : "上次操作回执尚未确认。")}</span>{state.pendingCommand && !state.busy && <button type="button" className={styles.secondaryButton} onClick={() => { void retry(); }}>重查这次操作结果</button>}</div>}
      {!selected ? <div className={styles.newScroller}><NewConversation roles={state.roles} models={modelOptions} retrieval={ragOptions} disabled={blocked} onConfigure={onConfigureConnections} onCreate={async (title, settings) => { await controller.execute({ type: "CreateConversation", title, settings }); }} /></div> : <>
        <div className={styles.sessionHeader}><div><span className={styles.eyebrow}>正在讨论</span><h1>{selected.title}</h1></div><span className={styles.modeBadge}>{modeLabels[selected.settings.knowledgeMode]}模式</span></div>
        <details className={styles.sessionParticipants}><summary>参与人物 <span>{selected.settings.participantIds.map((id) => state.roles.find((role) => role.id === id)?.label ?? "资料包不可用").join(" / ")}</span></summary><ParticipantPicker roles={state.roles} selected={selected.settings.participantIds} disabled={blocked} onChange={(ids) => { if (ids.length > 0) void controller.execute({ type: "ChangeParticipants", conversationId: selected.id, participantIds: ids }); }} /><p className={styles.muted}>修改仅影响之后提交的问题；已开始和已排队的问题保留原人物。</p></details>
        <div className={styles.readingPane} ref={scroll} onScroll={() => { if (scroll.current) nearBottom.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 100; }}>
          <div className={styles.readingColumn}>{state.turns.length === 0 && <div className={styles.emptyDiscussion}><span className={styles.emptySeal} aria-hidden="true">问</span><h2>把你真正困惑的事写下来。</h2><p>可以是一个概念、一处矛盾，或一种尚未说清的直觉。</p></div>}
          {state.turns.map((turn, index) => <TurnView key={turn.id} turn={turn} number={index + 1} disabled={blocked} onCommand={(command) => { void controller.execute(command); }} onEvidence={setEvidence} onConfigure={onConfigureConnections} />)}
          {withdrawn.length > 0 && <details className={styles.withdrawn}><summary>已撤回 {withdrawn.length} 个待处理问题</summary>{withdrawn.map((question) => <p key={question.id}>{question.text}</p>)}</details>}</div>
        </div>
        <div className={styles.composerArea}>
          {(pending.length > 0 || selected.queueStatus === "PAUSED") && <section className={styles.queue} aria-label="待处理问题"><header><strong>{selected.queueStatus === "PAUSED" ? "队列已暂停" : "待处理问题"}<span>{pending.length}</span></strong>{selected.queueStatus === "PAUSED" && <button type="button" className={styles.textButton} disabled={blocked || activeTurn?.status === "WAITING_USER"} onClick={() => { void controller.execute({ type: "ResumeQueue", conversationId: selected.id }); }}>恢复队列 →</button>}</header>
            {activeTurn?.status === "WAITING_USER" && <p>请先处理本轮等待确认的回答，或停止本轮，再恢复队列。</p>}
            <ol>{pending.map((question) => <li key={question.id}><span>{question.text}</span><button type="button" disabled={blocked} onClick={() => { void controller.execute({ type: "WithdrawQuestion", questionId: question.id }); }} aria-label={`撤回问题：${question.text}`}>撤回</button></li>)}</ol>
          </section>}
          {!readiness.ready && <div className={styles.configurationPrompt}><span>{readiness.message}</span><button type="button" className={styles.textButton} onClick={onConfigureConnections}>去配置 →</button></div>}
          <form className={styles.composer} onSubmit={(event) => { void submit(event); }}><label className={styles.srOnly} htmlFor="question-composer">你的问题</label><textarea id="question-composer" rows={3} maxLength={32000} value={draft} placeholder="写下你的问题。回答期间仍可继续发送。" onChange={(event) => { const value = event.target.value; setDrafts((current) => ({ ...current, [selected.id]: value })); }} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void submit(); } }} />
            <footer><span>Ctrl + Enter 发送 · 按提交顺序逐轮处理</span><div>{activeTurn && (activeTurn.status === "RUNNING" || activeTurn.status === "WAITING_USER") && <button type="button" className={styles.stopButton} disabled={blocked} onClick={() => { void controller.execute({ type: "StopTurn", turnId: activeTurn.id }); }}><span aria-hidden="true">■</span> 停止本轮</button>}<button type="submit" className={styles.primaryButton} disabled={blocked || !readiness.ready || !draft.trim()}>{state.busy ? "保存中…" : "发送"} <span aria-hidden="true">↑</span></button></div></footer>
          </form><p className={styles.composerHint}>回答是受资料约束的思想立场重构。请结合依据阅读与判断。</p>
        </div>
      </>}
    </main>
    {evidence && <EvidenceDrawer role={evidence} onClose={() => setEvidence(null)} />}
  </div>;
}
