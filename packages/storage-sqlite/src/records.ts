import type { DatabaseSync } from "node:sqlite";
import {
  AnswerSchema, CommandReceiptSchema, ContextSnapshotSchema, ConversationSettingsSchema,
  EvidenceSchema, ExternalAttemptSchema, HarnessEventSchema, QuestionStatusSchema,
  RoleStatusSchema, ThoughtStagePackageSchema, TurnStatusSchema,
} from "@pchat/contracts";
import type { RuntimeState } from "@pchat/harness";

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid persisted text");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid persisted number");
  return value;
}
function nullableString(value: unknown): string | null { return value === null ? null : string(value); }
function json(value: unknown): unknown { return JSON.parse(string(value)); }

export function readState(database: DatabaseSync): RuntimeState {
  const meta = database.prepare("SELECT * FROM runtime_meta WHERE singleton = 1").get();
  if (!meta) throw new Error("Missing runtime metadata");
  const state: RuntimeState = {
    epoch: number(meta.epoch), suspended: meta.suspended === 1, lastEventSeq: number(meta.last_event_seq),
    conversations: [], turns: [], commands: [], events: [],
  };
  for (const row of database.prepare("SELECT * FROM conversations ORDER BY ordinal").all()) {
    if (row.queue_status !== "RUNNING" && row.queue_status !== "PAUSED") throw new Error("Invalid queue status");
    state.conversations.push({ id: string(row.id), title: string(row.title),
      settings: ConversationSettingsSchema.parse(json(row.settings_json)), queueStatus: row.queue_status,
      activeTurnId: nullableString(row.active_turn_id), questions: [], turnIds: [] });
  }
  const conversations = new Map(state.conversations.map((conversation) => [conversation.id, conversation]));
  for (const row of database.prepare("SELECT * FROM questions ORDER BY conversation_id, ordinal").all()) {
    const conversation = conversations.get(string(row.conversation_id));
    if (!conversation) throw new Error("Orphan question");
    conversation.questions.push({ id: string(row.id), text: string(row.text), status: QuestionStatusSchema.parse(row.status),
      turnId: nullableString(row.turn_id), submittedAt: number(row.submitted_at),
      settings: ConversationSettingsSchema.parse(json(row.settings_json)), participant: ThoughtStagePackageSchema.parse(json(row.participant_json)) });
  }
  for (const row of database.prepare("SELECT * FROM turns ORDER BY ordinal").all()) {
    state.turns.push({ id: string(row.id), conversationId: string(row.conversation_id), questionId: string(row.question_id),
      status: TurnStatusSchema.parse(row.status), context: ContextSnapshotSchema.parse(json(row.context_json)), roleRuns: [] });
  }
  const turns = new Map(state.turns.map((turn) => [turn.id, turn]));
  for (const row of database.prepare("SELECT id, conversation_id FROM turns ORDER BY conversation_id, conversation_ordinal").all()) {
    const conversation = conversations.get(string(row.conversation_id));
    if (!conversation) throw new Error("Orphan turn");
    conversation.turnIds.push(string(row.id));
  }
  for (const row of database.prepare("SELECT * FROM role_runs ORDER BY turn_id, ordinal").all()) {
    const turn = turns.get(string(row.turn_id));
    if (!turn) throw new Error("Orphan role run");
    turn.roleRuns.push({ id: string(row.id), status: RoleStatusSchema.parse(row.status), textSoFar: string(row.text_so_far),
      revision: number(row.revision), answer: row.answer_json === null ? null : AnswerSchema.parse(json(row.answer_json)),
      errorCode: nullableString(row.error_code), evidence: [], attempts: [] });
  }
  const roles = new Map(state.turns.flatMap((turn) => turn.roleRuns.map((role) => [role.id, role] as const)));
  for (const row of database.prepare("SELECT * FROM external_attempts ORDER BY role_run_id, ordinal").all()) {
    const role = roles.get(string(row.role_run_id));
    if (!role) throw new Error("Orphan attempt");
    role.attempts.push(ExternalAttemptSchema.parse({ id: row.id, kind: row.kind, status: row.status,
      previousAttemptId: row.previous_attempt_id, reservedCostUnits: row.reserved_cost_units, draft: row.draft }));
  }
  for (const row of database.prepare("SELECT * FROM evidence_snapshots ORDER BY role_run_id, ordinal").all()) {
    const role = roles.get(string(row.role_run_id));
    if (!role) throw new Error("Orphan evidence");
    role.evidence.push(EvidenceSchema.parse(json(row.snapshot_json)));
  }
  state.commands = database.prepare("SELECT * FROM command_receipts ORDER BY ordinal").all()
    .map((row) => ({ fingerprint: string(row.fingerprint), receipt: CommandReceiptSchema.parse(json(row.receipt_json)) }));
  state.events = database.prepare("SELECT * FROM event_journal ORDER BY seq").all()
    .map((row) => HarnessEventSchema.parse(json(row.event_json)));
  return state;
}

type Cell = string | number | null;
interface TableRows { name: string; columns: string[]; keys: string[]; rows: Cell[][] }
function table(name: string, columns: string[], keys: string[]): TableRows { return { name, columns, keys, rows: [] }; }

function rowsFor(state: RuntimeState): TableRows[] {
  const meta = table("runtime_meta", ["singleton", "epoch", "suspended", "last_event_seq"], ["singleton"]);
  meta.rows.push([1, state.epoch, Number(state.suspended), state.lastEventSeq]);
  const conversations = table("conversations", ["id", "ordinal", "title", "settings_json", "queue_status", "active_turn_id"], ["id"]);
  const questions = table("questions", ["id", "conversation_id", "ordinal", "text", "status", "turn_id", "submitted_at", "settings_json", "participant_json"], ["id"]);
  const turns = table("turns", ["id", "conversation_id", "question_id", "ordinal", "conversation_ordinal", "status", "context_json"], ["id"]);
  const roles = table("role_runs", ["id", "turn_id", "ordinal", "status", "text_so_far", "revision", "answer_json", "error_code"], ["id"]);
  const attempts = table("external_attempts", ["id", "role_run_id", "ordinal", "kind", "status", "previous_attempt_id", "reserved_cost_units", "draft"], ["id"]);
  const evidence = table("evidence_snapshots", ["role_run_id", "id", "ordinal", "snapshot_json"], ["role_run_id", "id"]);
  const commands = table("command_receipts", ["command_id", "ordinal", "fingerprint", "receipt_json"], ["command_id"]);
  const events = table("event_journal", ["seq", "event_json"], ["seq"]);
  const turnOrder = new Map<string, number>();
  state.conversations.forEach((conversation, ordinal) => {
    conversations.rows.push([conversation.id, ordinal, conversation.title, JSON.stringify(conversation.settings), conversation.queueStatus, conversation.activeTurnId]);
    conversation.turnIds.forEach((id, index) => { turnOrder.set(id, index); });
    conversation.questions.forEach((question, index) => {
      questions.rows.push([question.id, conversation.id, index, question.text, question.status, question.turnId, question.submittedAt,
        JSON.stringify(question.settings), JSON.stringify(question.participant)]);
    });
  });
  state.turns.forEach((turn, ordinal) => {
    const conversationOrdinal = turnOrder.get(turn.id);
    if (conversationOrdinal === undefined) throw new Error("Turn missing from conversation");
    turns.rows.push([turn.id, turn.conversationId, turn.questionId, ordinal, conversationOrdinal, turn.status, JSON.stringify(turn.context)]);
    turn.roleRuns.forEach((role, roleOrdinal) => {
      roles.rows.push([role.id, turn.id, roleOrdinal, role.status, role.textSoFar, role.revision,
        role.answer === null ? null : JSON.stringify(role.answer), role.errorCode]);
      role.attempts.forEach((attempt, index) => {
        attempts.rows.push([attempt.id, role.id, index, attempt.kind, attempt.status, attempt.previousAttemptId, attempt.reservedCostUnits, attempt.draft]);
      });
      role.evidence.forEach((item, index) => { evidence.rows.push([role.id, item.id, index, JSON.stringify(item)]); });
    });
  });
  state.commands.forEach((command, ordinal) => { commands.rows.push([command.receipt.commandId, ordinal, command.fingerprint, JSON.stringify(command.receipt)]); });
  for (const event of state.events) events.rows.push([event.seq, JSON.stringify(event)]);
  return [meta, conversations, questions, turns, roles, attempts, evidence, commands, events];
}

function keyValues(table: TableRows, row: Cell[]): Cell[] {
  return table.keys.map((key) => {
    const value = row[table.columns.indexOf(key)];
    if (value === undefined) throw new Error("Missing persisted row key");
    return value;
  });
}
function indexed(table: TableRows): Map<string, Cell[]> {
  const result = new Map<string, Cell[]>();
  for (const row of table.rows) {
    const key = JSON.stringify(keyValues(table, row));
    if (result.has(key)) throw new Error("Duplicate persisted row key");
    result.set(key, row);
  }
  return result;
}

/** Diff the complete domain snapshots, but write only changed relational rows.
 * Journal entries and immutable context/evidence are normally append-only. */
export function writeState(database: DatabaseSync, previous: RuntimeState, state: RuntimeState): void {
  const before = rowsFor(previous);
  const changes = rowsFor(state).map((table, index) => {
    const oldTable = before[index];
    if (!oldTable) throw new Error("Missing persisted table");
    const oldRows = indexed(oldTable);
    const newRows = indexed(table);
    return { table, oldRows, newRows,
      changed: [...newRows].filter(([key, row]) => JSON.stringify(oldRows.get(key)) !== JSON.stringify(row)),
      removed: [...oldRows].filter(([key]) => !newRows.has(key)),
    };
  });
  database.exec("PRAGMA defer_foreign_keys = ON");
  for (const { table, removed } of [...changes].reverse()) {
    if (removed.length === 0) continue;
    const deletion = database.prepare(`DELETE FROM ${table.name} WHERE ${table.keys.map((key) => `${key} = ?`).join(" AND ")}`);
    for (const [, row] of removed) deletion.run(...keyValues(table, row));
  }
  for (const { table, oldRows, changed } of changes) {
    if (changed.length === 0) continue;
    const predicate = table.keys.map((key) => `${key} = ?`).join(" AND ");
    const ordinalColumns = table.columns.filter((column) => column === "ordinal" || column === "conversation_ordinal");
    if (ordinalColumns.length > 0) {
      // Free ordering slots inside the same transaction before restoring them;
      // this also supports removals/reordering without deleting retained rows.
      const move = database.prepare(`UPDATE ${table.name} SET ${ordinalColumns.map((column) => `${column} = -${column} - 1`).join(", ")} WHERE ${predicate}`);
      for (const [key, row] of changed) if (oldRows.has(key)) move.run(...keyValues(table, row));
    }
    const updates = table.columns.filter((column) => !table.keys.includes(column)).map((column) => `${column} = excluded.${column}`).join(", ");
    const upsert = database.prepare(`INSERT INTO ${table.name} (${table.columns.join(", ")}) VALUES (${table.columns.map(() => "?").join(", ")}) ON CONFLICT (${table.keys.join(", ")}) DO UPDATE SET ${updates}`);
    for (const [, row] of changed) upsert.run(...row);
  }
}
