import type { ThoughtStagePackage } from "@pchat/contracts";
import styles from "./Workspace.module.css";

export function ParticipantPicker({ roles, selected, disabled = false, onChange }: {
  roles: readonly ThoughtStagePackage[]; selected: readonly string[]; disabled?: boolean; onChange(ids: string[]): void;
}) {
  return <fieldset className={styles.participantPicker} disabled={disabled}>
    <legend>参与人物 <span>选择 1–3 位思想立场</span></legend>
    <div className={styles.people}>
      {roles.map((role) => {
        const included = selected.includes(role.id);
        const unavailable = role.status !== "CONFIRMED" || (!included && selected.length >= 3);
        return <button key={role.id} type="button" aria-pressed={included} disabled={unavailable}
          className={`${styles.person} ${included ? styles.personSelected : ""}`}
          title={role.status === "DRAFT" ? "资料包尚未经过人工确认，暂不能参与讨论" : role.label}
          onClick={() => onChange(included ? selected.filter((id) => id !== role.id) : [...selected, role.id])}>
          <span className={styles.personSeal} aria-hidden="true">{role.label.slice(0, 1)}</span>
          <span>{role.label}<small>{role.status === "CONFIRMED" ? "资料已确认" : "草稿 · 待确认"}</small></span>
          {included && <span className={styles.selectionMark} aria-hidden="true">✓</span>}
        </button>;
      })}
    </div>
    {roles.length === 0 && <p className={styles.muted}>人物资料尚未准备。请先在设置中准备并确认资料包。</p>}
  </fieldset>;
}
