import type { RoleRunProjection, TurnProjection } from "@pchat/contracts";
import type { WorkspaceCommand } from "./workspace-controller";
import { answerLabels, modeLabels, roleLabels } from "./view-model";
import styles from "./Workspace.module.css";

export function TurnView({ turn, number, disabled, onCommand, onEvidence, onConfigure }: {
  turn: TurnProjection; number: number; disabled: boolean; onCommand(command: WorkspaceCommand): void;
  onEvidence(role: RoleRunProjection): void; onConfigure(): void;
}) {
  const working = turn.status === "RUNNING";
  return <section className={styles.turn} aria-label={`第 ${number} 轮讨论`}>
    <div className={styles.questionHeader}><span className={styles.eyebrow}>问题 {String(number).padStart(2, "0")}</span><span className={styles.modeBadge}>{modeLabels[turn.context.settings.knowledgeMode]}</span></div>
    <h2 className={styles.questionText}>{turn.context.question.text}</h2>
    <div className={styles.roleAnswers}>{turn.roleRuns.map((role, index) => {
      const unknown = role.attempts.at(-1)?.status === "OUTCOME_UNKNOWN";
      const text = role.answer?.text ?? role.textSoFar;
      return <article className={styles.roleAnswer} key={role.id}>
        <header className={styles.answerHeader}><div className={styles.speaker}><span className={styles.speakerSeal} aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><div><h3>{role.context.participant.label}</h3><span className={styles.answerKind}>{role.answer ? answerLabels[role.answer.kind] : "未完成草稿"}</span></div></div>
          <span className={`${styles.roleStatus} ${role.status === "GENERATING" || role.status === "RETRIEVING" ? styles.inProgress : ""}`}>{roleLabels[role.status]}</span></header>
        {text ? <div className={styles.answerText}>{text}</div> : <p className={styles.emptyAnswer}>{role.status === "PENDING" ? "轮到这位人物时，将从其资料范围开始查阅。" : role.status === "RETRIEVING" ? "正在查阅这位人物的文本资料…" : role.status === "GENERATING" ? "资料已就绪，正在组织回答…" : "尚未形成回答。"}</p>}
        {role.status === "WAITING_USER" && <div className={styles.recoveryNotice}><strong>{unknown ? "这次请求的结果尚不确定" : "本回答已暂停"}</strong><p>{unknown ? "供应商可能已经处理并计费。重新生成会发起一次新请求，可能再次产生费用。" : "你可以明确选择继续生成，或停止本轮讨论。"}</p><button type="button" className={styles.secondaryButton} disabled={disabled} onClick={() => onCommand({ type: "RegenerateRole", roleRunId: role.id })}>确认重新生成此回答</button></div>}
        {role.status === "FAILED" && <div className={styles.recoveryNotice}><p>{role.errorCode === "BUDGET_EXCEEDED" ? "本次运行已达到费用上限。" : "本回答未能完成。可以检查连接与资料设置，再提出新的问题。"}</p><button type="button" className={styles.textButton} onClick={onConfigure}>检查连接与资料 →</button></div>}
        <footer className={styles.answerFooter}><button type="button" className={styles.evidenceButton} onClick={() => onEvidence(role)} disabled={role.evidence.length === 0}>查看依据 <span>{role.evidence.length}</span></button>{role.answer?.kind === "INSUFFICIENT_EVIDENCE" && <span className={styles.muted}>当前资料不足以支持回答。</span>}</footer>
      </article>;
    })}</div>
    {turn.roleRuns.length > 1 && <details className={styles.comparison} open={turn.comparison !== null}><summary>本轮立场对照 <span>仅整理已完成的有效回答</span></summary>
      {turn.comparison ? <div className={styles.comparisonColumns}>{turn.comparison.columns.map((column) => <section key={column.roleRunId}><h4>{column.participantLabel}</h4><span className={styles.answerKind}>{answerLabels[column.answer.kind]}</span><p>{column.answer.text}</p></section>)}</div>
        : <p className={styles.muted}>{working ? "至少两份有效回答完成后，可查看本轮对照。" : "本轮有效回答不足两份，未生成立场对照。"}</p>}
      {Boolean(turn.comparison?.excludedRoleRunIds.length) && <p className={styles.muted}>未形成有效回答的人物未列入本次对照。</p>}
    </details>}
  </section>;
}
