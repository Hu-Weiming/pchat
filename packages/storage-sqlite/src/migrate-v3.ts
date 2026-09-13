import type { DatabaseSync } from "node:sqlite";
import {
  ContextSnapshotSchema, ConversationSettingsSchema, HarnessCommandSchema,
  ThoughtStagePackageSchema, TurnContextSnapshotSchema,
} from "@pchat/contracts";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid legacy snapshot object");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid legacy snapshot text");
  return value;
}
function json(value: unknown): unknown { return JSON.parse(text(value)); }
function settings(value: unknown) {
  const source = record(value);
  if (!("participantId" in source) || "participantIds" in source) throw new Error("Invalid legacy participant setting");
  const { participantId, ...other } = source;
  return ConversationSettingsSchema.parse({ ...other, participantIds: [participantId] });
}

/** v1/v2 stored one participant and shared the only role's context with its turn.
 * The migration preserves payloads; it does not regenerate answers or events. */
export function migrateToVersionThree(database: DatabaseSync): void {
  database.exec(`ALTER TABLE questions RENAME COLUMN participant_json TO participants_json;
    ALTER TABLE turns ADD COLUMN comparison_json TEXT;
    CREATE TABLE role_contexts(role_run_id TEXT PRIMARY KEY REFERENCES role_runs(id), context_json TEXT NOT NULL) STRICT;`);
  const updateConversation = database.prepare("UPDATE conversations SET settings_json = ? WHERE id = ?");
  for (const row of database.prepare("SELECT id, settings_json FROM conversations").all()) {
    updateConversation.run(JSON.stringify(settings(json(row.settings_json))), text(row.id));
  }
  const updateQuestion = database.prepare("UPDATE questions SET settings_json = ?, participants_json = ? WHERE id = ?");
  for (const row of database.prepare("SELECT id, settings_json, participants_json FROM questions").all()) {
    const participant = ThoughtStagePackageSchema.parse(json(row.participants_json));
    updateQuestion.run(JSON.stringify(settings(json(row.settings_json))), JSON.stringify([participant]), text(row.id));
  }
  const updateTurn = database.prepare("UPDATE turns SET context_json = ?, comparison_json = NULL WHERE id = ?");
  const updateRole = database.prepare("INSERT INTO role_contexts(role_run_id, context_json) SELECT id, ? FROM role_runs WHERE turn_id = ?");
  const roleCount = database.prepare("SELECT count(*) AS count FROM role_runs WHERE turn_id = ?");
  for (const row of database.prepare("SELECT id, context_json FROM turns").all()) {
    const source = record(json(row.context_json));
    const roleContext = ContextSnapshotSchema.parse({ ...source, settings: settings(source.settings) });
    if (roleCount.get(text(row.id))?.count !== 1) throw new Error("Legacy turn must contain exactly one role");
    const turnContext = TurnContextSnapshotSchema.parse({ question: roleContext.question, settings: roleContext.settings,
      participants: [roleContext.participant], history: roleContext.history });
    updateTurn.run(JSON.stringify(turnContext), text(row.id));
    updateRole.run(JSON.stringify(roleContext), text(row.id));
  }
  const updateCommand = database.prepare("UPDATE command_receipts SET fingerprint = ? WHERE command_id = ?");
  for (const row of database.prepare("SELECT command_id, fingerprint FROM command_receipts").all()) {
    let source = record(json(row.fingerprint));
    if (source.type === "CreateConversation") source = { ...source, settings: settings(source.settings) };
    else if (source.type === "ChangeParticipants") {
      if (!("participantId" in source) || "participantIds" in source) throw new Error("Invalid legacy participant command");
      const { participantId, ...other } = source;
      source = { ...other, participantIds: [participantId] };
    }
    // The same parser as dispatch establishes property ordering as well as
    // validation. Keep every original receipt, including rejected commands.
    const command = HarnessCommandSchema.parse(source);
    if (command.commandId !== row.command_id) throw new Error("Legacy command identity mismatch");
    updateCommand.run(JSON.stringify(command), text(row.command_id));
  }
}
