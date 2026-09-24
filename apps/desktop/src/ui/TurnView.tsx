import type { RoleRunProjection, TurnProjection } from "@pchat/contracts";
import type { WorkspaceCommand } from "./workspace-controller";
import { answerLabels, modeLabels, roleLabels } from "./view-model";
import styles from "./Workspace.module.css";

function readableCitations(text: string, role: RoleRunProjection) {
  return role.evidence.reduce((value, evidence, index) => value.split(`[${evidence.id}]`).join(`[${index + 1}]`), text);
}

export function TurnView({ turn, number, disabled, onCommand, onEvidence, onConfigure }: {
  turn: TurnProjection; number: number; disabled: boolean; onCommand(command: WorkspaceCommand): void;
  onEvidence(role: RoleRunProjection): void; onConfigure(): void;
}) {
  const working = turn.status === "RUNNING";
  return <section className={styles.turn} aria-label={`第 ${number} 轮讨论`}>
    <div className={styles.questionHeader}><span className={styles.eyebrow}>问题 {String(number).padStart(2, "0")}</span><span className={styles.modeBadge}>{modeLabels[turn.context.settings.knowledgeMode]}</span></div>
    <h2 className={styles.questionText}>{turn.context.question.text}</h2>
    {turn.discussion?.plan && <p className={styles.muted}>本轮讨论：{turn.discussion.plan.philosophicalQuestion}</p>}
    {turn.discussion?.status === "PLANNING" && <p className={styles.emptyAnswer}>正在整理问题，并从已确认目录中选择人物…</p>}
    {turn.discussion?.status === "RETRIEVING" && <p className={styles.muted}>正在逐位查阅原典，资料齐备后统一组织回答。</p>}
    {turn.discussion?.status === "GENERATING" && <p className={styles.muted}>正在一次生成各人物回答、点评与总结…</p>}
    {turn.discussion?.status === "WAITING_USER" && <div className={styles.recoveryNotice}><strong>本轮已暂停，等待你的决定</strong><p>未完成请求可能已经计费。继续会使用已保存的检索结果，并对未完成步骤发起新请求。</p><button type="button" className={styles.secondaryButton} disabled={disabled} onClick={() => onCommand({ type: "RegenerateDiscussion", turnId: turn.id })}>确认继续本轮（可能再次计费）</button></div>}
    {turn.discussion?.status === "FAILED" && <div className={styles.recoveryNotice}><p>{turn.discussion.errorCode === "INVALID_ROUTE" ? "选人结果未通过校验。请手动选择人物，或缩小问题范围后重新提问。" : turn.discussion.errorCode === "INVALID_PROVIDER_RESULT" ? "生成结果未通过知识模式或引用校验。下方草稿不是有效回答；可以补充资料或调整问题后重新提问。" : turn.discussion.errorCode === "BUDGET_EXCEEDED" ? "已达到本机调用额度上限。" : "本轮未能完成，请检查连接或调整问题后重新提问。"}</p></div>}
    <div className={styles.roleAnswers}>{turn.roleRuns.map((role, index) => {
      const unknown = role.attempts.at(-1)?.status === "OUTCOME_UNKNOWN";
      const text = readableCitations(role.answer?.text ?? role.textSoFar, role);
      const interviewTitles = [...new Set(role.evidence.filter((source) => source.sourceForm === "INTERVIEW" && role.answer?.evidenceIds.includes(source.id)).map((source) => source.workTitle ?? "未提供访谈名称"))];
      return <article className={styles.roleAnswer} key={role.id}>
        <header className={styles.answerHeader}><div className={styles.speaker}><span className={styles.speakerSeal} aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><div><h3>{role.context.participant.label}</h3><span className={styles.answerKind}>{role.answer ? answerLabels[role.answer.kind] : "未完成草稿"}</span></div></div>
          <span className={`${styles.roleStatus} ${role.status === "GENERATING" || role.status === "RETRIEVING" ? styles.inProgress : ""}`}>{roleLabels[role.status]}</span></header>
        {text ? <div className={styles.answerText}>{text}</div> : <p className={styles.emptyAnswer}>{role.status === "PENDING" ? "轮到这位人物时，将从其资料范围开始查阅。" : role.status === "RETRIEVING" ? "正在查阅这位人物的文本资料…" : role.status === "GENERATING" ? "资料已就绪，正在组织回答…" : "尚未形成回答。"}</p>}
        {interviewTitles.length > 0 && <p className={styles.muted}>本回答引用人物访谈发言。访谈来源：{interviewTitles.join("、")}。</p>}
        {role.status === "WAITING_USER" && !turn.discussion && <div className={styles.recoveryNotice}><strong>{unknown ? "这次请求的结果尚不确定" : "本回答已暂停"}</strong><p>{unknown ? "供应商可能已经处理并计费。重新生成会发起一次新请求，可能再次产生费用。" : "你可以明确选择继续生成，或停止本轮讨论。"}</p><button type="button" className={styles.secondaryButton} disabled={disabled} onClick={() => onCommand({ type: "RegenerateRole", roleRunId: role.id })}>确认重新生成此回答</button></div>}
        {role.status === "FAILED" && <div className={styles.recoveryNotice}><p>{role.errorCode === "BUDGET_EXCEEDED" ? "本次运行已达到费用上限。" : role.errorCode === "INVALID_PROVIDER_RESULT" ? "这份草稿未通过校验，不能作为该人物的有效回答。" : "本回答未能完成。可以检查连接与资料设置，再提出新的问题。"}</p>{role.errorCode !== "INVALID_PROVIDER_RESULT" && <button type="button" className={styles.textButton} onClick={onConfigure}>检查连接与资料 →</button>}</div>}
        <footer className={styles.answerFooter}><button type="button" className={styles.evidenceButton} onClick={() => onEvidence(role)} disabled={role.evidence.length === 0}>查看依据 <span>{role.evidence.length}</span></button>{role.answer?.kind === "INSUFFICIENT_EVIDENCE" && <span className={styles.muted}>当前资料不足以支持回答。</span>}</footer>
      </article>;
    })}</div>
    {turn.discussion?.commentary?.text && <section className={styles.roleAnswer}><h3>对你观点的回应</h3><p className={styles.answerText}>{turn.discussion.commentary.text}</p></section>}
    {turn.discussion?.summary?.text && <section className={styles.roleAnswer}><h3>本轮总结</h3><p className={styles.answerText}>{turn.discussion.summary.text}</p></section>}
    {turn.roleRuns.length > 1 && <details className={styles.comparison} open={turn.comparison !== null}><summary>本轮立场对照 <span>仅整理已完成的有效回答</span></summary>
      {turn.comparison ? <div className={styles.comparisonColumns}>{turn.comparison.columns.map((column) => <section key={column.roleRunId}><h4>{column.participantLabel}</h4><span className={styles.answerKind}>{answerLabels[column.answer.kind]}</span><p>{readableCitations(column.answer.text, turn.roleRuns.find((role) => role.id === column.roleRunId)!)}</p></section>)}</div>
        : <p className={styles.muted}>{working ? "至少两份有效回答完成后，可查看本轮对照。" : "本轮有效回答不足两份，未生成立场对照。"}</p>}
      {Boolean(turn.comparison?.excludedRoleRunIds.length) && <p className={styles.muted}>未形成有效回答的人物未列入本次对照。</p>}
    </details>}
  </section>;
}
